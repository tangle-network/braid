import type { RunAdmissionReceipt } from '../domain/receipts.js'
import type { BraidState } from '../domain/state.js'
import type { IdSource } from '../ports/ids.js'
import type { AdmissionRegistration } from './application-lifecycle.js'
import type { SendReceipt } from './application-types.js'
import { AppError } from './errors.js'
import { pendingAdmissionReceipt } from './run-admission.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'

export interface DurableSendInput {
  readonly input: RunExecutionSnapshot
  readonly state: BraidState
  readonly currentState: () => BraidState
  readonly ids: IdSource
  readonly restartReconciliation: Promise<void>
  readonly transitionTail: Promise<void>
  readonly admitPersistedSend: (operationId: string, digest: string) => SendReceipt | undefined
  readonly requestDigest: (state: BraidState, input: RunExecutionSnapshot) => string
  readonly registerAdmission: (runId: string) => AdmissionRegistration
  readonly sendAsync: (
    input: RunExecutionSnapshot,
    ids: { readonly runId: string; readonly turnId: string },
    signal: AbortSignal,
  ) => Promise<SendReceipt>
}

export interface DurableSendRuntime {
  readonly currentState: () => BraidState
  readonly ids: IdSource
  readonly restartReconciliation: Promise<void>
  readonly transitionTail: () => Promise<void>
  readonly admitPersistedSend: (operationId: string, digest: string) => SendReceipt | undefined
  readonly requestDigest: DurableSendInput['requestDigest']
  readonly registerAdmission: DurableSendInput['registerAdmission']
  readonly sendAsync: DurableSendInput['sendAsync']
}

export function createDurableSender(
  runtime: DurableSendRuntime,
): (input: RunExecutionSnapshot) => SendReceipt {
  let pending:
    | {
        readonly operationId: string
        readonly digest: string
        readonly receipt: SendReceipt
      }
    | undefined

  return (input) => {
    const state = runtime.currentState()
    const digest = runtime.requestDigest(state, input)
    const persisted = runtime.admitPersistedSend(input.operationId, digest)
    if (persisted) return persisted
    if (pending) {
      if (pending.operationId !== input.operationId)
        throw new AppError(
          'RUN_ACTIVE',
          `Run ${pending.receipt.runId} is awaiting admission; queue the next input explicitly`,
        )
      if (pending.digest !== digest)
        throw new AppError(
          'OPERATION_CONFLICT',
          `Operation ${input.operationId} was already used with different input`,
        )
      return replayPendingReceipt(pending.receipt)
    }

    const receipt = durableSend({
      input,
      state,
      currentState: runtime.currentState,
      ids: runtime.ids,
      restartReconciliation: runtime.restartReconciliation,
      transitionTail: runtime.transitionTail(),
      admitPersistedSend: runtime.admitPersistedSend,
      requestDigest: runtime.requestDigest,
      registerAdmission: runtime.registerAdmission,
      sendAsync: runtime.sendAsync,
    })
    const reservation = { operationId: input.operationId, digest, receipt }
    pending = reservation
    const clear = () => {
      if (pending === reservation) pending = undefined
    }
    receipt.admissionReady?.then(clear, clear)
    return receipt
  }
}

export function durableSend(input: DurableSendInput): SendReceipt {
  const state = input.state
  const digest = input.requestDigest(state, input.input)
  const replay = input.admitPersistedSend(input.input.operationId, digest)
  if (replay) return replay
  if (state.activeRunId)
    throw new AppError(
      'RUN_ACTIVE',
      `Run ${state.activeRunId} is still active; queue the next input explicitly`,
    )
  const runId = input.ids.next('run')
  const turnId = input.ids.next('turn')
  const registration = input.registerAdmission(runId)
  const pending = pendingAdmissionReceipt(input.input, runId, turnId)
  let admission: RunAdmissionReceipt = pending
  const admissionTask = input.restartReconciliation
    .then(() => input.transitionTail)
    .then(() => assertAdmissionActive(registration.signal))
    .then(() => input.sendAsync(input.input, { runId, turnId }, registration.signal))
    .then((result) => {
      assertAdmissionActive(registration.signal)
      admission = result.admission
      return result
    })
    .catch((error: unknown) => {
      admission = {
        ...pending,
        admissionStatus: 'unavailable',
      }
      throw error
    })
    .finally(() => {
      registration.release()
    })
  const task = admissionTask.then((result) => result.completion)
  task.catch(() => undefined)
  return {
    operationId: input.input.operationId,
    runId,
    revision: state.revision,
    replayed: false,
    get admission() {
      return admission
    },
    admissionReady: admissionTask.then(() => undefined),
    completion: task.then(() => structuredClone(input.currentState())),
  }
}

function assertAdmissionActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new AppError('APPLICATION_CLOSING', 'Braid is closing and cannot materialize a run')
}

function replayPendingReceipt(receipt: SendReceipt): SendReceipt {
  return {
    operationId: receipt.operationId,
    runId: receipt.runId,
    revision: receipt.revision,
    replayed: true,
    get admission() {
      return receipt.admission
    },
    ...(receipt.admissionReady === undefined ? {} : { admissionReady: receipt.admissionReady }),
    completion: receipt.completion,
  }
}
