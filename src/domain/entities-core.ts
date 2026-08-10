import type {
  AgentProfile,
  AgentProfileValidationIssue,
  ReasoningEffort,
} from '@tangle-network/agent-interface'
import type {
  BranchId,
  BindingId,
  ConnectionId,
  ConversationId,
  CredentialRefId,
  Digest,
  DraftId,
  EnvironmentId,
  MessageId,
  MessagePartId,
  ProfileId,
  ProfileSnapshotId,
  QueueEntryId,
  QueueId,
  RunId,
  TurnId,
  WorkspaceId,
} from './ids.js'
import type { IsoDateTime, MissingHistoryRange } from './entities-base.js'
import type { RuntimeMessageFields } from './runtime-projection.js'

export interface TurnUsage {
  readonly input: number
  readonly output: number
  /** False means the numeric token values are only an observed floor. */
  readonly tokensKnown?: false
  readonly reasoning?: number
  readonly costUsd?: number
  /** False means costUsd is absent or only an observed floor. */
  readonly usdKnown?: false
  /** A separately labelled estimate. This is never billed spend. */
  readonly estimatedCostUsd?: number
  readonly promptCache?: Readonly<Record<string, number>>
  readonly latencyMs?: number
  readonly model?: string
}

export interface WorkspaceRecord {
  readonly id: WorkspaceId
  readonly root: string
  readonly repositoryIdentity?: string
  readonly trusted: boolean
  readonly trustDigest?: Digest
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export type ProfileSourceKind = 'inline' | 'file' | 'package' | 'catalog' | 'github'

export interface ProfileSource {
  readonly kind: ProfileSourceKind
  readonly reference: string
  readonly revision?: string
}

export interface ProfileValidation {
  readonly ok: boolean
  readonly issues: readonly AgentProfileValidationIssue[]
}

export interface ProfileRecord {
  readonly id: ProfileId
  readonly source: ProfileSource
  readonly profile: Readonly<AgentProfile>
  readonly digest: Digest
  readonly validation: ProfileValidation
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface ProfileSnapshotRecord {
  readonly id: ProfileSnapshotId
  readonly profileId?: ProfileId
  readonly source: ProfileSource
  readonly profile: Readonly<AgentProfile>
  readonly digest: Digest
  readonly createdAt: IsoDateTime
}

export type ConnectionKind = 'cli-bridge' | 'tangle-inference' | 'tangle-sandbox'

export type ConnectionHealth =
  | { readonly status: 'unknown' }
  | { readonly status: 'healthy'; readonly checkedAt: IsoDateTime; readonly message?: string }
  | { readonly status: 'unauthorized'; readonly checkedAt: IsoDateTime; readonly message?: string }
  | { readonly status: 'unreachable'; readonly checkedAt: IsoDateTime; readonly message?: string }
  | { readonly status: 'incompatible'; readonly checkedAt: IsoDateTime; readonly message?: string }
  | { readonly status: 'rate-limited'; readonly checkedAt: IsoDateTime; readonly message?: string }

export type ConnectionModelVerificationStatus =
  | 'unverified'
  | 'verified'
  | 'not-configured'
  | 'unauthorized'
  | 'unreachable'
  | 'incompatible'
  | 'rate-limited'

export interface ConnectionModelVerification {
  readonly model: string
  readonly status: ConnectionModelVerificationStatus
  readonly checkedAt: IsoDateTime
  readonly code?: string
  readonly httpStatus?: number
  readonly message?: string
}

export interface CredentialReference {
  readonly id: CredentialRefId
  readonly label: string
  readonly facility:
    | 'macos-keychain'
    | 'linux-secret-service'
    | 'windows-credential-manager'
    | 'protected-file'
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface ConnectionRecord {
  readonly id: ConnectionId
  readonly workspaceId?: WorkspaceId
  readonly kind: ConnectionKind
  readonly name: string
  readonly endpoint?: string
  readonly credentialRef?: CredentialRefId
  readonly providerOptions: ConnectionTransportOptions
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
  readonly lastHealth: ConnectionHealth
  readonly lastModelVerification?: ConnectionModelVerification
}

/**
 * Braid stores only transport metadata and capability hints here.
 * Provider-native configuration belongs to the provider package and is never
 * copied into the durable product state.
 */
export interface ConnectionTransportOptions {
  readonly transport?: 'local' | 'https' | 'websocket' | 'stdio'
  readonly endpoint?: string
  readonly region?: string
  readonly account?: string
  readonly capabilityHints?: readonly string[]
}

export interface RetentionPolicy {
  readonly completedRunDays?: number
  readonly traceDays?: number
  readonly analysisDays?: number
  readonly toolOutputBytes?: number
  readonly cacheBytes?: number
}

export interface ConversationRecord {
  readonly id: ConversationId
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly activeBranchId: BranchId
  readonly profileId?: ProfileId
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
  readonly archived: boolean
  readonly deletedAt?: IsoDateTime
  readonly retention: RetentionPolicy
}

export interface BranchBoundary {
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly throughMessageId?: MessageId
  readonly throughTurnId?: TurnId
}

export interface RunOverrides {
  readonly runner?: string
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly mode?: string
}

export type BranchStatus = 'active' | 'preparing' | 'failed-preparation' | 'archived'

export interface BranchRecord {
  readonly id: BranchId
  readonly conversationId: ConversationId
  readonly source?: BranchBoundary
  readonly profileId?: ProfileId
  readonly profileSnapshotId?: ProfileSnapshotId
  readonly connectionId?: ConnectionId
  readonly overrides: RunOverrides
  readonly bindingId?: BindingId
  readonly environmentId?: EnvironmentId
  readonly draftId: DraftId
  readonly queueId: QueueId
  readonly tipMessageId?: MessageId
  readonly status: BranchStatus
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export type TurnStatus =
  | 'queued'
  | 'prepared'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export interface TurnRecord {
  readonly id: TurnId
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly userMessageId: MessageId
  readonly runIds: readonly RunId[]
  readonly selectedRunId?: RunId
  readonly queueEntryId?: QueueEntryId
  readonly status: TurnStatus
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export type MessageRole = 'user' | 'assistant'
export type MessageStatus =
  | 'incomplete'
  | 'streaming'
  | 'complete'
  | 'failed'
  | 'aborted'
  | 'cancelled'
  | 'blocked'
  | 'expired'
  | 'unknown'
  | 'redacted'

export interface MessageRecord extends RuntimeMessageFields {
  readonly id: MessageId
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly role: MessageRole
  readonly text: string
  readonly partIds: readonly MessagePartId[]
  readonly status: MessageStatus
  readonly turnId?: TurnId
  readonly runId?: RunId
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
  readonly complete: boolean
  readonly missingHistory?: MissingHistoryRange
}
