import { randomUUID } from 'node:crypto'
import { closeSync } from 'node:fs'
import { link, lstat, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseConversationId, parseEventId } from '../../domain/ids.js'
import type { CredentialRef } from '../../ports/credentials.js'
import { credentialRef } from '../../ports/credentials.js'
import type { BackupReport } from '../../ports/storage.js'
import { bindDescriptorLifetime, openBoundSqliteDatabase } from './sqlite-bound-open.js'
import { configureCipherDatabase, type SqliteDatabase } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'
import {
  assertApprovedPath,
  classifySqliteError,
  ensureDirectory,
  openProtectedInput,
  rejectSymlink,
  secureArtifact,
  secureLiveSqliteArtifact,
  syncDirectory,
  syncFile,
  validatePath,
} from './sqlite-paths.js'
import { SqliteProjectionStorage } from './sqlite-projection.js'
import type { RestoreManifest } from './sqlite-recovery.js'
import { restoreManifestPath } from './sqlite-recovery.js'
import { asString, credentialErrorCode } from './sqlite-rows.js'
import {
  applyConnectionPragmas,
  migrateSchema,
  pragmaNumber,
  pragmaString,
  SQLITE_SCHEMA_VERSION,
} from './sqlite-schema.js'

export abstract class SqliteLifecycleStorage extends SqliteProjectionStorage {
  async initialize(): Promise<void> {
    let stageStarted = performance.now()
    const fromVersion = pragmaNumber(this.database, 'user_version')
    if (fromVersion > SQLITE_SCHEMA_VERSION)
      throw new StorageError(
        'SQLITE_SCHEMA_NEWER',
        'Database schema is newer than this Braid release',
      )
    if (fromVersion < SQLITE_SCHEMA_VERSION && fromVersion > 0)
      await this.createMigrationBackup(fromVersion)
    if (fromVersion < SQLITE_SCHEMA_VERSION) {
      this.begin()
      try {
        migrateSchema(this.database)
        this.migrationHooks?.beforeVersionCommit?.(SQLITE_SCHEMA_VERSION)
        if (fromVersion > 0) this.writeProjection(this.buildProjection())
        this.commit(fromVersion === 0 ? 'schema.initialize' : 'migration')
      } catch (error) {
        this.rollback()
        throw classifySqliteError(error)
      }
    }
    this.observeStartup('schema', stageStarted)
    stageStarted = performance.now()
    await this.reconcileContentKeyLifecycle()
    this.observeStartup('content-keys', stageStarted)
    stageStarted = performance.now()
    await this.stateSnapshots.reconcileUnsafe()
    await this.stateSnapshots.pruneUnsafe()
    this.observeStartup('snapshot-maintenance', stageStarted)
    stageStarted = performance.now()
    const stored = this.database
      .prepare(
        'SELECT revision, state_json, checksum FROM braid_projection_state WHERE projection_name = ?',
      )
      .get('canonical') as
      | { readonly revision?: unknown; readonly state_json?: unknown; readonly checksum?: unknown }
      | undefined
    if (!stored) {
      const built = this.buildProjection()
      this.begin()
      try {
        this.writeProjection(built)
        this.commit('projection.initialize')
      } catch (error) {
        this.rollback()
        throw classifySqliteError(error)
      }
    } else {
      this.assertStoredProjectionSummary(stored)
    }
    this.observeStartup('projection', stageStarted)
    stageStarted = performance.now()
    if (fromVersion === SQLITE_SCHEMA_VERSION) this.assertStartupConfiguration()
    else {
      const report = this.integrityReport()
      if (!report.ok) throw new StorageError('STORAGE_INTEGRITY_FAILURE', report.errors.join('; '))
    }
    this.observeStartup('configuration', stageStarted)
    stageStarted = performance.now()
    await this.secureArtifacts()
    this.observeStartup('artifact-permissions', stageStarted)
  }

  private assertStartupConfiguration(): void {
    const failures: string[] = []
    if (pragmaNumber(this.database, 'foreign_keys') !== 1) failures.push('foreign_keys is disabled')
    if (pragmaString(this.database, 'journal_mode')?.toLowerCase() !== 'wal') {
      failures.push('journal_mode is not WAL')
    }
    if (pragmaString(this.database, 'cipher')?.toLowerCase() !== 'sqlcipher') {
      failures.push('SQLCipher mode is not active')
    }
    if (failures.length > 0) {
      throw new StorageError('STORAGE_INTEGRITY_FAILURE', failures.join('; '))
    }
  }

