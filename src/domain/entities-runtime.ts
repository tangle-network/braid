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
import type { IsoDateTime, NonSecretInteractionData } from './entities-base.js'
import type {
  ExecutionEnvironmentObservation,
  EnvironmentGpuObservation,
  EnvironmentResourceRequest,
  EnvironmentResourceSample,
  SandboxAccountObservation,
} from './execution-observation.js'

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
  readonly kind?: ExecutionEnvironmentObservation['kind']
  readonly providerEnvironmentId?: string
  readonly lifecycleMode?: ExecutionEnvironmentObservation['lifecycleMode']
  readonly cleanup?: ExecutionEnvironmentObservation['cleanup']
  readonly continuity?: ExecutionEnvironmentObservation['continuity']
  readonly location?: ExecutionEnvironmentObservation['location']
  readonly runtimeEndpointHost?: string
  readonly machineId?: string
  readonly requestedRegion?: string
  readonly storagePersistence?: ExecutionEnvironmentObservation['storagePersistence']
  readonly requestedResources?: EnvironmentResourceRequest
  readonly resourceSample?: EnvironmentResourceSample
  readonly gpu?: EnvironmentGpuObservation
  readonly accountUsage?: SandboxAccountObservation
  readonly unavailableTelemetry?: readonly string[]
  readonly repository?: string
  readonly gitRef?: string
  readonly workingDirectory?: string
  readonly image?: string
  readonly secretNames: readonly string[]
  readonly createdAt: IsoDateTime
  readonly startedAt?: IsoDateTime
  readonly lastActivityAt?: IsoDateTime
  readonly expiresAt?: IsoDateTime
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

export interface RuntimeUsageRecord {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly spendUsd: number
  readonly latencyMs: number
  readonly iterations?: number
  /** Runtime's current monitor omits completeness flags, so these totals are an observed floor. */
  readonly completeness: 'complete' | 'observed-floor' | 'unknown'
}

export interface SupervisorRecord {
  readonly id: SupervisorId
  /** Opaque identifier owned by agent-runtime. Never use it as Braid entity identity. */
  readonly runtimeId: string
  /** Workspace root used to read and control this runtime supervisor. */
  readonly runtimeRoot: string
  /** Present only when Braid has an explicit runtime-supervisor to run binding. */
  readonly rootRunId?: RunId
  readonly status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly title?: string
  readonly driverModel?: string
  readonly workerModel?: string
  readonly driverUsage?: RuntimeUsageRecord
  readonly totalUsage?: RuntimeUsageRecord
  readonly workerCount?: number
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface WorkerRecord {
  readonly id: WorkerId
  /** Opaque identifier owned by agent-runtime. Required for runtime control operations. */
  readonly runtimeId: string
  readonly supervisorId: SupervisorId
  /** Provider parent reference, including when no Braid worker resolves it. */
  readonly parentRuntimeRef?: string
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
  readonly runner?: string
  readonly spendUsd?: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly latencyMs?: number
  readonly usageCompleteness?: RuntimeUsageRecord['completeness']
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
