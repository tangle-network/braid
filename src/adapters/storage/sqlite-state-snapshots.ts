import type { CredentialRef } from '../../ports/credentials.js'
import type { StateSnapshot, StoredStateSnapshot } from '../../ports/storage.js'
import { SqliteStateSnapshotLifecycle } from './sqlite-state-snapshot-lifecycle.js'
import { SqliteStateSnapshotReader } from './sqlite-state-snapshot-read.js'
import type { PreparedStateSnapshot, SnapshotRuntime } from './sqlite-state-snapshot-types.js'
import { SqliteStateSnapshotWriter } from './sqlite-state-snapshot-write.js'

export class SqliteStateSnapshotStore {
  readonly #lifecycle: SqliteStateSnapshotLifecycle
  readonly #reader: SqliteStateSnapshotReader
  readonly #writer: SqliteStateSnapshotWriter

  constructor(runtime: SnapshotRuntime) {
    this.#lifecycle = new SqliteStateSnapshotLifecycle(runtime)
    this.#reader = new SqliteStateSnapshotReader(runtime)
    this.#writer = new SqliteStateSnapshotWriter(runtime)
  }

  async latest(): Promise<StoredStateSnapshot | null> {
    return this.#reader.latest()
  }

  async prepare(
    snapshot: StateSnapshot,
    createdRefs: CredentialRef[],
  ): Promise<PreparedStateSnapshot> {
    return this.#writer.prepare(snapshot, createdRefs)
  }

  writeUnsafe(snapshot: StateSnapshot, storageId: number, prepared: PreparedStateSnapshot): void {
    this.#writer.writeUnsafe(snapshot, storageId, prepared)
  }

  async write(snapshot: StateSnapshot): Promise<void> {
    return this.#writer.write(snapshot, () => this.#lifecycle.pruneAfterCommitUnsafe())
  }

  async prune(): Promise<void> {
    return this.#lifecycle.prune()
  }

  async pruneAfterCommitUnsafe(): Promise<void> {
    return this.#lifecycle.pruneAfterCommitUnsafe()
  }

  async discardCredentials(refs: readonly CredentialRef[]): Promise<void> {
    return this.#lifecycle.discardCredentials(refs)
  }

  async pruneUnsafe(): Promise<void> {
    return this.#lifecycle.pruneUnsafe()
  }

  async destroyKeysBeforeMutation(): Promise<void> {
    return this.#lifecycle.destroyKeysBeforeMutation()
  }

  invalidateUnsafe(): void {
    this.#lifecycle.invalidateUnsafe()
  }

  async finishInvalidationUnsafe(): Promise<void> {
    return this.#lifecycle.finishInvalidationUnsafe()
  }

  async reconcile(): Promise<void> {
    return this.#lifecycle.reconcile()
  }

  async reconcileUnsafe(): Promise<void> {
    return this.#lifecycle.reconcileUnsafe()
  }
}
