import type { RunAdmissionReceipt } from '../../domain/receipts.js'
import { HEADLESS_COMMAND_NAMES, type HeadlessCommandName } from '../shared/headless-commands.js'
import type { UiEvent } from '../shared/intents.js'
import type { BraidViewModel, HeadlessState, HeadlessSummary } from '../shared/models.js'

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
  readonly params?: {
    readonly mode?: 'wait' | 'detach' | 'cancel'
  }
}

export interface GenericRpcRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId?: string
  readonly command: Exclude<RpcCommandName, 'initialize' | 'get_state' | 'send' | 'shutdown'>
  readonly params: Readonly<Record<string, unknown>>
}

interface RunControlRequestBase {
  readonly version: 1
  readonly requestId: string
  readonly operationId: string
  readonly params?: {
    readonly runId?: string
  }
}

export interface QueueRequest extends RunControlRequestBase {
  readonly command: 'queue'
  readonly params: { readonly runId?: string; readonly text: string }
}

export interface SteerRequest extends RunControlRequestBase {
  readonly command: 'steer'
  readonly params: { readonly runId?: string; readonly text: string }
}

export interface CancelRequest extends RunControlRequestBase {
  readonly command: 'cancel'
  readonly params: { readonly runId?: string; readonly reason?: string }
}

export interface DetachRequest extends RunControlRequestBase {
  readonly command: 'detach'
}

export interface ReconnectRequest extends RunControlRequestBase {
  readonly command: 'reconnect'
  readonly params: { readonly runId: string }
}

export interface ReconcileRequest extends RunControlRequestBase {
  readonly command: 'reconcile'
  readonly params: { readonly runId: string }
}

export type BraidRequest =
  | InitializeRequest
  | GetStateRequest
  | SendRequest
  | ShutdownRequest
  | GenericRpcRequest
  | QueueRequest
  | SteerRequest
  | CancelRequest
  | DetachRequest
  | ReconnectRequest
  | ReconcileRequest

export interface AckResponse {
  readonly version: 1
  readonly type: 'ack'
  readonly requestId: string
  readonly revision: number
  readonly operationId?: string
  readonly command?: string
  readonly replayed?: boolean
  readonly runId?: string
  readonly control?: 'cancel' | 'steer' | 'queue' | 'detach' | 'reconnect' | 'respond_interaction'
  readonly outcome?: 'accepted' | 'already-applied' | 'rejected' | 'unknown'
  readonly position?: number
  readonly admission?: RunAdmissionReceipt
  readonly result?: unknown
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
