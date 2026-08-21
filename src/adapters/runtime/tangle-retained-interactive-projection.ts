import type { AgentInteractiveSessionStatus } from '@tangle-network/agent-interface'
import type {
  RetainedInteractiveAdmission,
  RetainedInteractiveRunHandle,
  RetainedInteractiveStartedAdmission,
} from '@tangle-network/agent-runtime/kernel'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { ProviderRunSnapshot } from '../../ports/execution.js'
import type { NativeInteractiveRunOutcome } from '../../ports/native-interactive-execution.js'
import type { PreparedTangleRetainedConnection } from './production-tangle-sandbox-backend.js'
import type { TangleInteractiveRecoveryInput } from './tangle-retained-interactive-contract.js'
import { interactiveSessionId } from './tangle-retained-interactive-contract.js'

export function partialInteractiveStatus(
  runId: string,
  admission: Exclude<RetainedInteractiveAdmission, RetainedInteractiveStartedAdmission>,
): ProviderRunSnapshot {
  const sessionId = interactiveSessionId(admission)
  return sessionId === undefined
    ? { runId, status: 'unknown', detail: `replayable:${admission.phase}` }
    : { runId, status: 'unknown', sessionId, detail: `replayable:${admission.phase}` }
}

export function interactiveStatusDetail(status: AgentInteractiveSessionStatus): string {
  if (status.state === 'unknown') return status.message
  if (!('reason' in status)) return 'interactive session running'
  return !('exitCode' in status) || status.exitCode === undefined
    ? `interactive session ${status.reason}`
    : `interactive session ${status.reason} with code ${status.exitCode}`
}

export function interactiveStatus(
  status: AgentInteractiveSessionStatus,
  detached: boolean,
): ProviderRunSnapshot['status'] {
  if (detached && status.state === 'running') return 'detached'
  if (status.state === 'running') return 'streaming'
  if (status.state === 'exited' && status.reason !== 'lost') return 'completed'
  return 'unknown'
}

export async function terminalOutcome(
  handle: RetainedInteractiveRunHandle,
  signal?: AbortSignal,
): Promise<Extract<NativeInteractiveRunOutcome, { readonly kind: 'exited' }> | undefined> {
  const status = await handle.status(signal === undefined ? undefined : { signal })
  if (status.state !== 'exited') return undefined
  return {
    kind: 'exited',
    ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
    ...(status.exitSignal === undefined ? {} : { exitSignal: status.exitSignal }),
  }
}

export function replayBoundary(
  input: TangleInteractiveRecoveryInput,
  runId: string,
  handle: RetainedInteractiveRunHandle,
): number {
  const cursorSequence =
    input.after === undefined
      ? undefined
      : sequenceFromCursor(input.after, runId, handle.ref.incarnationId)
  if (
    cursorSequence !== undefined &&
    input.afterSequence !== undefined &&
    cursorSequence !== input.afterSequence
  ) {
    throw new Error('Interactive replay cursor conflicts with the saved sequence')
  }
  return input.afterSequence ?? cursorSequence ?? 0
}

function sequenceFromCursor(cursor: string, runId: string, incarnationId: string): number {
  const prefix = `${runId}:interactive:${incarnationId}:`
  if (!cursor.startsWith(prefix)) {
    throw new Error('Interactive replay cursor belongs to another process')
  }
  const sequence = Number(cursor.slice(prefix.length))
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error('Interactive replay cursor is malformed')
  }
  return sequence
}

export async function observedEnvelope(
  runId: string,
  handle: RetainedInteractiveRunHandle,
  prepared: PreparedTangleRetainedConnection,
  sequence: number,
): Promise<RuntimeEventEnvelope> {
  const observation = await prepared.observation.snapshot()
  if (observation === undefined) throw new Error('Tangle interactive observation is unavailable')
  const receivedAt = new Date().toISOString()
  return {
    runId,
    eventId: `${runId}:interactive:${handle.ref.incarnationId}:observed`,
    sequence,
    cursor: interactiveCursor(runId, handle, sequence),
    occurredAt: receivedAt,
    receivedAt,
    event: {
      type: 'braid.execution.observed',
      observation,
      controlRef: handle.ref.run,
      timestamp: receivedAt,
    },
  }
}

export function terminalEnvelope(
  runId: string,
  handle: RetainedInteractiveRunHandle,
  prepared: PreparedTangleRetainedConnection,
  outcome: Exclude<NativeInteractiveRunOutcome, { readonly kind: 'detached' }>,
  sequence: number,
  cancelled: boolean,
): RuntimeEventEnvelope {
  const timestamp = new Date().toISOString()
  const failed = outcome.kind === 'failed'
  const reason = cancelled
    ? 'Interactive agent stopped'
    : failed
      ? outcome.message
      : outcome.exitCode === undefined
        ? 'Interactive agent exited'
        : `Interactive agent exited with code ${outcome.exitCode}`
  return {
    runId,
    eventId: `${runId}:interactive:${handle.ref.incarnationId}:final`,
    sequence,
    cursor: interactiveCursor(runId, handle, sequence),
    occurredAt: timestamp,
    receivedAt: timestamp,
    event: {
      type: 'final',
      task: { id: runId, intent: 'Run the retained Tangle interactive agent' },
      status: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
      reason,
      text: '',
      metadata: { model: prepared.model, tokensKnown: false, usdKnown: false },
      ...(failed ? { error: { kind: 'backend', message: outcome.message } } : {}),
      timestamp,
    },
  }
}

function interactiveCursor(
  runId: string,
  handle: RetainedInteractiveRunHandle,
  sequence: number,
): string {
  return `${runId}:interactive:${handle.ref.incarnationId}:${sequence}`
}
