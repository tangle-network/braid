import { randomUUID } from 'node:crypto'
import { rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  BackupReport,
  MigrationReport,
  OperationIntent,
  RestoreReport,
} from '../../ports/storage.js'
import type { SqliteDatabase } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'
import {
  applyConnectionPragmas,
  migrateSchema,
  pragmaNumber,
  SQLITE_SCHEMA_VERSION,
} from './sqlite-schema.js'
import { assertOperationRequestDigest } from './storage-validation.js'

import { SqliteEffectsStorage } from './sqlite-effects.js'
import type { RestoreManifest } from './sqlite-recovery.js'
import { jsonValue } from './sqlite-rows.js'
import { classifySqliteError } from './sqlite-paths.js'
import { RESTORE_MANIFEST_VERSION } from './sqlite-types.js'
import {
  assertApprovedPath,
  copyProtectedFile,
  secureArtifact,
  syncDirectory,
  validatePath,
} from './sqlite-paths.js'
import { restoreManifestPath, writeRestoreManifest } from './sqlite-recovery.js'

export abstract class SqliteMaintenanceStorage extends SqliteEffectsStorage {
  async migrate(operation: OperationIntent): Promise<MigrationReport> {
    assertOperationRequestDigest(operation, {})
    const replay = await this.reuseMutation<MigrationReport>(operation)
    if (replay !== undefined) return replay
    let mutationCommitted = false
    try {
      const result = await this.writes.run(async () => {
        this.assertOpen()
        const fromVersion = pragmaNumber(this.database, 'user_version')
        if (fromVersion >= SQLITE_SCHEMA_VERSION) {
          return { fromVersion, toVersion: fromVersion, migrated: false }
        }
        const backupPath = await this.createMigrationBackup(fromVersion)
        this.begin()
        try {
          migrateSchema(this.database)
          this.migrationHooks?.beforeVersionCommit?.(SQLITE_SCHEMA_VERSION)
          const projection = this.buildProjection()
          this.writeProjection(projection)
          this.commit('migration')
          mutationCommitted = true
          return { fromVersion, toVersion: SQLITE_SCHEMA_VERSION, migrated: true, backupPath }
        } catch (error) {
          this.rollback()
          throw classifySqliteError(error)
        }
      })
      await this.completeMutation(operation, 'terminal', result)
      return result
    } catch (error) {
      await this.completeMutationFailure(operation, error, mutationCommitted)
      throw error
    }
  }

  async backup(input: {
    readonly path: string
    readonly operation: OperationIntent
  }): Promise<BackupReport> {
    assertOperationRequestDigest(input.operation, { path: input.path })
    const replay = await this.reuseMutation<BackupReport>(input.operation)
    if (replay !== undefined) return replay
    let mutationCommitted = false
    try {
      const result = await this.writes.run(async () =>
        this.withExclusiveLock(() => this.backupUnsafe(input.path)),
      )
      mutationCommitted = true
      await this.completeMutation(input.operation, 'terminal', jsonValue(result))
      return result
    } catch (error) {
      await this.completeMutationFailure(input.operation, error, mutationCommitted)
      throw error
    }
  }

