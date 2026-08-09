import type { ConversationId, EventId, OperationId, RunId, WorkspaceId } from '../domain/ids.js'
import type { MaterializedStateSnapshot } from '../domain/materialized-state-snapshot.js'
import type { CredentialPort, CredentialRef } from './credentials.js'

export const PROJECTION_SCHEMA_VERSION = 3

export type {
  AnalysisId,
  AnalysisRunId,
  ArtifactId,
  AttachmentId,
  BindingId,
  BranchId,
  CheckpointId,
  CitationId,
  ConnectionId,
  ConversationId,
  CredentialRefId,
  Digest,
  DraftId,
  EffectId,
  EnvironmentId,
  EventId,
  FeedbackDecisionId,
  GraphEdgeId,
  GraphNodeId,
  InteractionId,
  MessageId,
  MessagePartId,
  OperationId,
  ProfileId,
  ProfileSnapshotId,
  ProviderSessionId,
  QueueEntryId,
  QueueId,
  ReceiptId,
  ReplayCursor,
  RuleId,
  RunId,
  SupervisorId,
  TraceId,
  TurnId,
  WorkerId,
  WorkspaceId,
} from '../domain/ids.js'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export type PayloadState = 'available' | 'redacted' | 'deleted' | 'content-key-unavailable'

export interface JournalEvent {
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
  readonly runId: RunId
  readonly eventId: EventId
  /** Provider identity is scoped to the provider session, not Braid's journal. */
  readonly providerEventId?: string
  readonly sequence: number
  readonly kind: string
  readonly payload: JsonValue
  readonly occurredAt: string
  readonly cursor?: string
  readonly operationId?: OperationId
  readonly terminal?: boolean
  readonly receivedAt?: string
}

export interface StoredJournalEvent extends Omit<JournalEvent, 'payload' | 'receivedAt'> {
  readonly payload: JsonValue | null
  readonly payloadState: PayloadState
  readonly receivedAt: string
  readonly payloadChecksum: string
  readonly redacted: boolean
  readonly tombstoneReason?: string
}

/** An encrypted, materialized projection bound to one committed journal event. */
export type StateSnapshot = MaterializedStateSnapshot

export interface StoredStateSnapshot extends StateSnapshot {
  readonly storageId: number
}

export interface MissingHistory {
  readonly runId: RunId
  readonly fromSequence: number
  readonly toSequence: number
}

export interface AppendResult {
  readonly acceptedEventIds: readonly EventId[]
  readonly duplicateEventIds: readonly EventId[]
  readonly missingHistory: readonly MissingHistory[]
  readonly projectionChecksum: string
}

export interface ReplayResult {
  readonly events: readonly StoredJournalEvent[]
  readonly complete: boolean
  readonly missingHistory: readonly MissingHistory[]
  readonly lastSequence: number
  readonly lastCursor?: string
}

export interface ProjectionRun {
  readonly runId: RunId
  readonly conversationId: ConversationId
  readonly lastSequence: number
  readonly lastCursor: string | null
  readonly missingFrom: number | null
  readonly missingTo: number | null
  readonly terminal: boolean
}

export interface ProjectionSnapshot {
  readonly schemaVersion: number
  readonly eventCount: number
  readonly revision: number
  readonly eventIds: readonly EventId[]
  readonly runs: readonly ProjectionRun[]
  readonly checksum: string
}

export type EffectStatus =
  | 'pending'
  | 'acknowledged'
  | 'failed'
  | 'unknown'
  | 'conflict'
  | 'terminal'

export interface OperationIntent {
  readonly operationId: OperationId
  readonly kind: string
  readonly request: JsonValue
  readonly requestDigest: string
  readonly createdAt?: string
}

export interface OperationRecord extends OperationIntent {
  readonly status: EffectStatus
  readonly result?: JsonValue
  readonly updatedAt: string
}

export interface OperationReservation {
  readonly record: OperationRecord
  readonly created: boolean
}

export interface IntegrityReport {
  readonly ok: boolean
  readonly encryption: 'verified' | 'unavailable' | 'not-applicable'
  readonly quickCheck: boolean
  readonly fullCheck: boolean
  readonly foreignKeys: boolean
  readonly wal: boolean
  readonly schemaVersion: number
  readonly errors: readonly string[]
}

