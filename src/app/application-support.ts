import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import { providerEventKey } from '../domain/events.js'
import type { RunAdmissionReceipt } from '../domain/receipts.js'
import { redactBraidEvent } from '../domain/redaction.js'
import { reduceEvent } from '../domain/reducer.js'
import { usageSnapshotForRun } from '../domain/run-usage.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { EffectStoragePort } from '../ports/effect-storage.js'
import type { ControlAcknowledgement } from '../ports/execution.js'
import type {
  ExecutionRunPort,
  JournalWriter,
  RestartPort,
  StateReader,
} from './application-ports.js'
import type { AppSubscriber, SendReceipt } from './application-types.js'
import type { EffectDispatchResult, SerializedEffectCoordinator } from './effect-coordinator.js'
import { AppError } from './errors.js'
import {
  cancelRequestDigest,
  DEFAULT_CANCEL_REASON,
  shutdownRequestDigest,
} from './operation-ledger.js'
import { safeProviderDiagnostic } from './provider-values.js'
import { RUN_EFFECT_KIND, runEffectRequest } from './run-admission.js'
import { executeRun } from './run-execution.js'
import type { RunExecutionSnapshot } from './run-execution-snapshot.js'
import type { RunLedger } from './run-ledger.js'

export interface ApplicationJournal {
  readonly all: () => readonly BraidEventEnvelope[]
  readonly replay?: () => readonly BraidEventEnvelope[]
  readonly initialState?: () => BraidState | undefined
  readonly append: (
    envelope: BraidEventEnvelope,
  ) =>
    | undefined
    | { readonly appended?: boolean }
    | Promise<{ readonly appended?: boolean } | undefined>
  readonly appendWithState?: (
    envelope: BraidEventEnvelope,
    state: BraidState,
  ) => Promise<{ readonly appended?: boolean } | undefined>
  readonly asynchronous?: boolean
  readonly envelope?: (state: BraidState, event: BraidEvent) => BraidEventEnvelope
  readonly flush?: () => Promise<void>
  readonly close?: () => Promise<void>
}

export function startApplicationRun(input: {
  readonly effects: SerializedEffectCoordinator
  readonly journal: ApplicationJournal
  readonly context: ExecutionRunPort
  readonly runInput: RunExecutionSnapshot
  readonly admission: RunAdmissionReceipt
  readonly abort: AbortController
  readonly requestDigest: string
}): Promise<EffectDispatchResult> {
  const request = runEffectRequest(input.runInput)
  const handle = input.effects.start(
    {
      operationId: input.runInput.operationId,
      effectKind: RUN_EFFECT_KIND,
      request,
      requestDigest: input.requestDigest,
      serializationKey: `run:${input.admission.runId}:execution`,
      signal: input.abort.signal,
      metadata: { runId: input.admission.runId },
    },
    {
      dispatch: async () => {
        await input.context.flush()
        await executeRun(input.context, input.runInput, input.admission, input.abort)
        return runOutcome(input.context, input.admission.runId)
      },
    },
  )
  return handle.completion.then(async (record) => {
    try {
      await input.context.flush()
    } catch (error) {
      if (input.context.storageFailure?.() === undefined) throw error
      return { status: 'unknown' as const, detail: 'RUN_DURABILITY_UNKNOWN' }
    }
    return {
      status:
        record.status === 'pending' || record.status === 'conflict' ? 'unknown' : record.status,
      ...(record.detail === undefined ? {} : { detail: record.detail }),
    }
  })
}

function runOutcome(context: StateReader, runId: string): EffectDispatchResult {
  const run = context.currentState().runs.find((candidate) => candidate.id === runId)
  if (!run) return { status: 'unknown', detail: 'RUN_STATE_MISSING' }
  if (run.status === 'completed') return { status: 'terminal', detail: 'completed' }
  if (run.status === 'unknown') return { status: 'unknown', detail: run.error ?? 'unknown' }
  if (run.status === 'failed') return { status: 'failed', detail: 'failed' }
  if (run.status === 'aborted' || run.status === 'cancelled')
    return { status: 'failed', detail: run.status }
  return { status: 'unknown', detail: 'RUN_NOT_TERMINAL' }
}