  async reconcileContentKeyLifecycle(): Promise<void> {
    const rotations = this.database
      .prepare(
        'SELECT conversation_id, old_credential_ref, new_credential_ref, redacted_event_id, phase FROM braid_content_key_rotations ORDER BY conversation_id',
      )
      .all() as readonly {
      readonly conversation_id: string
      readonly old_credential_ref: string
      readonly new_credential_ref: string
      readonly redacted_event_id: string | null
      readonly phase: string | null
    }[]
    for (const rotation of rotations) {
      const conversationId = parseConversationId(rotation.conversation_id)
      const oldRef = credentialRef(rotation.old_credential_ref)
      const newRef = credentialRef(rotation.new_credential_ref)
      const current = this.database
        .prepare('SELECT credential_ref FROM braid_conversation_keys WHERE conversation_id = ?')
        .get(conversationId) as { readonly credential_ref?: unknown } | undefined
      if (!current)
        throw new StorageError(
          'CONTENT_KEY_UNAVAILABLE',
          `Conversation ${conversationId} has no content key`,
        )
      const currentRef = credentialRef(asString(current.credential_ref, 'credential_ref'))
      if (currentRef === newRef) {
        if (rotation.redacted_event_id === null || rotation.phase !== 'rewritten') {
          throw new StorageError(
            'CONTENT_KEY_ROTATION_UNVERIFIED',
            `Conversation ${conversationId} has an unverified content key rotation`,
          )
        }
        const verified = await this.verifyConversation(
          conversationId,
          parseEventId(rotation.redacted_event_id),
          newRef,
        )
        if (!verified) {
          throw new StorageError(
            'REDACTION_VERIFY_FAILED',
            `Conversation ${conversationId} content rewrite failed verification`,
          )
        }
        await this.removeCredentialIfPresent(oldRef)
      } else if (currentRef === oldRef) {
        await this.removeCredentialIfPresent(newRef)
      } else {
        throw new StorageError(
          'CONTENT_KEY_ROTATION_CONFLICT',
          `Conversation ${conversationId} has an unexpected content key rotation`,
        )
      }
      this.begin()
      try {
        this.database
          .prepare('DELETE FROM braid_content_key_rotations WHERE conversation_id = ?')
          .run(conversationId)
        this.commit('key.reconcile')
      } catch (error) {
        this.rollback()
        throw classifySqliteError(error)
      }
    }

    const destroyed = this.database
      .prepare(
        'SELECT credential_ref FROM braid_conversation_keys WHERE destroyed = 1 ORDER BY conversation_id',
      )
      .all() as readonly { readonly credential_ref?: unknown }[]
    for (const row of destroyed) {
      await this.removeCredentialIfPresent(
        credentialRef(asString(row.credential_ref, 'credential_ref')),
      )
    }
  }

  async removeCredentialIfPresent(ref: CredentialRef): Promise<void> {
    try {
      await this.credentials.remove(ref)
    } catch (error) {
      if (credentialErrorCode(error) !== 'CREDENTIAL_NOT_FOUND') throw error
    }
  }

  async createMigrationBackup(version: number): Promise<string> {
    await ensureDirectory(this.backupDirectory)
    const path = join(
      this.backupDirectory,
      `${basename(this.path)}.pre-migration-v${version}-${Date.now()}.bak`,
    )
    await this.backupUnsafe(path)
    return path
  }

