import type { CredentialPort, CredentialRef } from '../../ports/credentials.js'
import type { HeadlessKeySource } from '../credentials/headless-key.js'
import type { SqliteDatabase, SqliteDatabaseFactory } from './sqlite-driver.js'

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000
export const DEFAULT_MAX_EVENTS = 256
export const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024
export const DEFAULT_MAX_QUEUED_TRANSACTIONS = 64
export const RESTORE_MANIFEST_VERSION = 1

export interface MigrationHooks {
  readonly beforeVersionCommit?: (version: number) => void
}

export type DurableBoundaryHook = (boundary: string) => void

export interface SqliteStorageOptions {
  readonly path: string
  readonly workspaceRoot?: string
  readonly credentialStore: CredentialPort
  readonly databaseKeyRef?: CredentialRef
  readonly databaseKeySource?: HeadlessKeySource
  readonly busyTimeoutMs?: number
  readonly maxEventsPerTransaction?: number
  readonly maxPayloadBytesPerTransaction?: number
  readonly maxQueuedTransactions?: number
  readonly backupDirectory?: string
  readonly migrationHooks?: MigrationHooks
  readonly durableBoundaryHook?: DurableBoundaryHook
  /** Test/packaging seam. It must still expose key/rekey and is never a plaintext fallback. */
  readonly databaseFactory?: SqliteDatabaseFactory
}

export interface SqliteStorageInput {
  readonly path: string
  readonly workspaceRoot?: string
  readonly credentials: CredentialPort
  readonly databaseKeyRef: CredentialRef
  readonly databaseKey: Buffer
  readonly databaseFactory: SqliteDatabaseFactory
  readonly busyTimeoutMs: number
  readonly maxEvents: number
  readonly maxPayloadBytes: number
  readonly maxQueuedTransactions: number
  readonly backupDirectory: string
  readonly migrationHooks?: MigrationHooks
  readonly durableBoundaryHook?: DurableBoundaryHook
  readonly database: SqliteDatabase
}

export interface SqliteEventRow extends Record<string, unknown> {
  readonly storage_id: number | bigint
  readonly workspace_id: string
  readonly conversation_id: string
  readonly run_id: string
  readonly event_id: string
  readonly provider_event_id: string | null
  readonly run_sequence: number
  readonly kind: string
  readonly cursor: string | null
  readonly operation_id: string | null
  readonly payload: Buffer
  readonly payload_checksum: string
  readonly occurred_at: string
  readonly received_at: string
  readonly terminal: number
  readonly redacted: number
}

export interface CursorRow extends Record<string, unknown> {
  readonly run_id: string
  readonly conversation_id: string
  readonly last_sequence: number
  readonly last_cursor: string | null
  readonly missing_from: number | null
  readonly missing_to: number | null
  readonly terminal: number
}

export interface OperationRow extends Record<string, unknown> {
  readonly operation_id: string
  readonly operation_kind: string
  readonly request_digest: string
  readonly request_json: string
  readonly status: 'pending' | 'acknowledged' | 'failed' | 'unknown' | 'conflict' | 'terminal'
  readonly result_json: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface QueueTask<T> {
  readonly operation: () => Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
}