export interface MigrationReport {
  readonly fromVersion: number
  readonly toVersion: number
  readonly migrated: boolean
  readonly backupPath?: string
}

export interface RetentionReport {
  readonly redactedEvents: number
  readonly deletedConversations: readonly ConversationId[]
}

export interface RedactionReport {
  readonly conversationId: ConversationId
  readonly redactedEventId: EventId
  readonly rewrittenEvents: number
  readonly newContentKeyRef: CredentialRef
}

export interface DestructionReport {
  readonly conversationId: ConversationId
  readonly destroyed: boolean
  readonly retainedCiphertext: boolean
}

export interface BackupReport {
  readonly path: string
  readonly bytes: number
  readonly encrypted: boolean
}

export interface RestoreReport {
  readonly path: string
  readonly restored: boolean
  readonly integrity: IntegrityReport
}

export interface StorageArtifacts {
  readonly database: string
  readonly wal: string
  readonly sharedMemory: string
  readonly backups: readonly string[]
}

export interface NonTerminalRun {
  readonly runId: RunId
  readonly conversationId: ConversationId
  readonly lastSequence: number
  readonly lastCursor: string | null
  readonly missingHistory: MissingHistory | null
}

export interface StoragePort {
  append(events: readonly JournalEvent[]): Promise<AppendResult>
  appendWithSnapshot?(input: {
    readonly events: readonly JournalEvent[]
    readonly snapshot: StateSnapshot
  }): Promise<AppendResult>
  replay(input: { readonly runId: RunId; readonly afterSequence?: number }): Promise<ReplayResult>
  events(input?: {
    readonly workspaceId?: WorkspaceId
    readonly conversationId?: ConversationId
    readonly runId?: RunId
    readonly afterStorageId?: number
  }): Promise<readonly StoredJournalEvent[]>
  snapshotScopeId?(): string
  latestStateSnapshot?(): Promise<StoredStateSnapshot | null>
  writeStateSnapshot?(snapshot: StateSnapshot): Promise<void>
  runSequences?(): Promise<readonly ProjectionRun[]>
  projection(): Promise<ProjectionSnapshot>
  rebuild(operation: OperationIntent): Promise<ProjectionSnapshot>
  projectionChecksum(): Promise<string>
  reserveOperation(intent: OperationIntent): Promise<OperationReservation>
  completeOperation(input: {
    readonly operationId: OperationId
    readonly requestDigest: string
    readonly status: Exclude<EffectStatus, 'pending' | 'conflict'>
    readonly result?: JsonValue
    readonly updatedAt?: string
  }): Promise<OperationRecord>
  recordOperationConflict(input: {
    readonly operationId: OperationId
    readonly requestDigest: string
    readonly attemptedDigest: string
    readonly occurredAt?: string
  }): Promise<void>
  operation(operationId: OperationId): Promise<OperationRecord | null>
  integrity(): Promise<IntegrityReport>
  migrate(operation: OperationIntent): Promise<MigrationReport>
  backup(input: {
    readonly path: string
    readonly operation: OperationIntent
  }): Promise<BackupReport>
  restore(input: {
    readonly path: string
    readonly operation: OperationIntent
  }): Promise<RestoreReport>
  applyRetention(input: {
    readonly before: string
    readonly conversationId?: ConversationId
    readonly operation: OperationIntent
  }): Promise<RetentionReport>
  redact(input: {
    readonly conversationId: ConversationId
    readonly eventId: EventId
    readonly reason: string
    readonly operation: OperationIntent
  }): Promise<RedactionReport>
  destroyConversation(input: {
    readonly conversationId: ConversationId
    readonly reason: string
    readonly operation: OperationIntent
  }): Promise<DestructionReport>
  compact(operation: OperationIntent): Promise<void>
  artifacts(): StorageArtifacts
  reconcileNonTerminalRuns(): Promise<readonly NonTerminalRun[]>
  close(): Promise<void>
}

export interface StorageFactoryOptions {
  readonly credentialStore: CredentialPort
  readonly maxEventsPerTransaction?: number
  readonly maxPayloadBytesPerTransaction?: number
  readonly maxQueuedTransactions?: number
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}
