import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { RetainedExecutionPlan, RetainedTurnResult } from './retained-execution-contract.js'
import type { RetainedExecutionState } from './retained-execution-state.js'

const TERMINAL_STREAM_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled'])

export async function* streamRetainedExecution(input: {
  readonly runId: string
  readonly handle: RetainedRunHandle
  readonly plan: RetainedExecutionPlan
  readonly state: RetainedExecutionState
  readonly signal: AbortSignal
  readonly includeObservation: boolean
  readonly afterSequence: number
  readonly after?: string
  readonly terminalResult?: Promise<RetainedTurnResult>
  /** The run is already terminal from an earlier streamed status. */
  readonly afterTerminalStatus?: boolean
}): AsyncGenerator<RuntimeEventEnvelope> {
  const reader = new AbortController()
  const previous = input.state.replaceReader(input.runId, reader)
  previous?.abort(new DOMException('Reader replaced', 'AbortError'))
  const signal = AbortSignal.any([input.signal, reader.signal])
  let sequence = input.afterSequence
  try {
    if (input.includeObservation) {
      sequence += 1
      const observedAt = new Date().toISOString()
      const observation = await input.plan.observe()
      if (observation === undefined) {
        throw new Error('Retained execution observation is unavailable')
      }
      if (
        observation.providerEnvironmentId !== undefined &&
        observation.providerEnvironmentId !== input.handle.controlRef.environmentId
      ) {
        throw new Error('Retained execution observation conflicts with its exact control reference')
      }
      yield {
        runId: input.runId,
        eventId: `${input.runId}:execution-bound`,
        sequence,
        receivedAt: observedAt,
        event: {
          type: 'braid.execution.observed',
          observation:
            observation.providerEnvironmentId === undefined
              ? {
                  ...observation,
                  providerEnvironmentId: input.handle.controlRef.environmentId,
                }
              : observation,
          controlRef: input.handle.controlRef,
          timestamp: observedAt,
        },
      }
    }
    signal.throwIfAborted()
    const providerSequence = Math.max(0, input.afterSequence - 1)
    let terminalStatusSeen = input.afterTerminalStatus === true
    try {
      for await (const envelope of input.handle.events({
        ...(input.after === undefined
          ? {}
          : { after: { cursor: input.after, sequence: providerSequence } }),
        signal,
      })) {
        sequence = envelope.sequence + 1
        if (envelope.event.type === 'status' && TERMINAL_STREAM_STATUSES.has(envelope.event.status))
          terminalStatusSeen = true
        yield { ...envelope, runId: input.runId, sequence }
      }
    } catch (error) {
      // A stream that already reported its terminal status carries no more run content, and
      // the exact result endpoint stays authoritative. Sandbox SDK 0.45 ends a failed run's
      // stream with a synthetic `done` that names the harness session, which the provider
      // rejects; without this read, the run's failure detail and usage are lost.
      if (!terminalStatusSeen || signal.aborted) throw error
    }
    const result =
      input.terminalResult === undefined ? await input.handle.result() : await input.terminalResult
    sequence += 1
    yield input.plan.projectFinal({ runId: input.runId, sequence, result })
  } finally {
    input.state.clearReader(input.runId, reader)
  }
}
