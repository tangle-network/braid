import type { CredentialPort, CredentialRef } from '../../ports/credentials.js'
import type { SqliteDatabase } from './sqlite-driver.js'
import type { BoundedWriteQueue } from './sqlite-queue.js'

export interface SnapshotRuntime {
  readonly database: () => SqliteDatabase
  readonly credentials: CredentialPort
  readonly scopeId: () => string
  readonly writes: BoundedWriteQueue
  readonly durableBoundary?: (boundary: string) => void
}

export interface PreparedStateSnapshot {
  readonly key: Buffer
  readonly keyRef: CredentialRef
}

export interface SnapshotMetadata {
  readonly snapshotId: number
  readonly scopeId: string
  readonly generation: number
  readonly storageId: number
  readonly eventId: string
  readonly sequence: number
  readonly revision: number
  readonly stateChecksum: string
  readonly keyRef: CredentialRef
}

export interface SnapshotKeyRow {
  readonly scope_id?: unknown
  readonly generation?: unknown
  readonly credential_ref?: unknown
  readonly retired?: unknown
}
