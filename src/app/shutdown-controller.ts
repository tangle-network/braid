import type { BraidEvent } from '../domain/events.js'
import type { BraidRun, BraidState } from '../domain/state.js'
import type { ShutdownReceipt } from './application-types.js'
import { AppError } from './errors.js'
import { shutdownRequestDigest } from './operation-ledger.js'
import type { RunLedger } from './run-ledger.js'

export interface ShutdownControllerInput {
  readonly operationId: string
  readonly mode?: 'wait' | 'detach' | 'cancel'
  readonly state: () => BraidState
  readonly ledger: RunLedger
  readonly commit: (event: BraidEvent) => void
  readonly cancelRun: (input: {
    readonly operationId: string
    readonly runId: string
    readonly reason: string
    readonly terminalStatus: 'aborted'
    readonly legacy: true
  }) => Promise<{ readonly completion: Promise<BraidState> }>
  readonly detachRun: (input: {
    readonly operationId: string
    readonly runId: string
  }) => Promise<{ readonly completion: Promise<BraidState> }>
  readonly waitForIdle: () => Promise<BraidState>
}

export function shutdownApplication(input: ShutdownControllerInput): ShutdownReceipt {
  const digest = shutdownRequestDigest()
  const previous = input.ledger.getShutdown(input.operationId)
  if (previous) {
    if (previous.digest !== digest)
      throw new AppError(
        'OPERATION_CONFLICT',
        `Operation ${input.operationId} was already used with different input`,
      )
    return {
      operationId: input.operationId,
      revision: input.state().revision,
      replayed: true,
      completion: previous.completion.then(() => structuredClone(input.state())),
    }
  }
  input.commit({ kind: 'application.shutdown.requested', operationId: input.operationId })
  const state = input.state()
  const runId = state.activeRunId ?? undefined
  const run = runId ? state.runs.find((candidate) => candidate.id === runId) : undefined
  const completion = completeShutdown(input, runId, run)
  input.ledger.setShutdown(input.operationId, { digest, completion })
  return {
    operationId: input.operationId,
    revision: input.state().revision,
    replayed: false,
    ...(runId === undefined ? { outcome: 'idle' as const } : {}),
    ...(input.mode === 'cancel' ? { outcome: 'cancelled' as const } : {}),
    ...(input.mode === 'detach' ? { outcome: 'detached' as const } : {}),
    completion: completion.then(() => structuredClone(input.state())),
  }
}

async function completeShutdown(
  input: ShutdownControllerInput,
  runId: string | undefined,
  run: BraidRun | undefined,
): Promise<BraidState> {
  if (!runId || !run) return input.state()
  if (input.mode === 'cancel') {
    const receipt = await input.cancelRun({
      operationId: `${input.operationId}:cancel`,
      runId,
      reason: 'Braid is shutting down',
      terminalStatus: 'aborted',
      legacy: true,
    })
    return receipt.completion
  }
  if (input.mode === 'detach') {
    const receipt = await input.detachRun({ operationId: `${input.operationId}:detach`, runId })
    return receipt.completion
  }
  return input.waitForIdle()
}
