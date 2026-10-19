import type {
  AgentProfile,
  AgentProfileValidationIssue,
  HarnessType,
  ReasoningEffort,
  ResourceRequest,
} from '@tangle-network/agent-interface'
import type { IsoDateTime, MissingHistoryRange } from './entities-base.js'
import type {
  BindingId,
  BranchId,
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
import type { RuntimeMessageFields } from './runtime-projection.js'

export interface TurnUsage {
  readonly input: number
  readonly output: number
  /** Exact provider inference requests represented by this usage record. */
  readonly calls?: number
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
  /** Canonical identity before metadata is removed from the durable profile. */
  readonly executionDigest?: Digest
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

export type ConnectionKind = 'cli-bridge' | 'tangle-inference' | 'tangle-sandbox' | 'agent-provider'

/**
 * Non-secret trust constraints for a confidential Tangle connection.
 *
 * The selected connection owns this policy so startup and restart use the
 * same explicit allowlists without loading executable verifier modules.
 */
export interface ConfidentialAttestationTrustPolicy {
  readonly acceptedMeasurements: readonly `sha256:${string}`[]
  readonly acceptedPolicyIds: readonly string[]
  readonly maxAgeSeconds: number
}

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
  readonly confidentialAttestationPolicy?: ConfidentialAttestationTrustPolicy
  readonly providerOptions: ConnectionTransportOptions
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
  readonly lastHealth: ConnectionHealth
  readonly lastModelVerification?: ConnectionModelVerification
}

export const DEFAULT_RETAINED_IDLE_TTL_SECONDS = 1_800
export const MIN_RETAINED_IDLE_TTL_SECONDS = 60
export const MAX_RETAINED_IDLE_TTL_SECONDS = 604_800
export const MIN_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS = 1
export const MAX_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS = 86_400

/**
 * Braid stores only transport metadata and capability hints here.
 * Provider-native configuration belongs to the provider package and is never
 * copied into the durable product state.
 */
export interface ConnectionTransportOptions {
  /** Exact name in the connection-scoped Runtime provider registry. */
  readonly provider?: string
  readonly transport?: 'local' | 'https' | 'websocket' | 'stdio'
  readonly endpoint?: string
  readonly region?: string
  readonly account?: string
  readonly capabilityHints?: readonly string[]
  /** Cloud environment ownership policy. Omitted connections remain ephemeral. */
  readonly lifecycle?: 'ephemeral' | 'retained'
  /** Idle expiry for a retained cloud environment. */
  readonly idleTtlSeconds?: number
  /** Compute requested for every cloud environment this connection creates. */
  readonly resources?: ConnectionResourceRequest
  /** Stored Tangle Sandbox secret names granted to every environment; values never appear. */
  readonly secrets?: readonly string[]
  /** Where a subscription profile gets its model seat; a reference, never a credential. */
  readonly modelCredentials?: ConnectionModelCredentials
  /** Tangle Router provider routing for every model call a Tangle Sandbox environment or Tangle inference connection makes. */
  readonly routing?: ConnectionRouterRouting
}

/**
 * Router provider routing: `only` names the upstream providers that may answer,
 * `allowFallbacks: false` forbids a substitute provider, and `requireModel` forbids a substitute
 * model. A Tangle Sandbox fixes it at create (Router-backed OpenCode only; other runners refuse
 * it); a Tangle inference connection sends it on every Router request.
 */
export interface ConnectionRouterRouting {
  readonly only?: readonly string[]
  readonly allowFallbacks?: boolean
  readonly requireModel?: boolean
}

/** Provider-neutral compute request; provider-native resource options are never stored. */
export type ConnectionResourceRequest = Readonly<Omit<ResourceRequest, 'providerOptions'>>

/**
 * A model-seat reference for a Tangle Sandbox connection.
 *
 * The command form names a resolver that the Tangle provider runs at environment creation.
 * The resolver registers the seat as a stored Sandbox secret and returns its public reference.
 * The static form names a seat that is already stored.
 */
export type ConnectionModelCredentials =
  | ConnectionModelCredentialCommand
  | ConnectionModelCredentialStoredSeat

export interface ConnectionModelCredentialCommand {
  /** Executable and arguments, run directly without a shell. */
  readonly command: readonly string[]
  /** Variables in Braid's environment that the command reads; Braid refuses to run while one is unset. */
  readonly env?: readonly string[]
  /** Variable that receives this connection's own Sandbox key, so the seat lands in the same account. */
  readonly connectionKeyEnv?: string
  /** Variable that receives this connection's Sandbox endpoint. */
  readonly connectionEndpointEnv?: string
}

export interface ConnectionModelCredentialStoredSeat {
  readonly cliAuth: {
    /** Account label the stored seat belongs to. */
    readonly account: string
    /** Stored Sandbox secret name that holds the seat. */
    readonly secretEnv: string
    readonly format: 'token' | 'bundle' | 'files'
  }
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
  readonly runner?: HarnessType
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
