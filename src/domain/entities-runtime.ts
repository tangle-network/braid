import type {
  BindingId,
  BranchId,
  CheckpointId,
  ConnectionId,
  Digest,
  DraftId,
  EnvironmentId,
  MessageId,
  OperationId,
  ProviderSessionId,
  QueueEntryId,
  QueueId,
  ReplayCursor,
  RuleId,
  RunId,
  SupervisorId,
  WorkerId,
  WorkspaceId,
} from './ids.js'
import type { IsoDateTime } from './entities-base.js'
import type { NonSecretInteractionData } from './entities-interactions.js'

export type EnvironmentLifecycle =
  | 'requested'
  | 'creating'
  | 'ready'
  | 'detached'
  | 'expired'
  | 'failed'
  | 'destroying'
  | 'destroyed'
  | 'unknown'

export interface Placement {
  readonly provider: string
  readonly region?: string
  readonly account?: string
  readonly confidentialRequested: boolean
  readonly confidentialVerified: boolean
}

export interface EnvironmentRecord {
  readonly id: EnvironmentId
  readonly workspaceId: WorkspaceId
  readonly connectionId: ConnectionId
  readonly lifecycle: EnvironmentLifecycle
  readonly placement: Placement
  readonly repository?: string
  readonly gitRef?: string
  readonly workingDirectory?: string
  readonly image?: string
  readonly secretNames: readonly string[]
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface CheckpointRecord {
  readonly id: CheckpointId
  readonly sourceEnvironmentId: EnvironmentId
  readonly sourceBranchId: BranchId
  readonly sourceRunId?: RunId
  readonly throughMessageId?: MessageId
  readonly requestDigest: Digest
  readonly operationId: OperationId
  readonly stateDigest?: Digest
  readonly createdAt: IsoDateTime
  readonly status: 'requested' | 'ready' | 'failed' | 'unknown' | 'deleted'
}

export interface SupervisorRecord {
  readonly id: SupervisorId
  readonly rootRunId: RunId
  readonly status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface WorkerRecord {
  readonly id: WorkerId
  readonly supervisorId: SupervisorId
  readonly parentWorkerId?: WorkerId
  readonly runId?: RunId
  readonly status:
    | 'pending'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown'
  readonly title?: string
  readonly spendUsd?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly latencyMs?: number
  readonly logTail?: string
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface DraftRecord {
  readonly id: DraftId
  readonly branchId: BranchId
  readonly text: string
  readonly updatedAt: IsoDateTime
}

export type QueueEntryStatus = 'queued' | 'admitted' | 'removed' | 'failed'

export interface QueueEntryRecord {
  readonly id: QueueEntryId
  readonly queueId: QueueId
  readonly branchId: BranchId
  readonly text: string
  readonly position: number
  readonly operationId: OperationId
  readonly status: QueueEntryStatus
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface QueueRecord {
  readonly id: QueueId
  readonly branchId: BranchId
  readonly entryIds: readonly QueueEntryId[]
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface AutomationRuleMatcher {
  readonly interactionKind?: string
  readonly subjectType?: string
  readonly subjectValue?: string
  readonly profileDigest?: Digest
  readonly connectionId?: ConnectionId
  readonly runner?: string
  readonly workspaceId?: WorkspaceId
}

export interface AutomationRuleRecord {
  readonly id: RuleId
  readonly enabled: boolean
  readonly matcher: AutomationRuleMatcher
  readonly answer: NonSecretInteractionData
  readonly responseScope: 'once' | 'session' | 'persistent'
  readonly createdAt: IsoDateTime
  readonly expiresAt?: IsoDateTime
  readonly maximumUses?: number
  readonly uses: number
}

export type BindingStatus =
  | 'requested'
  | 'bound'
  | 'unavailable'
  | 'expired'
  | 'released'
  | 'unknown'

export interface BindingRecord {
  readonly id: BindingId
  readonly branchId: BranchId
  readonly runId?: RunId
  readonly connectionId: ConnectionId
  readonly providerSessionId?: ProviderSessionId
  readonly environmentId?: EnvironmentId
  readonly checkpointId?: CheckpointId
  readonly replayCursor?: ReplayCursor
  readonly boundaryDigest?: Digest
  readonly status: BindingStatus
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}