  async restore(input: {
    readonly path: string
    readonly operation: OperationIntent
  }): Promise<RestoreReport> {
    assertOperationRequestDigest(input.operation, { path: input.path })
    const replay = await this.reuseMutation<RestoreReport>(input.operation)
    if (replay !== undefined) return replay
    let mutationCommitted = false
    try {
      const result = await this.writes.run(async () =>
        this.withExclusiveLock(async () => {
          this.assertOpen()
          const source = validatePath(input.path, 'Backup path')
          await assertApprovedPath(
            source,
            this.workspaceRoot ?? dirname(this.path),
            'Backup path',
            false,
          )
          await this.assertEncryptedArtifact(source)
          const recoveryPath = join(
            this.backupDirectory,
            `${basename(this.path)}.pre-restore-${Date.now()}-${randomUUID()}.bak`,
          )
          await this.backupUnsafe(recoveryPath)
          const temporary = `${this.path}.restore-${randomUUID()}.tmp`
          const displaced = `${this.path}.displaced-${randomUUID()}`
          const displacedWal = `${this.path}-wal.displaced-${randomUUID()}`
          const displacedSharedMemory = `${this.path}-shm.displaced-${randomUUID()}`
          let manifest: RestoreManifest = {
            version: RESTORE_MANIFEST_VERSION,
            operationId: input.operation.operationId,
            source,
            recovery: recoveryPath,
            temporary,
            displaced,
            displacedWal,
            displacedSharedMemory,
            phase: 'prepared',
          }
          await writeRestoreManifest(this.path, manifest, this.durableBoundaryHook)
          try {
            this.durableBoundaryHook?.('before:restore.copy')
            await copyProtectedFile(source, temporary, 'backup')
            await secureArtifact(temporary)
            await syncDirectory(dirname(this.path))
            this.durableBoundaryHook?.('after:restore.copy')
            manifest = { ...manifest, phase: 'candidate-ready' }
            await writeRestoreManifest(this.path, manifest, this.durableBoundaryHook)

            let validationDatabase: SqliteDatabase | undefined
            try {
              validationDatabase = this.openDatabase(temporary)
              applyConnectionPragmas(validationDatabase, this.busyTimeoutMs)
              const report = this.integrityReportFor(validationDatabase)
              if (!report.ok)
                throw new StorageError('STORAGE_INTEGRITY_FAILURE', 'Backup integrity check failed')
            } finally {
              validationDatabase?.close()
            }
            await rm(`${temporary}-wal`, { force: true })
            await rm(`${temporary}-shm`, { force: true })
            await syncDirectory(dirname(this.path))

            await this.database.close()
            const moveIfPresent = async (sourcePath: string, targetPath: string, label: string) => {
              try {
                this.durableBoundaryHook?.(`before:restore.${label}`)
                await rename(sourcePath, targetPath)
                await syncDirectory(dirname(this.path))
                this.durableBoundaryHook?.(`after:restore.${label}`)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              }
            }
            await moveIfPresent(this.path, displaced, 'displace')
            await moveIfPresent(`${this.path}-wal`, displacedWal, 'displace-wal')
            await moveIfPresent(`${this.path}-shm`, displacedSharedMemory, 'displace-shm')
            manifest = { ...manifest, phase: 'live-displaced' }
            await writeRestoreManifest(this.path, manifest, this.durableBoundaryHook)
            this.durableBoundaryHook?.('before:restore.install')
            await rename(temporary, this.path)
            await syncDirectory(dirname(this.path))
            this.durableBoundaryHook?.('after:restore.install')
            manifest = { ...manifest, phase: 'installed' }
            await writeRestoreManifest(this.path, manifest, this.durableBoundaryHook)
            this.database = this.openDatabase(this.path)
            applyConnectionPragmas(this.database, this.busyTimeoutMs)
            await this.initialize()
            this.reserveRestoredOperationUnsafe(input.operation)
            const integrity = this.integrityReport()
            if (!integrity.ok)
              throw new StorageError(
                'STORAGE_INTEGRITY_FAILURE',
                'Restored database is not healthy',
              )
            manifest = { ...manifest, phase: 'verified' }
            await writeRestoreManifest(this.path, manifest, this.durableBoundaryHook)
            for (const [label, path] of [
              ['cleanup', displaced],
              ['cleanup-wal', displacedWal],
              ['cleanup-shm', displacedSharedMemory],
            ] as const) {
              this.durableBoundaryHook?.(`before:restore.${label}`)
              await rm(path, { force: true })
              await syncDirectory(dirname(this.path))
              this.durableBoundaryHook?.(`after:restore.${label}`)
            }
            this.durableBoundaryHook?.('before:restore.manifest.remove')
            await unlink(restoreManifestPath(this.path))
            await syncDirectory(dirname(this.path))
            this.durableBoundaryHook?.('after:restore.manifest.remove')
            mutationCommitted = true
            return { path: source, restored: true, integrity }
          } catch (error) {
            await this.rollbackRestore(manifest).catch(() => undefined)
            throw error instanceof StorageError ? error : classifySqliteError(error)
          }
        }),
      )
      await this.completeMutation(input.operation, 'terminal', jsonValue(result))
      return result
    } catch (error) {
      await this.completeMutationFailure(input.operation, error, mutationCommitted)
      throw error
    }
  }
}
