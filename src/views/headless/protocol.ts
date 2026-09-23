import type { BraidEventEnvelope } from '../../domain/events.js'
import type { BraidState } from '../../domain/state.js'
import type { AnalysisRecord } from '../../analysis/model.js'
import type { BraidGraph } from '../../domain/graph.js'
import type { ComparisonArmBinding, ComparisonRunRecord } from '../../analysis/comparison.js'
import type {
  ApplicationCancellationReceipt,
  ApplicationComparison,
  ApplicationWorkerCancellationReceipt,
} from '../../app/application.js'
import type { SupervisorSnapshot } from '../../supervisor/runtime-supervisor.js'

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

export interface ShutdownRequest {
  readonly version: 1
  readonly requestId: string
  readonly command: 'shutdown'
  readonly params?: Record<string, never>
}

export interface AnalysisRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId: string
  readonly command: 'analysis'
  readonly params: { readonly text: string }
}

export interface GetGraphRequest {
  readonly version: 1
  readonly requestId: string
  readonly command: 'get_graph'
}

export interface CancelRunRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId: string
  readonly command: 'cancel_run'
  readonly params: { readonly runId: string; readonly reason: string }
}

export interface CancelWorkerRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId: string
  readonly command: 'cancel_worker'
  readonly params: {
    readonly supervisorId: string
    readonly runId: string
    readonly workerId?: string
    readonly reason: string
  }
}

export interface SupervisorRequest {
  readonly version: 1
  readonly requestId: string
  readonly command: 'get_supervisor'
  readonly params: { readonly supervisorId: string }
}

export interface CompareRequest {
  readonly version: 1
  readonly requestId: string
  readonly operationId: string
  readonly command: 'compare'
  readonly params: {
    readonly baselineSourceId: string
    readonly treatmentSourceId: string
    readonly baselineRuns: readonly ComparisonRunRecord[]
    readonly treatmentRuns: readonly ComparisonRunRecord[]
    readonly baselineBinding: ComparisonArmBinding
    readonly treatmentBinding: ComparisonArmBinding
  }
}

export type BraidRequest =
  | InitializeRequest
  | GetStateRequest
  | SendRequest
  | AnalysisRequest
  | GetGraphRequest
  | CancelRunRequest
  | CancelWorkerRequest
  | SupervisorRequest
  | CompareRequest
  | ShutdownRequest

export interface AckResponse {
  readonly version: 1
  readonly type: 'ack'
  readonly requestId: string
  readonly revision: number
  readonly operationId?: string
  readonly replayed?: boolean
}

export interface EventResponse {
  readonly version: 1
  readonly type: 'event'
  readonly sequence: number
  readonly revision: number
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

export interface AnalysisResponse {
  readonly version: 1
  readonly type: 'analysis'
  readonly requestId: string
  readonly result: AnalysisRecord | { readonly branchId: string }
}

export interface GraphResponse {
  readonly version: 1
  readonly type: 'graph'
  readonly requestId: string
  readonly graph: BraidGraph
}

export interface CancellationResponse {
  readonly version: 1
  readonly type: 'cancellation'
  readonly requestId: string
  readonly result: ApplicationCancellationReceipt | ApplicationWorkerCancellationReceipt
}

export interface SupervisorResponse {
  readonly version: 1
  readonly type: 'supervisor'
  readonly requestId: string
  readonly snapshot: SupervisorSnapshot
}

export interface ComparisonResponse {
  readonly version: 1
  readonly type: 'comparison'
  readonly requestId: string
  readonly result: ApplicationComparison
}

export type BraidResponse =
  | AckResponse
  | EventResponse
  | StateResponse
  | AnalysisResponse
  | GraphResponse
  | CancellationResponse
  | SupervisorResponse
  | ComparisonResponse
  | ErrorResponse
