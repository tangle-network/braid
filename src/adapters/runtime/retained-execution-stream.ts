import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import type { RuntimeEventEnvelope } from '../../domain/runtime-events.js'
import type { RetainedExecutionPlan } from './retained-execution-contract.js'
import type { RetainedExecutionState } from './retained-execution-state.js'

export async function* streamRetainedExecution(input: {
  readonly runId: string
  readonly handle: RetainedRunHandle
  readonly plan: RetainedExecutionPlan
  readonly state: RetainedExecutionState
  readonly signal: AbortSignal
  readonly includeObservation: boolean
  readonly afterSequence: number
  readonly after?: string
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
      yield {
        runId: input.runId,
        eventId: `${input.runId}:execution-bound`,
        sequence,
        receivedAt: observedAt,
        event: {
          type: 'braid.execution.observed',
          observation,
          controlRef: input.handle.controlRef,
          timestamp: observedAt,
        },
      }
    }
    signal.throwIfAborted()
    const providerSequence = Math.max(0, input.afterSequence - 1)
    for await (const envelope of input.handle.events({
      ...(input.after === undefined
        ? {}
        : { after: { cursor: input.after, sequence: providerSequence } }),
      signal,
    })) {
      sequence = envelope.sequence + 1
      if (envelope.cursor !== undefined) input.state.rememberCursor(input.runId, envelope.cursor)
      yield { ...envelope, runId: input.runId, sequence }
    }
    const result = await input.handle.result()
    sequence += 1
    yield input.plan.projectFinal({ runId: input.runId, sequence, result })
  } finally {
    input.state.clearReader(input.runId, reader)
  }
}