export interface RestoreOperationsTarget {
  readonly state: () => BraidState
  readonly ledger: RunLedger
}

export function restoreApplicationOperations(
  events: readonly BraidEventEnvelope[],
  target: RestoreOperationsTarget,
): void {
  const acknowledgements = new Map<string, ControlAcknowledgement>()
  for (const envelope of events) {
    const event = envelope.event
    if (event.kind === 'run.requested' && event.receipt) {
      const run = target.state().runs.find((candidate) => candidate.id === event.runId)
      if (run) {
        target.ledger.setOperation({
          digest:
            event.requestDigest ??
            canonicalDigest({
              command: 'send',
              conversationId: event.receipt.conversationId,
              branchId: event.receipt.branchId,
              text: event.text,
              profile: event.receipt.requested.profile,
              connectionId: event.receipt.requested.connectionId ?? null,
            }),
          runId: run.id,
          admission: event.receipt,
          completion: Promise.resolve(),
        })
        if (!isTerminalStatus(run.status)) target.ledger.setAbort(run.id, new AbortController())
      }
    } else if (event.kind === 'run.cancel.requested') {
      const restoredRun = target.state().runs.find((run) => run.id === event.runId)
      target.ledger.setControl(event.operationId, {
        digest: cancelRequestDigest(
          event.runId,
          event.reason ?? DEFAULT_CANCEL_REASON,
          restoredRun?.providerSessionId,
        ),
        runId: event.runId,
        control: 'cancel',
        acknowledgement: Promise.resolve({
          operationId: event.operationId,
          outcome: 'unknown',
          detail: 'Cancellation was requested before the provider acknowledged it',
        }),
        completion: Promise.resolve(target.state()),
        ...(restoredRun?.providerSessionId === undefined
          ? {}
          : { providerSessionId: restoredRun.providerSessionId }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      })
    } else if (event.kind === 'run.control.requested') {
      const restoredRun = target.state().runs.find((run) => run.id === event.runId)
      const digest =
        event.control === 'cancel'
          ? cancelRequestDigest(
              event.runId,
              event.reason ?? DEFAULT_CANCEL_REASON,
              restoredRun?.providerSessionId,
            )
          : event.digest
      target.ledger.setControl(event.operationId, {
        digest,
        runId: event.runId,
        control: event.control,
        acknowledgement: Promise.resolve({
          operationId: event.operationId,
          outcome: 'unknown',
          detail: 'Control acknowledgement requires provider reconciliation',
        }),
        completion: Promise.resolve(target.state()),
        ...(restoredRun?.providerSessionId === undefined
          ? {}
          : { providerSessionId: restoredRun.providerSessionId }),
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.text === undefined ? {} : { text: event.text }),
      })
    } else if (event.kind === 'application.shutdown.requested') {
      target.ledger.setShutdown(event.operationId, {
        digest: shutdownRequestDigest(),
        completion: Promise.resolve(target.state()),
      })
    } else if (event.kind === 'run.control.acknowledged') {
      acknowledgements.set(event.operationId, {
        operationId: event.operationId,
        outcome: event.outcome,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      })
    }
  }
  for (const [operationId, acknowledgement] of acknowledgements) {
    const record = target.ledger.getControl(operationId)
    if (record) {
      target.ledger.setControl(operationId, {
        ...record,
        acknowledgement: Promise.resolve(acknowledgement),
      })
    }
  }
}

export function reconcileRestartRun(context: RestartPort): Promise<void> {
  const runId = context.currentState().activeRunId
  if (!runId) return Promise.resolve()
  const run = context.currentState().runs.find((candidate) => candidate.id === runId)
  if (!run || isProvenTerminalStatus(run.status)) return Promise.resolve()
  if (!context.execution.status) {
    const unknown = context.commitAndWait({
      kind: 'run.finished',
      runId,
      status: 'unknown',
      finalText: '',
      usage: usageSnapshotForRun(run),
      error: 'The execution path cannot reconcile provider state after restart',
    })
    return Promise.resolve(unknown)
  }
  return reconcileRestartSnapshot(context, runId)
}