  async backupUnsafe(path: string): Promise<BackupReport> {
    this.assertOpen()
    const destination = validatePath(path, 'Backup path')
    if (destination === this.path)
      throw new StorageError('BACKUP_PATH', 'Backup cannot overwrite the live database')
    await assertApprovedPath(destination, this.workspaceRoot ?? dirname(this.path), 'Backup path')
    await ensureDirectory(dirname(destination))
    await rejectSymlink(destination, false)
    try {
      await lstat(destination)
      throw new StorageError('BACKUP_EXISTS', 'Backup destination already exists')
    } catch (error) {
      if (error instanceof StorageError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = `${destination}.partial-${randomUUID()}`
    try {
      this.durableBoundaryHook?.('before:backup')
      this.database.prepare('VACUUM INTO ?').run(temporary)
      await secureArtifact(temporary)
      await this.assertEncryptedArtifact(temporary)
      await this.assertReadableBackup(temporary)
      await syncFile(temporary)
      this.durableBoundaryHook?.('before:backup.publish')
      try {
        await link(temporary, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new StorageError('BACKUP_EXISTS', 'Backup destination already exists', {
            cause: error,
          })
        }
        throw error
      }
      await syncFile(destination)
      await syncDirectory(dirname(destination))
      this.durableBoundaryHook?.('after:backup.publish')
      this.durableBoundaryHook?.('before:backup.temp.remove')
      await unlink(temporary)
      await syncDirectory(dirname(destination))
      this.durableBoundaryHook?.('after:backup.temp.remove')
      const bytes = (await stat(destination)).size
      this.latestBackupPath = destination
      try {
        this.durableBoundaryHook?.('after:backup')
      } catch {
        // The backup is already complete; a test observer cannot invalidate it.
      }
      return { path: destination, bytes, encrypted: true }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error instanceof StorageError ? error : classifySqliteError(error)
    }
  }

  openDatabase(path: string): SqliteDatabase {
    const opened = openBoundSqliteDatabase(path, this.databaseFactory, this.busyTimeoutMs)
    try {
      configureCipherDatabase(opened.database, this.databaseKey, {
        newDatabase: opened.newDatabase,
      })
      return bindDescriptorLifetime(opened.database, opened.fileDescriptor)
    } catch (error) {
      opened.database.close()
      closeSync(opened.fileDescriptor)
      throw error
    }
  }

  async assertEncryptedArtifact(path: string): Promise<void> {
    const handle = await openProtectedInput(path, 'encrypted storage artifact')
    let bytes: Buffer
    try {
      bytes = await handle.readFile()
    } finally {
      await handle.close()
    }
    if (bytes.length < 32 || bytes.subarray(0, 16).toString('ascii') === 'SQLite format 3\u0000') {
      throw new StorageError('STORAGE_NOT_ENCRYPTED', `Storage artifact is not encrypted: ${path}`)
    }
  }

  async secureArtifacts(): Promise<void> {
    await secureLiveSqliteArtifact(this.path)
    await secureLiveSqliteArtifact(this.artifacts().wal)
    await secureLiveSqliteArtifact(this.artifacts().sharedMemory)
  }

  async assertReadableBackup(path: string): Promise<void> {
    const database = this.openDatabase(path)
    try {
      const quick = database.prepare('PRAGMA quick_check').all() as readonly Record<
        string,
        unknown
      >[]
      const full = database.prepare('PRAGMA integrity_check').all() as readonly Record<
        string,
        unknown
      >[]
      const isOk = (rows: readonly Record<string, unknown>[]) =>
        rows.length > 0 && rows.every((row) => Object.values(row).some((value) => value === 'ok'))
      if (!isOk(quick) || !isOk(full)) {
        throw new StorageError(
          'BACKUP_INTEGRITY_FAILURE',
          'Encrypted backup failed SQLite integrity checks',
        )
      }
    } finally {
      database.close()
    }
  }

  async rollbackRestore(manifest: RestoreManifest): Promise<void> {
    if (this.database.open) this.database.close()
    const liveExists = await stat(this.path)
      .then(() => true)
      .catch(() => false)
    const displacedExists = await stat(manifest.displaced)
      .then(() => true)
      .catch(() => false)
    const candidateInstalled =
      displacedExists &&
      (manifest.phase === 'live-displaced' ||
        manifest.phase === 'installed' ||
        manifest.phase === 'verified' ||
        liveExists)
    if (candidateInstalled && liveExists) {
      await rm(this.path, { force: true })
      await syncDirectory(dirname(this.path))
    }
    for (const [source, target] of [
      [manifest.displaced, this.path],
      [manifest.displacedWal, `${this.path}-wal`],
      [manifest.displacedSharedMemory, `${this.path}-shm`],
    ] as const) {
      const sourceExists = await stat(source)
        .then(() => true)
        .catch(() => false)
      const targetExists = await stat(target)
        .then(() => true)
        .catch(() => false)
      if (sourceExists && !targetExists) {
        await rename(source, target)
        await syncDirectory(dirname(this.path))
      }
    }
    await rm(manifest.temporary, { force: true })
    await unlink(restoreManifestPath(this.path)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await syncDirectory(dirname(this.path))
    this.database = this.openDatabase(this.path)
    applyConnectionPragmas(this.database, this.busyTimeoutMs)
  }
}
