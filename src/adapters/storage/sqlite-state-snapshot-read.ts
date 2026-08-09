import { CredentialError, type CredentialRef } from '../../ports/credentials.js'
import type { StoredStateSnapshot } from '../../ports/storage.js'
import { decryptPayload } from './sqlite-crypto.js'
import { StorageError } from './sqlite-errors.js'
import { asBuffer, asString } from './sqlite-rows.js'
import {
  asCredentialRef,
  asPositiveNumber,
  materializedSnapshotFromPayload,
  metadataFromRow,
  metadataFromRowSafe,
} from './sqlite-state-snapshot-codec.js'
import { removeSnapshotCredentials, resolveSnapshotKey } from './sqlite-state-snapshot-keys.js'
import {
  beginSnapshotTransaction,
  commit,
  rollbackSnapshotTransaction,
} from './sqlite-state-snapshot-transaction.js'
import type {
  SnapshotKeyRow,
  SnapshotMetadata,
  SnapshotRuntime,
} from './sqlite-state-snapshot-types.js'

export class SqliteStateSnapshotReader {
  readonly #runtime: SnapshotRuntime

  constructor(runtime: SnapshotRuntime) {
    this.#runtime = runtime
  }

  async latest(): Promise<StoredStateSnapshot | null> {
    const scopeId = this.#runtime.scopeId()
    for (;;) {
      const row = this.#runtime
        .database()
        .prepare(
          `SELECT snapshot_id, scope_id, generation, storage_id, event_id,
                  journal_sequence, revision, state_checksum, key_ref
           FROM braid_state_snapshots
           WHERE scope_id = ?
           ORDER BY generation DESC, snapshot_id DESC
           LIMIT 1`,
        )
        .get(scopeId) as Record<string, unknown> | undefined
      if (!row) return null
      let metadata: SnapshotMetadata | null = null
      try {
        metadata = metadataFromRow(row)
        return await this.read(metadata)
      } catch (error) {
        if (!isSnapshotCorruption(error)) throw error
        await this.quarantine(row, metadata ?? metadataFromRowSafe(row))
      }
    }
  }

  private async read(metadata: SnapshotMetadata): Promise<StoredStateSnapshot> {
    const scopeId = this.#runtime.scopeId()
    if (metadata.scopeId !== scopeId)
      throw new StorageError('STATE_SNAPSHOT_INVALID', 'Snapshot scope differs')
    const database = this.#runtime.database()
    const key = database
      .prepare(
        `SELECT credential_ref, retired
         FROM braid_state_snapshot_keys
         WHERE scope_id = ? AND generation = ?`,
      )
      .get(scopeId, metadata.generation) as SnapshotKeyRow | undefined
    if (!key || Number(key.retired) === 1 || key.credential_ref !== metadata.keyRef) {
      throw new StorageError(
        'STATE_SNAPSHOT_KEY_UNAVAILABLE',
        'Snapshot generation key is unavailable',
      )
    }
    const row = database
      .prepare('SELECT state_ciphertext FROM braid_state_snapshots WHERE snapshot_id = ?')
      .get(metadata.snapshotId) as { readonly state_ciphertext?: unknown } | undefined
    if (!row) throw new StorageError('STATE_SNAPSHOT_INVALID', 'Snapshot payload is missing')
    const secret = await resolveSnapshotKey(this.#runtime, metadata.keyRef)
    try {
      const payload = decryptPayload(asBuffer(row.state_ciphertext, 'state_ciphertext'), secret)
      const candidate = materializedSnapshotFromPayload(metadata, payload)
      const event = database
        .prepare('SELECT event_id FROM braid_journal_events WHERE storage_id = ?')
        .get(metadata.storageId) as { readonly event_id?: unknown } | undefined
      if (!event || event.event_id !== metadata.eventId) {
        throw new StorageError('STATE_SNAPSHOT_UNBOUND', 'Snapshot event binding is invalid')
      }
      return { ...candidate, storageId: metadata.storageId }
    } finally {
      secret.fill(0)
    }
  }

  private async quarantine(
    row: Record<string, unknown>,
    metadata: SnapshotMetadata | null,
  ): Promise<void> {
    const database = this.#runtime.database()
    const snapshotId = asPositiveNumber(row.snapshot_id)
    if (snapshotId === null) {
      throw new StorageError(
        'STATE_SNAPSHOT_INVALID',
        'Invalid snapshot identity cannot be quarantined safely',
      )
    }
    const scopeId = asString(row.scope_id, 'scope_id')
    const generation = asPositiveNumber(row.generation)
    const keyRefs = new Set<CredentialRef>()
    if (metadata?.keyRef !== undefined) keyRefs.add(metadata.keyRef)
    const rowKeyRef = asCredentialRef(row.key_ref)
    if (rowKeyRef !== null) keyRefs.add(rowKeyRef)
    if (generation !== null) {
      const keyRow = database
        .prepare(
          'SELECT credential_ref FROM braid_state_snapshot_keys WHERE scope_id = ? AND generation = ?',
        )
        .get(scopeId, generation) as SnapshotKeyRow | undefined
      const storedKeyRef = asCredentialRef(keyRow?.credential_ref)
      if (storedKeyRef !== null) keyRefs.add(storedKeyRef)
    }
    await this.#runtime.writes.run(async () => {
      beginSnapshotTransaction(database)
      try {
        database.prepare('DELETE FROM braid_state_snapshots WHERE snapshot_id = ?').run(snapshotId)
        if (generation !== null) {
          database
            .prepare(
              'UPDATE braid_state_snapshot_keys SET retired = 1 WHERE scope_id = ? AND generation = ?',
            )
            .run(scopeId, generation)
        }
        commit(this.#runtime, database, 'state.snapshot.quarantine')
      } catch (error) {
        rollbackSnapshotTransaction(database)
        throw error
      }
      await removeSnapshotCredentials(this.#runtime, [...keyRefs])
      beginSnapshotTransaction(database)
      try {
        if (generation !== null) {
          database
            .prepare(
              `DELETE FROM braid_state_snapshot_keys AS key_row
               WHERE key_row.scope_id = ? AND key_row.generation = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM braid_state_snapshots AS snapshot_row
                   WHERE snapshot_row.key_ref = key_row.credential_ref
                 )`,
            )
            .run(scopeId, generation)
        }
        commit(this.#runtime, database, 'state.snapshot.quarantine.cleanup')
      } catch (error) {
        rollbackSnapshotTransaction(database)
        throw error
      }
    })
  }
}

const QUARANTINED_STORAGE_CODES = new Set([
  'PAYLOAD_DECRYPT_FAILED',
  'PAYLOAD_VERSION',
  'STATE_SNAPSHOT_INVALID',
  'STATE_SNAPSHOT_KEY_INVALID',
  'STATE_SNAPSHOT_KEY_UNAVAILABLE',
  'STATE_SNAPSHOT_UNBOUND',
  'STORAGE_ROW_INVALID',
])

function isSnapshotCorruption(error: unknown): boolean {
  if (error instanceof CredentialError) {
    return error.code === 'CREDENTIAL_NOT_FOUND' || error.code === 'INVALID_CREDENTIAL_REF'
  }
  return error instanceof StorageError && QUARANTINED_STORAGE_CODES.has(error.code)
}
