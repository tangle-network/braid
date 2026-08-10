import type { BraidEvent, BraidEventEnvelope } from './events.js'
import { applyExecutionObservation } from './reducer-execution-observation.js'
import { reduceContentEvent } from './reducer-content.js'
import { reduceInteractionEvent } from './reducer-interactions.js'
import { reduceLifecycleEvent } from './reducer-lifecycle.js'
import type { BraidState } from './state.js'

type RuntimeEventKind =
  | 'run.requested'
  | 'run.text.delta'
  | 'run.part.updated'
  | 'run.reasoning.delta'
  | 'run.tool.call'
  | 'run.tool.result'
  | 'run.artifact'
  | 'run.proposal'
  | 'run.warning'
  | 'run.error'
  | 'run.usage'
  | 'run.cost'
  | 'run.interaction'
  | 'run.interaction.cancelled'
  | 'run.interaction.response.requested'
  | 'run.interaction.responded'
  | 'run.provider.event'
  | 'run.environment.observed'
  | 'run.finished'
  | 'run.status.changed'
  | 'run.control.requested'
  | 'run.control.acknowledged'
  | 'run.queue.added'
  | 'run.queue.removed'
  | 'run.detached'
  | 'run.reconnecting'
  | 'run.reconciled'
  | 'run.unknown'

type RuntimeEvent = Extract<BraidEvent, { readonly kind: RuntimeEventKind }>

export function reduceRuntimeEvent(state: BraidState, envelope: BraidEventEnvelope): BraidState {
  const base = { revision: envelope.revision, sequence: envelope.sequence }
  const event = envelope.event
  if (!isRuntimeEvent(event)) return state
  const reduced = (() => {
    switch (event.kind) {
      case 'run.requested':
      case 'run.control.requested':
      case 'run.control.acknowledged':
      case 'run.queue.added':
      case 'run.queue.removed':
      case 'run.detached':
      case 'run.reconnecting':
      case 'run.unknown':
        return reduceLifecycleEvent(state, event, base, envelope.occurredAt)
      case 'run.text.delta':
      case 'run.part.updated':
      case 'run.reasoning.delta':
      case 'run.tool.call':
      case 'run.tool.result':
      case 'run.artifact':
      case 'run.proposal':
      case 'run.warning':
      case 'run.error':
      case 'run.usage':
      case 'run.cost':
        return reduceContentEvent(state, event, base)
      case 'run.interaction':
      case 'run.interaction.cancelled':
      case 'run.interaction.response.requested':
      case 'run.interaction.responded':
      case 'run.provider.event':
      case 'run.finished':
        return reduceInteractionEvent(state, event, base)
      case 'run.environment.observed':
        return applyExecutionObservation(state, event, envelope.occurredAt)
      case 'run.status.changed':
        return reduceInteractionEvent(state, event, base)
      case 'run.reconciled':
        return reduceLifecycleEvent(state, event, base, envelope.occurredAt)
      default: {
        const exhaustive: never = event
        return exhaustive
      }
    }
  })()
  if (!('provider' in event) || !event.provider) return reduced
  const runId = event.runId
  const sequence = event.provider.providerSequence
  const missingHistory = reduced.missingHistory.flatMap((range) => {
    const toSequence = range.toSequence ?? range.fromSequence
    if (range.runId !== runId || sequence < range.fromSequence) return [range]
    if (sequence > toSequence) return [range]
    if (range.fromSequence === toSequence) return []
    if (sequence === range.fromSequence) return [{ ...range, fromSequence: sequence + 1 }]
    if (sequence === toSequence) return [{ ...range, toSequence: sequence - 1 }]
    return [
      { ...range, toSequence: sequence - 1 },
      { ...range, fromSequence: sequence + 1 },
    ]
  })
  const next =
    missingHistory.length === reduced.missingHistory.length
      ? reduced
      : { ...reduced, missingHistory }
  const incompleteRuns = new Set(missingHistory.map((range) => range.runId))
  const completedRunIds = new Set(
    next.runs
      .filter(
        (candidate) =>
          !candidate.complete &&
          candidate.status !== 'unknown' &&
          ['completed', 'failed', 'aborted', 'cancelled', 'blocked', 'expired'].includes(
            candidate.status,
          ) &&
          !incompleteRuns.has(candidate.id),
      )
      .map((candidate) => candidate.id),
  )
  if (completedRunIds.size === 0) return next
  return {
    ...next,
    messages: next.messages.map((message) =>
      message.runId && completedRunIds.has(message.runId) && message.role === 'assistant'
        ? {
            ...message,
            complete: true,
            status:
              next.runs.find((candidate) => candidate.id === message.runId)?.status === 'completed'
                ? 'complete'
                : next.runs.find((candidate) => candidate.id === message.runId)?.status === 'failed'
                  ? 'failed'
                  : message.status,
          }
        : message,
    ),
    runs: next.runs.map((candidate) =>
      completedRunIds.has(candidate.id) ? { ...candidate, complete: true } : candidate,
    ),
  }
}

export function isRuntimeEvent(event: BraidEvent): event is RuntimeEvent {
  switch (event.kind) {
    case 'run.requested':
      return event.receipt !== undefined
    case 'run.text.delta':
      return event.provider !== undefined
    case 'run.finished':
      return (
        event.provider !== undefined || event.reason !== undefined || event.status === 'cancelled'
      )
    case 'run.status.changed':
      return 'provider' in event || 'detail' in event
    case 'run.reconciled':
      return 'from' in event || 'to' in event
    case 'run.part.updated':
    case 'run.reasoning.delta':
    case 'run.tool.call':
    case 'run.tool.result':
    case 'run.artifact':
    case 'run.proposal':
    case 'run.warning':
    case 'run.usage':
    case 'run.cost':
    case 'run.error':
    case 'run.interaction':
    case 'run.interaction.cancelled':
    case 'run.interaction.response.requested':
    case 'run.interaction.responded':
    case 'run.provider.event':
    case 'run.environment.observed':
    case 'run.control.requested':
    case 'run.control.acknowledged':
    case 'run.queue.added':
    case 'run.queue.removed':
    case 'run.detached':
    case 'run.reconnecting':
    case 'run.unknown':
      return true
    default:
      return false
  }
}
