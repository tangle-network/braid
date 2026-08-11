import { createHash, createHmac } from 'node:crypto'
import { closeSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { canonicalJson } from '../../domain/canonical.js'
import type { CredentialPort, CredentialRef } from '../../ports/credentials.js'
import type { IntegrityReport, StorageArtifacts } from '../../ports/storage.js'
import type { SqliteDatabase, SqliteDatabaseFactory } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'
import { classifySqliteError } from './sqlite-paths.js'
import { BoundedWriteQueue } from './sqlite-queue.js'
import { acquireExclusiveLock } from './sqlite-recovery.js'
import { pragmaNumber, pragmaString } from './sqlite-schema.js'
import type {
  DurableBoundaryHook,
  MigrationHooks,
  SqliteStartupStage,
  SqliteStorageInput,
} from './sqlite-types.js'

export abstract class SqliteStorageBase {
  protected readonly path: string
  protected readonly stateSnapshotScope: string
  protected readonly workspaceRoot: string | undefined
  protected readonly credentials: CredentialPort
  protected readonly databaseKeyRef: CredentialRef
  protected readonly databaseFactory: SqliteDatabaseFactory
  protected readonly busyTimeoutMs: number
  protected readonly maxEvents: number
  protected readonly maxPayloadBytes: number
  protected readonly backupDirectory: string
  protected readonly migrationHooks: MigrationHooks | undefined
  protected readonly durableBoundaryHook: DurableBoundaryHook | undefined
  protected readonly startupObserver: ((stage: SqliteStartupStage) => void) | undefined
  protected readonly writes: BoundedWriteQueue
  protected database: SqliteDatabase
  protected databaseFileDescriptor: number | undefined
  protected exclusiveLock: { readonly release: () => Promise<void> } | undefined
  protected databaseKey: Buffer
  protected latestBackupPath: string | undefined
  protected closed = false

  protected constructor(input: SqliteStorageInput) {
    this.path = input.path
    this.stateSnapshotScope = `storage-${createHash('sha256').update(input.path).digest('hex').slice(0, 32)}`
    this.workspaceRoot = input.workspaceRoot
    this.credentials = input.credentials
    this.databaseKeyRef = input.databaseKeyRef
    this.databaseKey = Buffer.from(input.databaseKey)
    this.databaseFactory = input.databaseFactory
    this.busyTimeoutMs = input.busyTimeoutMs
    this.maxEvents = input.maxEvents
    this.maxPayloadBytes = input.maxPayloadBytes
    this.backupDirectory = input.backupDirectory
    this.migrationHooks = input.migrationHooks
    this.durableBoundaryHook = input.durableBoundaryHook
    this.startupObserver = input.startupObserver
    this.writes = new BoundedWriteQueue(input.maxQueuedTransactions)
    this.database = input.database
    this.databaseFileDescriptor = input.databaseFileDescriptor
    this.exclusiveLock = input.exclusiveLock
  }

  fingerprint(input: { readonly effectKind: string; readonly request: unknown }): string {
    return createHmac('sha256', this.databaseKey)
      .update('braid-operation-fingerprint:v1\u0000')
      .update(input.effectKind)
      .update('\u0000')
      .update(canonicalJson(input.request))
      .digest('hex')
  }

  snapshotScopeId(): string {
    return this.stateSnapshotScope
  }

  artifacts(): StorageArtifacts {
    return {
      database: this.path,
      wal: `${this.path}-wal`,
      sharedMemory: `${this.path}-shm`,
      backups: this.latestBackupPath ? [this.latestBackupPath] : [],
    }
  }

  async integrity(): Promise<IntegrityReport> {
    this.assertOpen()
    return this.integrityReport()
  }

  async close(): Promise<void> {
    if (this.closed) return
    let failure: unknown
    try {
      await this.writes.drain()
    } catch (error) {
      failure = error
    }
    this.closed = true
    try {
      this.database.close()
    } finally {
      try {
        if (this.databaseFileDescriptor !== undefined) {
          closeSync(this.databaseFileDescriptor)
          this.databaseFileDescriptor = undefined
        }
        this.databaseKey.fill(0)
      } finally {
        const lock = this.exclusiveLock
        this.exclusiveLock = undefined
        await lock?.release()
      }
    }
    if (failure !== undefined) throw failure
  }

  integrityReportFor(database: SqliteDatabase): IntegrityReport {
    const errors: string[] = []
    let quickCheck = false
    let fullCheck = false
    try {
      const quick = database.prepare('PRAGMA quick_check').all() as readonly Record<
        string,
        unknown
      >[]
      quickCheck =
        quick.length > 0 && quick.every((row) => Object.values(row).some((value) => value === 'ok'))
    } catch (error) {
      errors.push(`quick_check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      const full = database.prepare('PRAGMA integrity_check').all() as readonly Record<
        string,
        unknown
      >[]
      fullCheck =
        full.length > 0 && full.every((row) => Object.values(row).some((value) => value === 'ok'))
    } catch (error) {
      errors.push(
        `integrity_check failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    let foreignKeys = false
    try {
      foreignKeys = pragmaNumber(database, 'foreign_keys') === 1
    } catch {
      errors.push('foreign_keys pragma is unavailable')
    }
    let wal = false
    try {
      wal = pragmaString(database, 'journal_mode')?.toLowerCase() === 'wal'
    } catch {
      errors.push('journal_mode pragma is unavailable')
    }
    let encryption: IntegrityReport['encryption'] = 'verified'
    try {
      const cipher = pragmaString(database, 'cipher')
      if (cipher?.toLowerCase() !== 'sqlcipher') {
        encryption = 'unavailable'
        errors.push('SQLCipher mode is not active')
      }
    } catch {
      encryption = 'unavailable'
      errors.push('cipher pragma is unavailable')
    }
    return {
      ok:
        errors.length === 0 &&
        quickCheck &&
        fullCheck &&
        foreignKeys &&
        wal &&
        encryption === 'verified',
      encryption,
      quickCheck,
      fullCheck,
      foreignKeys,
      wal,
      schemaVersion: pragmaNumber(database, 'user_version'),
      errors,
    }
  }

  integrityReport(): IntegrityReport {
    return this.integrityReportFor(this.database)
  }

  begin(): void {
    this.assertOpen()
    try {
      this.database.exec('BEGIN IMMEDIATE')
    } catch (error) {
      throw classifySqliteError(error)
    }
  }

  commit(boundary: string): void {
    this.durableBoundaryHook?.(`before:${boundary}`)
    try {
      this.database.exec('COMMIT')
    } catch (error) {
      throw classifySqliteError(error)
    }
    // The transaction is already durable. A crash injector may terminate here,
    // but an observer error must not make callers roll back a committed write.
    try {
      this.durableBoundaryHook?.(`after:${boundary}`)
    } catch {
      // Boundary hooks are test-only observers and cannot alter commit status.
    }
  }

  rollback(): void {
    try {
      this.database.exec('ROLLBACK')
    } catch {
      // Preserve the original commit or transaction error.
    }
  }

  assertOpen(): void {
    if (this.closed || !this.database.open)
      throw new StorageError('STORAGE_CLOSED', 'SQLite storage is closed')
  }

  protected observeStartup(name: SqliteStartupStage['name'], startedAt: number): void {
    try {
      this.startupObserver?.({ name, durationMs: performance.now() - startedAt })
    } catch {
      // Diagnostics cannot change storage startup.
    }
  }

  async withExclusiveLock<T>(operation: () => Promise<T>): Promise<T> {
    // The storage lifetime lock already excludes every other process. Reusing
    // it avoids a same-process self-deadlock during backup and restore.
    if (this.exclusiveLock !== undefined) return operation()
    const lock = await acquireExclusiveLock(`${this.path}.exclusive.lock`)
    try {
      return await operation()
    } finally {
      await lock.release()
    }
  }
}
