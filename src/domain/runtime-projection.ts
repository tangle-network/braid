import type { InteractionBinding, InteractionRequest } from '@tangle-network/agent-interface'
import type { RunAdmissionReceipt, RunCapabilities } from './run-contracts.js'
import type { RuntimeEventSummary } from './runtime-events.js'

export interface MessagePartSource {
  readonly eventId?: string
  readonly sequence?: number
  readonly cursor?: string
  readonly occurredAt?: string
}

export type RuntimeMessagePartKind =
  | 'text'
  | 'reasoning'
  | 'tool-call'
  | 'tool-result'
  | 'artifact'
  | 'proposal'
  | 'warning'
  | 'error'
  | 'interaction'
  | 'system'
  | 'unknown'

export interface RuntimeMessagePart {
  readonly id: string
  readonly kind: RuntimeMessagePartKind
  readonly text?: string
  readonly status?: string
  readonly toolName?: string
  readonly callId?: string
  readonly input?: unknown
  readonly result?: unknown
  readonly error?: string
  readonly artifactId?: string
  readonly uri?: string
  readonly mimeType?: string
  readonly title?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly source?: MessagePartSource
}

export interface RuntimeMessageFields {
  readonly parts: readonly RuntimeMessagePart[]
  readonly partsTruncated?: boolean
}

export interface BraidInteraction {
  readonly request: InteractionRequest
  readonly responseBinding: InteractionBinding
  readonly runId: string
  readonly source: MessagePartSource
  readonly status: 'pending' | 'responding' | 'declined' | 'cancelled' | 'resolved' | 'unknown'
}

export interface BraidActivity {
  readonly id: string
  readonly runId: string
  readonly type: string
  readonly label: string
  readonly detail?: string
  readonly source?: MessagePartSource
}

export interface QueuedInput {
  readonly operationId: string
  readonly runId: string
  readonly text: string
  readonly position: number
}

export interface RuntimeRunFields {
  readonly receipt: RunAdmissionReceipt
  readonly capabilities: RunCapabilities
  readonly reasoningTokens?: number
  readonly terminalReason?: string
  readonly lastCursor?: string
  readonly lastProviderSequence: number
  readonly eventCount: number
  readonly contentBytes?: number
  readonly contentTruncated?: boolean
  readonly missingSequence?: { readonly from: number; readonly to: number }
  readonly interactions: readonly BraidInteraction[]
  readonly activity: readonly BraidActivity[]
  readonly eventDetails: readonly RuntimeEventSummary[]
  readonly activityTruncated?: boolean
  readonly eventDetailsTruncated?: boolean
  readonly interactionsTruncated?: boolean
}

export const LEGACY_RUN_CAPABILITIES: RunCapabilities = Object.freeze({
  streaming: { live: true, replay: false, detach: false, turnIdempotency: true },
  sessions: { continue: false, messages: false },
  controls: { cancel: true, steer: false, queue: true, status: false, recreate: false },
  events: { stableIdentity: false, sequence: true, cursor: false },
  usage: true,
})
