import type { InteractionResponse } from '@tangle-network/agent-interface'
import type { BraidEventEnvelope } from '../../domain/events.js'
import type { BraidState } from '../../domain/state.js'

export const BRAID_PROTOCOL_VERSION = 1 as const

export interface InitializeRequest {
  readonly version: 1
  readonly requestId: string
  readonly command: 'initialize'
  readonly params: {
    readonly workspace: string
    readonly subscribe?: boolean
  }
}

export interface GetStateRequest {
  readonly version: 1
  readonly requestId: string
  readonly command: 'get_state'
  readonly params?: Record<string, never>
}

export interface SendRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId: string
  readonly command: 'send'
  readonly params: {
    readonly conversationId?: string
    readonly branchId?: string
    readonly text: string
  }
}

export interface RespondInteractionRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId: string
  readonly command: 'respond_interaction'
  readonly params: {
    readonly runId: string
    readonly interactionId: string
    readonly providerSessionId?: string
    readonly profileDigest?: string
    readonly connectionId?: string
    readonly workspaceId?: string
    readonly runner?: string
    readonly response: InteractionResponse
  }
}

export interface ShutdownRequest {
  readonly version: 1
  readonly requestId: string
  readonly command: 'shutdown'
  readonly params?: Record<string, never>
}

export type BraidRequest =
  | InitializeRequest
  | GetStateRequest
  | SendRequest
  | RespondInteractionRequest
  | ShutdownRequest

export interface AckResponse {
  readonly version: 1
  readonly type: 'ack'
  readonly requestId: string
  readonly revision: number
  readonly operationId?: string
  readonly replayed?: boolean
  readonly interactionStatus?: string
  readonly reason?: string
}

export interface EventResponse {
  readonly version: 1
  readonly type: 'event'
  readonly sequence: number
  readonly revision: number
  readonly eventId?: string
  readonly event: BraidEventEnvelope['event']
}

export interface StateResponse {
  readonly version: 1
  readonly type: 'state'
  readonly requestId: string
  readonly revision: number
  readonly state: BraidState
}

export interface ErrorResponse {
  readonly version: 1
  readonly type: 'error'
  readonly requestId?: string
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export type BraidResponse = AckResponse | EventResponse | StateResponse | ErrorResponse