async function reconcileRestartSnapshot(context: RestartPort, runId: string): Promise<void> {
  const status = context.execution.status
  if (!status) return
  let snapshot: Awaited<ReturnType<NonNullable<typeof context.execution.status>>>
  try {
    snapshot = await status({ runId })
  } catch {
    await commitRequired(context, {
      kind: 'run.reconnecting',
      runId,
      ...(context.findRun(runId).lastCursor === undefined
        ? {}
        : { after: context.findRun(runId).lastCursor }),
    })
    await commitRequired(context, {
      kind: 'run.unknown',
      runId,
      detail: 'Provider reconciliation failed after restart',
    })
    return
  }
  const current = context.findRun(runId)
  if (
    !snapshot ||
    snapshot.runId !== runId ||
    (current.providerSessionId !== undefined && snapshot.sessionId !== current.providerSessionId)
  ) {
    await commitRequired(context, {
      kind: 'run.reconnecting',
      runId,
      ...(current.lastCursor === undefined ? {} : { after: current.lastCursor }),
    })
    await commitRequired(context, {
      kind: 'run.unknown',
      runId,
      detail: 'Provider reconciliation returned no matching run identity',
    })
    return
  }
  await commitRequired(context, {
    kind: 'run.reconnecting',
    runId,
    ...(current.lastCursor === undefined ? {} : { after: current.lastCursor }),
  })
  await reconcileSnapshot(context, runId, snapshot)
}

async function reconcileSnapshot(
  context: RestartPort,
  runId: string,
  snapshot: NonNullable<Awaited<ReturnType<NonNullable<typeof context.execution.status>>>>,
): Promise<void> {
  const current = context.currentState().runs.find((candidate) => candidate.id === runId)
  if (!current) return
  const evidence = canonicalDigest({
    runId,
    sessionId: snapshot.sessionId ?? null,
    cursor: snapshot.cursor ?? null,
    status: snapshot.status,
    detail: snapshot.detail ?? null,
  })
  await commitRequired(context, {
    kind: 'run.reconciled',
    runId,
    status: snapshot.status,
    from: current.status,
    to: snapshot.status,
    evidence,
    ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail }),
  })
  if (isTerminalStatus(snapshot.status)) {
    await commitRequired(context, {
      kind: 'run.finished',
      runId,
      status: snapshot.status,
      finalText: snapshot.finalText ?? '',
      usage: snapshot.usage ?? usageSnapshotForRun(current),
      ...(snapshot.error === undefined
        ? {}
        : { error: safeProviderDiagnostic(snapshot.error, 'RUNTIME_RECONCILIATION_ERROR') }),
      ...(snapshot.detail === undefined
        ? {}
        : { reason: safeProviderDiagnostic(snapshot.detail, 'RUNTIME_RECONCILIATION_STATUS') }),
    })
  }
}

async function commitRequired(context: JournalWriter, event: BraidEvent): Promise<void> {
  const result = context.commitAndWait(event)
  if (result !== undefined) await result
}

export function admitPersistedSend(input: {
  readonly effects: SerializedEffectCoordinator
  readonly operations: Pick<RunLedger, 'getOperation'>
  readonly state: () => BraidState
  readonly operationId: string
  readonly digest: string
}): SendReceipt | undefined {
  const state = input.state()
  const persisted = input.effects.current(input.operationId)
  if (persisted && persisted.requestDigest !== input.digest) {
    input.effects.start(
      {
        operationId: input.operationId,
        effectKind: 'run.execute',
        request: { digest: input.digest },
      },
      { dispatch: async () => ({ status: 'failed', detail: 'OPERATION_CONFLICT' }) },
    )
    throw new AppError(
      'OPERATION_CONFLICT',
      `Operation ${input.operationId} was already used with different input`,
    )
  }
  if (persisted && (persisted.status === 'pending' || persisted.status === 'conflict')) {
    throw new AppError(
      'OPERATION_REQUIRES_RECONCILIATION',
      `Operation ${input.operationId} needs provider reconciliation before it can be retried`,
    )
  }
  const previous = input.operations.getOperation(input.operationId)
  if (previous) {
    if (previous.digest !== input.digest)
      throw new AppError(
        'OPERATION_CONFLICT',
        `Operation ${input.operationId} was already used with different input`,
      )
    return {
      operationId: input.operationId,
      runId: previous.runId,
      revision: state.revision,
      replayed: true,
      admission: previous.admission,
      completion: previous.completion.then(() => input.state()),
    }
  }
  const persistedRun = state.runs.find((run) => run.operationId === input.operationId)
  if (persisted && persistedRun) {
    return {
      operationId: input.operationId,
      runId: persistedRun.id,
      revision: state.revision,
      replayed: true,
      admission: persistedRun.receipt,
      completion: Promise.resolve(input.state()),
    }
  }
  if (persisted)
    throw new AppError(
      'OPERATION_REQUIRES_RECONCILIATION',
      `Operation ${input.operationId} needs provider reconciliation before it can be retried`,
    )
  return undefined
}

