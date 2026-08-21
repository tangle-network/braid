import { canonicalJson } from '../../domain/canonical.js'
import type {
  BackupReport,
  MigrationReport,
  OperationIntent,
  RestoreReport,
} from '../../ports/storage.js'
import { PROJECTION_SCHEMA_VERSION } from '../../ports/storage.js'
import { jsonValue } from './memory-base.js'
import { MemoryOperationStorage } from './memory-operations.js'
import { StorageError } from './sqlite-errors.js'
import { assertOperationRequestDigest } from './storage-validation.js'

export class MemoryMaintenanceStorage extends MemoryOperationStorage {
  async migrate(operation: OperationIntent): Promise<MigrationReport> {
    this.assertOpen()
    assertOperationRequestDigest(operation, {})
    const replay = await this.reuseMutation<MigrationReport>(operation)
    if (replay !== undefined) return replay
    const result = {
      fromVersion: PROJECTION_SCHEMA_VERSION,
      toVersion: PROJECTION_SCHEMA_VERSION,
      migrated: false,
    }
    await this.completeMutation(operation, 'terminal', result)
    return result
  }

  async backup(input: {
    readonly path: string
    readonly operation: OperationIntent
  }): Promise<BackupReport> {
    this.assertOpen()
    assertOperationRequestDigest(input.operation, { path: input.path })
    const replay = await this.reuseMutation<BackupReport>(input.operation)
    if (replay !== undefined) return replay
    this.snapshotStore.set(input.path, this.snapshot())
    const result = {
      path: input.path,
      bytes: Buffer.byteLength(canonicalJson(this.snapshot())),
      encrypted: false,
    }
    await this.completeMutation(input.operation, 'terminal', jsonValue(result))
    return result
  }

  async restore(input: {
    readonly path: string
    readonly operation: OperationIntent
  }): Promise<RestoreReport> {
    this.assertOpen()
    assertOperationRequestDigest(input.operation, { path: input.path })
    const replay = await this.reuseMutation<RestoreReport>(input.operation)
    if (replay !== undefined) return replay
    const snapshot = this.snapshotStore.get(input.path)
    if (!snapshot) {
      await this.completeMutation(input.operation, 'failed', { code: 'BACKUP_NOT_FOUND' })
      throw new StorageError('BACKUP_NOT_FOUND', `Memory backup ${input.path} was not found`)
    }
    this.restoreSnapshot(snapshot)
    const result = { path: input.path, restored: true, integrity: await this.integrity() }
    await this.completeMutation(input.operation, 'terminal', jsonValue(result))
    return result
  }
}
