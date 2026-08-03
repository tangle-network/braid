import { HEADLESS_COMMAND_NAMES, type HeadlessCommandName } from '../shared/headless-commands.js'
import type { BraidViewModel, HeadlessState, HeadlessSummary } from '../shared/models.js'
import type { UiEvent } from '../shared/intents.js'

export const BRAID_PROTOCOL_VERSION = 1 as const
export type StateProjection = 'full' | 'summary'

export const RPC_COMMAND_NAMES = HEADLESS_COMMAND_NAMES
export type RpcCommandName = HeadlessCommandName

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
  readonly params?: {
    readonly projection?: StateProjection
  }
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

export interface ShutdownRequest {
  readonly version: 1
  readonly requestId: string
  readonly command: 'shutdown'
  readonly operationId: string
  readonly params?: Record<string, never>
}

export interface GenericRpcRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId?: string
  readonly command: Exclude<RpcCommandName, 'initialize' | 'get_state' | 'send' | 'shutdown'>
  readonly params: Readonly<Record<string, unknown>>
}

export type BraidRequest =
  | InitializeRequest
  | GetStateRequest
  | SendRequest
  | ShutdownRequest
  | GenericRpcRequest

export interface AckResponse {
  readonly version: 1
  readonly type: 'ack'
  readonly requestId: string
  readonly revision: number
  readonly operationId?: string
  readonly command?: string
  readonly replayed?: boolean
}

export interface EventResponse {
  readonly version: 1
  readonly type: 'event'
  readonly sequence: number
  readonly revision: number
  readonly event: UiEvent
}

export interface FullStateResponse {
  readonly version: 1
  readonly type: 'state'
  readonly requestId: string
  readonly revision: number
  readonly projection: 'full'
  readonly state: HeadlessState
  readonly view: BraidViewModel
}

export interface SummaryStateResponse {
  readonly version: 1
  readonly type: 'state'
  readonly requestId: string
  readonly revision: number
  readonly projection: 'summary'
  readonly state: HeadlessSummary
}

export type StateResponse = FullStateResponse | SummaryStateResponse

export interface ErrorResponse {
  readonly version: 1
  readonly type: 'error'
  readonly requestId?: string
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly choices?: readonly string[]
}

export type BraidResponse = AckResponse | EventResponse | StateResponse | ErrorResponse