export interface CommitApplicationEventInput {
  readonly state: BraidState
  readonly event: BraidEvent
  readonly journal: ApplicationJournal
  readonly clock: Clock
  readonly providerEventKeys: Pick<RunLedger, 'hasProviderEvent' | 'addProviderEvent'>
  readonly subscribers: ReadonlySet<AppSubscriber>
}

export function commitApplicationEvent(input: CommitApplicationEventInput): BraidState {
  const key = providerEventKey(input.event)
  if (key && input.providerEventKeys.hasProviderEvent(key)) return input.state
  const redacted = redactBraidEvent(input.event)
  const envelope = input.journal.envelope
    ? input.journal.envelope(input.state, redacted)
    : {
        sequence: input.state.sequence + 1,
        revision: input.state.revision + 1,
        occurredAt: input.clock.now(),
        event: redacted,
      }
  const result = input.journal.append(envelope)
  if (result !== undefined && typeof (result as Promise<unknown>).then === 'function') {
    throw new AppError(
      'ASYNC_COMMIT_REQUIRED',
      'This journal requires an awaited durable transition',
    )
  }
  const appendResult = result as { readonly appended?: boolean } | undefined
  if (appendResult?.appended === false) return input.state
  const nextState = reduceEvent(input.state, envelope)
  if (key) input.providerEventKeys.addProviderEvent(key)
  for (const subscriber of input.subscribers) {
    try {
      subscriber(structuredClone(nextState), structuredClone(envelope))
    } catch {
      // A renderer cannot change the durable transition.
    }
  }
  return nextState
}

export async function commitApplicationEventAsync(
  input: CommitApplicationEventInput,
): Promise<BraidState> {
  const key = providerEventKey(input.event)
  if (key && input.providerEventKeys.hasProviderEvent(key)) return input.state
  const redacted = redactBraidEvent(input.event)
  const envelope = input.journal.envelope
    ? input.journal.envelope(input.state, redacted)
    : {
        sequence: input.state.sequence + 1,
        revision: input.state.revision + 1,
        occurredAt: input.clock.now(),
        event: redacted,
      }
  const nextState = reduceEvent(input.state, envelope)
  const result = input.journal.appendWithState
    ? await input.journal.appendWithState(envelope, nextState)
    : await input.journal.append(envelope)
  if (result?.appended === false) return input.state
  if (key) input.providerEventKeys.addProviderEvent(key)
  for (const subscriber of input.subscribers) {
    try {
      subscriber(structuredClone(nextState), structuredClone(envelope))
    } catch {
      // A renderer cannot change the durable transition.
    }
  }
  return nextState
}

export function isEffectStorage(value: unknown): value is EffectStoragePort {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<EffectStoragePort>
  return (
    typeof candidate.reserveEffect === 'function' &&
    typeof candidate.current === 'function' &&
    typeof candidate.latest === 'function' &&
    typeof candidate.appendEffect === 'function' &&
    typeof candidate.history === 'function'
  )
}

function isTerminalStatus(
  status: BraidState['runs'][number]['status'],
): status is Extract<
  BraidState['runs'][number]['status'],
  'completed' | 'failed' | 'aborted' | 'cancelled' | 'blocked' | 'expired' | 'unknown'
> {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'aborted' ||
    status === 'cancelled' ||
    status === 'blocked' ||
    status === 'expired' ||
    status === 'unknown'
  )
}

function isProvenTerminalStatus(status: BraidState['runs'][number]['status']): boolean {
  return isTerminalStatus(status) && status !== 'unknown'
}
