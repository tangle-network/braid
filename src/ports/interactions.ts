import type { InteractionRequest, InteractionResponse } from '@tangle-network/agent-interface'
import type { InteractionViewModel } from '../views/shared/interaction.js'
import type { InteractionCapabilities, InteractionQueueState } from '../domain/interaction-state.js'
export type { InteractionCapabilities } from '../domain/interaction-state.js'

export type InteractionAckStatus =
  | 'accepted'
  | 'already_resolved'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'conflict'
  | 'unknown_interaction'
  | 'unknown_run'
  | 'transport_error'

export interface InteractionAck {
  readonly status: InteractionAckStatus
  readonly runId: string
  readonly interactionId: string
  readonly operationId: string
  readonly resolvedOutcome?: InteractionResponse['outcome']
  readonly reason?: string
}

export interface RespondToInteractionPortInput {
  readonly runId: string
  readonly interactionId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly runner?: string
  readonly response: InteractionResponse
  readonly operationId: string
  readonly signal?: AbortSignal
}

export interface ReconcileInteractionInput {
  readonly runId: string
  readonly interactionId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly runner?: string
  readonly signal?: AbortSignal
}

export type ReconciledInteraction =
  | { readonly status: 'pending' }
  | { readonly status: 'resolved'; readonly outcome?: 'accepted' | 'declined' | 'cancelled' }
  | { readonly status: 'expired' | 'cancelled' | 'missing' | 'unknown'; readonly reason?: string }

/**
 * Adapter boundary for the shared runtime/provider interaction path.
 * Braid owns queueing and policy; the adapter owns transport and provider
 * binding. The response is intentionally the canonical shared response.
 */
export interface InteractionRuntimePort {
  readonly capabilities: InteractionCapabilities
  respondToInteraction(input: RespondToInteractionPortInput): Promise<InteractionAck>
  reconcileInteraction?(input: ReconcileInteractionInput): Promise<ReconciledInteraction>
}

export interface InteractionControllerPort {
  state(): InteractionQueueState
  views(): readonly InteractionViewModel[]
  receive(input: ReceiveInteractionInput): InteractionReceiveResult
  respond(input: RespondInteractionInput): Promise<InteractionResponseResult>
  cancel(input: CancelInteractionInput): Promise<InteractionResponseResult>
  reconcile(input?: { readonly runId?: string; readonly signal?: AbortSignal }): Promise<void>
  waitForAutomation?(): Promise<void>
  setFeedbackCapture?(enabled: boolean): void
}

export interface ReceiveInteractionInput {
  readonly runId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly runner?: string
  readonly request: InteractionRequest
}

export interface InteractionReceiveResult {
  readonly key: string
  readonly replayed: boolean
  readonly queuePosition: number
  readonly containsSecret: boolean
}

export interface RespondInteractionInput {
  readonly runId: string
  readonly interactionId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly runner?: string
  readonly operationId: string
  readonly response: InteractionResponse
  readonly signal?: AbortSignal
}

export interface CancelInteractionInput {
  readonly runId: string
  readonly interactionId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly runner?: string
  readonly operationId: string
  readonly signal?: AbortSignal
}

export interface InteractionResponseResult {
  readonly status: InteractionAckStatus | 'stale' | 'invalid'
  readonly key: string
  readonly operationId: string
  readonly replayed: boolean
  readonly reason?: string
}
