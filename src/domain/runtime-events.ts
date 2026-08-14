import type {
  AgentExactRunControlRef,
  InteractionRequest,
  StreamEvent,
} from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { ExecutionEnvironmentObservation } from './execution-observation.js'

type RuntimeFinalEvent = Extract<RuntimeStreamEvent, { readonly type: 'final' }>

/** Braid's retained adapters also project provider-confirmed cancellation. */
export type BraidFinalRuntimeEvent = Omit<RuntimeFinalEvent, 'status'> & {
  readonly status: RuntimeFinalEvent['status'] | 'cancelled'
}

export type BraidRuntimeEvent =
  | Exclude<RuntimeStreamEvent, RuntimeFinalEvent>
  | BraidFinalRuntimeEvent
  | StreamEvent
  | {
      readonly type: 'braid.execution.observed'
      readonly observation: ExecutionEnvironmentObservation
      readonly controlRef?: AgentExactRunControlRef
      readonly timestamp: string
    }
  | {
      readonly type: 'unknown'
      readonly originalType: string
      readonly payload: unknown
    }

export interface RuntimeEventEnvelope {
  readonly runId: string
  readonly eventId: string
  readonly sequence: number
  readonly cursor?: string
  readonly occurredAt?: string
  readonly receivedAt: string
  readonly event: BraidRuntimeEvent
}

export interface RuntimeEventSummary {
  readonly eventId: string
  readonly sequence: number
  readonly type: string
  readonly cursor?: string
  readonly occurredAt?: string
}

export function isRuntimeEventEnvelope(
  value: BraidRuntimeEvent | RuntimeEventEnvelope,
): value is RuntimeEventEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runId' in value &&
    'eventId' in value &&
    'sequence' in value &&
    'event' in value
  )
}

export function isInteractionEvent(
  event: BraidRuntimeEvent,
): event is Extract<StreamEvent, { readonly type: 'interaction' }> {
  return event.type === 'interaction' && 'request' in event
}

export function isFinalRuntimeEvent(event: BraidRuntimeEvent): event is BraidFinalRuntimeEvent {
  return event.type === 'final'
}

export function runtimeEventType(event: BraidRuntimeEvent): string {
  return event.type
}

export function interactionFromEvent(event: BraidRuntimeEvent): InteractionRequest | undefined {
  return isInteractionEvent(event) ? event.request : undefined
}
