import type { IsoDateTime, JsonValue } from './entities-base.js'
import type {
  AnalysisId,
  BranchId,
  CheckpointId,
  ConnectionId,
  ConversationId,
  Digest,
  EffectId,
  EnvironmentId,
  EventId,
  FeedbackDecisionId,
  GraphEdgeId,
  GraphNodeId,
  InteractionId,
  MessageId,
  OperationId,
  ProfileId,
  ReceiptId,
  ReplayCursor,
  RunId,
  SupervisorId,
  TurnId,
  WorkerId,
  WorkspaceId,
} from './ids.js'

export type GraphNodeReference =
  | { readonly kind: 'workspace'; readonly id: WorkspaceId }
  | { readonly kind: 'profile'; readonly id: ProfileId }
  | { readonly kind: 'conversation'; readonly id: ConversationId }
  | { readonly kind: 'branch'; readonly id: BranchId }
  | { readonly kind: 'turn'; readonly id: TurnId }
  | { readonly kind: 'run'; readonly id: RunId }
  | { readonly kind: 'message'; readonly id: MessageId }
  | { readonly kind: 'analysis'; readonly id: AnalysisId }
  | { readonly kind: 'environment'; readonly id: EnvironmentId }
  | { readonly kind: 'checkpoint'; readonly id: CheckpointId }
  | { readonly kind: 'supervisor'; readonly id: SupervisorId }
  | { readonly kind: 'worker'; readonly id: WorkerId }

export interface GraphNodeRecord {
  readonly id: GraphNodeId
  readonly reference: GraphNodeReference
  readonly title?: string
  readonly status?: string
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export type GraphEdgeKind =
  | 'continued'
  | 'branched_at'
  | 'cloned_from'
  | 'retried'
  | 'handed_off'
  | 'analyzed'
  | 'compared_left'
  | 'compared_right'
  | 'checkpointed'
  | 'forked_environment'
  | 'spawned'
  | 'supervised_by'
  | 'attached'

export interface GraphProvenance {
  readonly operationId?: OperationId
  readonly receiptId?: ReceiptId
  readonly sourceDigest?: Digest
}

export interface GraphEdgeRecord {
  readonly id: GraphEdgeId
  readonly kind: GraphEdgeKind
  readonly source: GraphNodeId
  readonly destination: GraphNodeId
  readonly provenance: GraphProvenance
  readonly createdAt: IsoDateTime
}

export type OperationKind =
  | 'profile-save'
  | 'connection-change'
  | 'conversation-create'
  | 'conversation-open'
  | 'conversation-update'
  | 'conversation-archive'
  | 'conversation-delete'
  | 'branch-create'
  | 'conversation-clone'
  | 'conversation-fork'
  | 'context-plan'
  | 'conversation-import'
  | 'draft-update'
  | 'send'
  | 'queue'
  | 'interaction-response'
  | 'cancel-run'
  | 'steer-worker'
  | 'checkpoint'
  | 'fork-environment'
  | 'analysis'
  | 'promote-analysis'
  | 'export'
  | 'delete'
  | 'custom'

export type OperationStatus =
  | 'pending'
  | 'acknowledged'
  | 'failed'
  | 'unknown'
  | 'conflict'
  | 'terminal'

export type OperationTarget =
  | { readonly kind: 'connection'; readonly id: ConnectionId }
  | { readonly kind: 'run'; readonly id: RunId }
  | { readonly kind: 'interaction'; readonly id: InteractionId }
  | { readonly kind: 'worker'; readonly id: WorkerId }
  | { readonly kind: 'checkpoint'; readonly id: CheckpointId }
  | { readonly kind: 'environment'; readonly id: EnvironmentId }
  | { readonly kind: 'conversation'; readonly id: ConversationId }
  | { readonly kind: 'branch'; readonly id: BranchId }
  | { readonly kind: 'analysis'; readonly id: AnalysisId }

export interface OperationRecord {
  readonly id: OperationId
  readonly kind: OperationKind
  readonly requestDigest: Digest
  readonly status: OperationStatus
  readonly target?: OperationTarget
  readonly result?: Readonly<Record<string, JsonValue>>
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
  readonly acknowledgedAt?: IsoDateTime
  readonly failureCode?: string
  readonly failureMessage?: string
  readonly terminalOutcome?: 'completed' | 'cancelled' | 'failed' | 'expired' | 'unknown'
}

export type EffectStatus = OperationStatus

export interface EffectRecord {
  readonly id: EffectId
  readonly operationId: OperationId
  readonly effectKind: string
  readonly requestDigest: Digest
  readonly kind: OperationKind
  readonly status: EffectStatus
  readonly attempt: number
  readonly externalReceiptId?: ReceiptId
  readonly outcomeDigest?: Digest
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface FeedbackDecisionRecord {
  readonly id: FeedbackDecisionId
  readonly conversationId: ConversationId
  readonly operationId?: OperationId
  readonly category:
    | 'approval'
    | 'rejection'
    | 'revision'
    | 'retry'
    | 'fork'
    | 'selection'
    | 'automation'
  readonly chosenOption: string
  readonly feedback?: string
  readonly automated: boolean
  readonly createdAt: IsoDateTime
}

export interface ReplayCursorRecord {
  readonly runId: RunId
  readonly cursor: ReplayCursor
  readonly committedSequence: number
}

export interface AppliedEventRecord {
  readonly id: EventId
  readonly sequence: number
  readonly revision: number
  readonly digest: Digest
}

export interface UnknownEventRecord {
  readonly id: EventId
  readonly type: string
  readonly namespace?: string
  readonly summary: string
  readonly sequence: number
}
