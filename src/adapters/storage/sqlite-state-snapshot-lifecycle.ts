import type { CredentialRef } from '../../ports/credentials.js'
import { StorageError } from './sqlite-errors.js'
import { asNumber, asString } from './sqlite-rows.js'
import { asCredentialRef } from './sqlite-state-snapshot-codec.js'
import {
  destroySnapshotCredentialsBeforeMutation,
  removeSnapshotCredentials,
} from './sqlite-state-snapshot-keys.js'
import {
  beginSnapshotTransaction,
  commit,
  rollbackSnapshotTransaction,
} from './sqlite-state-snapshot-transaction.js'
import type { SnapshotKeyRow, SnapshotRuntime } from './sqlite-state-snapshot-types.js'

export class SqliteStateSnapshotLifecycle {
  readonly #runtime: SnapshotRuntime

  constructor(runtime: SnapshotRuntime) {
    this.#runtime = runtime
  }

  async prune(): Promise<void> {
    await this.#runtime.writes.run(() => this.pruneUnsafe())
  }

  async pruneAfterCommitUnsafe(): Promise<void> {
    try {
      await this.pruneUnsafe()
    } catch {
      // The snapshot or event is already durable; startup retries cleanup.
    }
  }

  async discardCredentials(refs: readonly CredentialRef[]): Promise<void> {
    await removeSnapshotCredentials(this.#runtime, refs)
  }

  async pruneUnsafe(): Promise<void> {
    const database = this.#runtime.database()
    const scopeId = this.#runtime.scopeId()
    const rows = database
      .prepare(
        `SELECT snapshot_id, scope_id, generation, key_ref
         FROM braid_state_snapshots
         WHERE scope_id = ?
         ORDER BY generation DESC, snapshot_id DESC
         LIMIT -1 OFFSET 2`,
      )
      .all(scopeId) as readonly Record<string, unknown>[]
    if (rows.length === 0) return
    const retiring = rows.map((row) => ({
      snapshotId: asNumber(row.snapshot_id, 'snapshot_id'),
      generation: asNumber(row.generation, 'generation'),
      keyRef: asCredentialRef(row.key_ref),
    }))
    if (retiring.some((row) => row.keyRef === null)) {
      throw new StorageError(
        'STATE_SNAPSHOT_INVALID',
        'Snapshot generation key reference is invalid',
      )
    }
    beginSnapshotTransaction(database)
    try {
      for (const row of retiring) {
        database
          .prepare('DELETE FROM braid_state_snapshots WHERE snapshot_id = ?')
          .run(row.snapshotId)
        database
          .prepare(
            'UPDATE braid_state_snapshot_keys SET retired = 1 WHERE scope_id = ? AND generation = ?',
          )
          .run(scopeId, row.generation)
      }
      commit(this.#runtime, database, 'state.snapshot.prune')
    } catch (error) {
      rollbackSnapshotTransaction(database)
      throw error
    }
    await removeSnapshotCredentials(
      this.#runtime,
      retiring.flatMap((row) => (row.keyRef === null ? [] : [row.keyRef])),
    )
    beginSnapshotTransaction(database)
    try {
      database
        .prepare(
          `DELETE FROM braid_state_snapshot_keys AS key_row
           WHERE key_row.scope_id = ? AND key_row.retired = 1
             AND NOT EXISTS (
               SELECT 1 FROM braid_state_snapshots AS snapshot_row
               WHERE snapshot_row.key_ref = key_row.credential_ref
             )`,
        )
        .run(scopeId)
      commit(this.#runtime, database, 'state.snapshot.keys.remove')
    } catch (error) {
      rollbackSnapshotTransaction(database)
      throw error
    }
  }

  async destroyKeysBeforeMutation(): Promise<void> {
    const database = this.#runtime.database()
    const refs = new Set<CredentialRef>()
    const keyRows = database
      .prepare(
        'SELECT credential_ref FROM braid_state_snapshot_keys WHERE scope_id = ? AND retired = 0',
      )
      .all(this.#runtime.scopeId()) as readonly SnapshotKeyRow[]
    for (const row of keyRows) {
      const ref = asCredentialRef(row.credential_ref)
      if (ref !== null) refs.add(ref)
    }
    const snapshotRows = database
      .prepare('SELECT key_ref FROM braid_state_snapshots WHERE scope_id = ?')
      .all(this.#runtime.scopeId()) as readonly Record<string, unknown>[]
    for (const row of snapshotRows) {
      const ref = asCredentialRef(row.key_ref)
      if (ref !== null) refs.add(ref)
    }
    await destroySnapshotCredentialsBeforeMutation(this.#runtime, [...refs])
  }

  invalidateUnsafe(): void {
    const database = this.#runtime.database()
    const scopeId = this.#runtime.scopeId()
    database.prepare('DELETE FROM braid_state_snapshots WHERE scope_id = ?').run(scopeId)
    database
      .prepare('UPDATE braid_state_snapshot_keys SET retired = 1 WHERE scope_id = ?')
      .run(scopeId)
  }

  async finishInvalidationUnsafe(): Promise<void> {
    const database = this.#runtime.database()
    const refs = database
      .prepare(
        'SELECT credential_ref FROM braid_state_snapshot_keys WHERE scope_id = ? AND retired = 1',
      )
      .all(this.#runtime.scopeId()) as readonly SnapshotKeyRow[]
    const parsedRefs = refs.flatMap((row) => {
      const ref = asCredentialRef(row.credential_ref)
      return ref === null ? [] : [ref]
    })
    await removeSnapshotCredentials(this.#runtime, parsedRefs)
    beginSnapshotTransaction(database)
    try {
      database
        .prepare(
          `DELETE FROM braid_state_snapshot_keys AS key_row
           WHERE key_row.scope_id = ? AND key_row.retired = 1
             AND NOT EXISTS (
               SELECT 1 FROM braid_state_snapshots AS snapshot_row
               WHERE snapshot_row.key_ref = key_row.credential_ref
             )`,
        )
        .run(this.#runtime.scopeId())
      commit(this.#runtime, database, 'state.snapshot.invalidation.cleanup')
    } catch (error) {
      rollbackSnapshotTransaction(database)
      throw error
    }
  }

  async reconcile(): Promise<void> {
    await this.#runtime.writes.run(() => this.reconcileUnsafe())
  }

  async reconcileUnsafe(): Promise<void> {
    const database = this.#runtime.database()
    const active = new Set<string>()
    const snapshots = database
      .prepare('SELECT scope_id, generation FROM braid_state_snapshots')
      .all() as readonly Record<string, unknown>[]
    for (const row of snapshots) {
      active.add(
        `${asString(row.scope_id, 'scope_id')}\u0000${asNumber(row.generation, 'generation')}`,
      )
    }
    const keys = database
      .prepare(
        'SELECT scope_id, generation, credential_ref, retired FROM braid_state_snapshot_keys',
      )
      .all() as readonly SnapshotKeyRow[]
    const stale: Array<{
      readonly scopeId: string
      readonly generation: number
      readonly ref: CredentialRef
    }> = []
    for (const row of keys) {
      const scopeId = asString(row.scope_id, 'scope_id')
      const generation = asNumber(row.generation, 'generation')
      if (Number(row.retired) === 1 || !active.has(`${scopeId}\u0000${generation}`)) {
        const ref = asCredentialRef(row.credential_ref)
        if (ref === null)
          throw new StorageError('STATE_SNAPSHOT_INVALID', 'Snapshot key reference is invalid')
        stale.push({ scopeId, generation, ref })
      }
    }
    await removeSnapshotCredentials(
      this.#runtime,
      stale.map((row) => row.ref),
    )
    if (stale.length === 0) return
    beginSnapshotTransaction(database)
    try {
      for (const row of stale) {
        database
          .prepare(
            `DELETE FROM braid_state_snapshot_keys AS key_row
             WHERE key_row.scope_id = ? AND key_row.generation = ?
               AND key_row.credential_ref = ?
               AND NOT EXISTS (
                 SELECT 1 FROM braid_state_snapshots AS snapshot_row
                 WHERE snapshot_row.key_ref = key_row.credential_ref
               )`,
          )
          .run(row.scopeId, row.generation, row.ref)
      }
      commit(this.#runtime, database, 'state.snapshot.key.reconcile')
    } catch (error) {
      rollbackSnapshotTransaction(database)
      throw error
    }
  }
}
