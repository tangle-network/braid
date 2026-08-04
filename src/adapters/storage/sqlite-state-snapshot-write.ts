import type { CredentialRef } from '../../ports/credentials.js'
import type { StateSnapshot } from '../../ports/storage.js'
import { encryptPayload } from './sqlite-crypto.js'
import { StorageError } from './sqlite-errors.js'
import { asNumber, now } from './sqlite-rows.js'
import { assertJsonState, assertSnapshotChecksum } from './sqlite-state-snapshot-codec.js'
import { prepareSnapshotKey, removeSnapshotCredentials } from './sqlite-state-snapshot-keys.js'
import {
  beginSnapshotTransaction,
  commit,
  rollbackSnapshotTransaction,
} from './sqlite-state-snapshot-transaction.js'
import type { PreparedStateSnapshot, SnapshotRuntime } from './sqlite-state-snapshot-types.js'

export class SqliteStateSnapshotWriter {
  readonly #runtime: SnapshotRuntime

  constructor(runtime: SnapshotRuntime) {
    this.#runtime = runtime
  }

  async prepare(
    snapshot: StateSnapshot,
    createdRefs: CredentialRef[],
  ): Promise<PreparedStateSnapshot> {
    return prepareSnapshotKey(this.#runtime, snapshot, createdRefs)
  }

  writeUnsafe(snapshot: StateSnapshot, storageId: number, prepared: PreparedStateSnapshot): void {
    if (snapshot.scopeId !== this.#runtime.scopeId()) {
      throw new StorageError('STATE_SNAPSHOT_INVALID', 'Snapshot scope differs from storage scope')
    }
    assertSnapshotChecksum(snapshot)
    const database = this.#runtime.database()
    const event = database
      .prepare('SELECT event_id FROM braid_journal_events WHERE storage_id = ?')
      .get(storageId) as { readonly event_id?: unknown } | undefined
    if (!event || event.event_id !== snapshot.eventId) {
      throw new StorageError(
        'STATE_SNAPSHOT_UNBOUND',
        `State snapshot event ${snapshot.eventId} is not bound to storage row ${storageId}`,
      )
    }
    const ciphertext = encryptPayload(assertJsonState(snapshot.state), prepared.key)
    try {
      database
        .prepare(
          `INSERT INTO braid_state_snapshot_keys(
           scope_id, generation, credential_ref, retired, created_at
           ) VALUES (?, ?, ?, 0, ?)
           `,
        )
        .run(this.#runtime.scopeId(), snapshot.generation, prepared.keyRef, now())
      database
        .prepare(
          `INSERT INTO braid_state_snapshots(
             scope_id, generation, storage_id, event_id, journal_sequence,
             revision, state_checksum, key_ref, state_ciphertext, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           `,
        )
        .run(
          this.#runtime.scopeId(),
          snapshot.generation,
          storageId,
          snapshot.eventId,
          snapshot.sequence,
          snapshot.revision,
          snapshot.stateChecksum,
          prepared.keyRef,
          ciphertext,
          now(),
        )
    } finally {
      ciphertext.fill(0)
    }
  }

  async write(snapshot: StateSnapshot, pruneAfterCommit: () => Promise<void>): Promise<void> {
    const createdRefs: CredentialRef[] = []
    const prepared = await this.prepare(snapshot, createdRefs)
    let committed = false
    try {
      await this.#runtime.writes.run(async () => {
        const database = this.#runtime.database()
        beginSnapshotTransaction(database)
        try {
          const events = database
            .prepare(
              'SELECT storage_id FROM braid_journal_events WHERE event_id = ? ORDER BY storage_id',
            )
            .all(snapshot.eventId) as readonly { readonly storage_id?: unknown }[]
          const event = events[0]
          if (event === undefined)
            throw new StorageError('STATE_SNAPSHOT_UNBOUND', 'Snapshot event is not stored')
          if (events.length !== 1) {
            throw new StorageError(
              'STATE_SNAPSHOT_UNBOUND',
              `Snapshot event ${snapshot.eventId} is not uniquely bound to storage`,
            )
          }
          this.writeUnsafe(snapshot, asNumber(event.storage_id, 'storage_id'), prepared)
          commit(this.#runtime, database, 'state.snapshot')
          committed = true
          await pruneAfterCommit()
        } catch (error) {
          if (!committed) rollbackSnapshotTransaction(database)
          throw error
        }
      })
      createdRefs.length = 0
    } catch (error) {
      if (!committed) await removeSnapshotCredentials(this.#runtime, createdRefs)
      throw error
    } finally {
      prepared.key.fill(0)
    }
  }
}
