import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { CredentialRef, SecretHandle } from '../../ports/credentials.js'
import type { EffectStoragePort } from '../../ports/effect-storage.js'
import type { StoragePort } from '../../ports/storage.js'
import { readHeadlessKey } from '../credentials/headless-key.js'
import { closeBoundSqliteDatabase, openBoundSqliteDatabase } from './sqlite-bound-open.js'
import { configureCipherDatabase, loadCipherDatabaseFactory } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'
import {
  claimInitializationMarker,
  inspectInitializationMarker,
  markInitializationInterrupted,
  releaseInitializationMarker,
  removeDatabaseArtifacts,
} from './sqlite-initialization.js'
import {
  assertApprovedPath,
  classifySqliteError,
  ensureDirectory,
  validatePath,
} from './sqlite-paths.js'
import { acquireExclusiveLock, recoverRestoreManifest } from './sqlite-recovery.js'
import { SqliteRedactionStorage } from './sqlite-redaction.js'
import { credentialErrorCode, deterministicCredentialRef } from './sqlite-rows.js'
import { applyConnectionPragmas } from './sqlite-schema.js'
import {
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_QUEUED_TRANSACTIONS,
  type SqliteStartupStage,
  type SqliteStorageInput,
  type SqliteStorageOptions,
} from './sqlite-types.js'

export type {
  DurableBoundaryHook,
  SqliteStartupStage,
  SqliteStorageOptions,
} from './sqlite-types.js'
export class SqliteStorage
  extends SqliteRedactionStorage
  implements StoragePort, EffectStoragePort
{
  protected constructor(input: SqliteStorageInput) {
    super(input)
  }

  static async open(options: SqliteStorageOptions): Promise<SqliteStorage> {
    const pathLockStarted = performance.now()
    let stageStarted = pathLockStarted
    const path = validatePath(options.path, 'SQLite path')
    const approvedRoot = validatePath(options.workspaceRoot ?? dirname(path), 'Approved root')
    const unsafeOptions = options as unknown as Record<string, unknown>
    for (const forbidden of ['databaseKey', 'key', 'encryptionKey', 'env', 'environmentVariable']) {
      if (forbidden in unsafeOptions) {
        throw new StorageError(
          'HEADLESS_KEY_SOURCE_REQUIRED',
          'Raw and environment key inputs are rejected',
        )
      }
    }
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
    const maxEvents = options.maxEventsPerTransaction ?? DEFAULT_MAX_EVENTS
    const maxPayloadBytes = options.maxPayloadBytesPerTransaction ?? DEFAULT_MAX_PAYLOAD_BYTES
    const maxQueuedTransactions = options.maxQueuedTransactions ?? DEFAULT_MAX_QUEUED_TRANSACTIONS
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
      throw new StorageError('STORAGE_OPTIONS', 'busyTimeoutMs must be between 1 and 60000')
    }
    if (!Number.isInteger(maxEvents) || maxEvents < 1)
      throw new StorageError('STORAGE_OPTIONS', 'maxEvents must be positive')
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 1024) {
      throw new StorageError('STORAGE_OPTIONS', 'maxPayloadBytes must be at least 1024')
    }
    if (!Number.isInteger(maxQueuedTransactions) || maxQueuedTransactions < 1) {
      throw new StorageError('STORAGE_OPTIONS', 'maxQueuedTransactions must be positive')
    }
    await ensureDirectory(approvedRoot)
    await assertApprovedPath(path, approvedRoot, 'SQLite path')
    const backupDirectory = validatePath(
      options.backupDirectory ?? dirname(path),
      'Backup directory',
    )
    await assertApprovedPath(backupDirectory, approvedRoot, 'Backup directory')
    observeStartup(options.startupObserver, 'path-validation', stageStarted)
    stageStarted = performance.now()
    const lock = await acquireExclusiveLock(`${path}.exclusive.lock`)
    observeStartup(options.startupObserver, 'lock-acquire', stageStarted)
    stageStarted = performance.now()
    let lockReleased = false
    try {
      await recoverRestoreManifest(path, approvedRoot)
      observeStartup(options.startupObserver, 'recovery-check', stageStarted)
      stageStarted = performance.now()
      const markerState = await inspectInitializationMarker(path)
      observeStartup(options.startupObserver, 'initialization-marker', stageStarted)
      if (markerState === 'active') {
        throw new StorageError(
          'STORAGE_INITIALIZING',
          'Another process is initializing the encrypted database',
        )
      }
      observeStartup(options.startupObserver, 'path-lock', pathLockStarted)
      stageStarted = performance.now()
      let credentialStoreAvailable = false
      try {
        credentialStoreAvailable = await options.credentialStore.available()
      } catch (error) {
        throw new StorageError(
          'CREDENTIAL_STORE_UNAVAILABLE',
          'The operating-system credential facility is unavailable',
          { cause: error },
        )
      }
      if (!credentialStoreAvailable) {
        throw new StorageError(
          'CREDENTIAL_STORE_UNAVAILABLE',
          'The operating-system credential facility is unavailable',
        )
      }
      const databaseFactory = options.databaseFactory ?? loadCipherDatabaseFactory()
      const databaseKeyRef = options.databaseKeyRef ?? deterministicCredentialRef('database', path)
      const databaseKey = await resolveDatabaseKey(options, databaseKeyRef)
      observeStartup(options.startupObserver, 'credential', stageStarted)
      stageStarted = performance.now()
      let opened: ReturnType<typeof openBoundSqliteDatabase> | undefined
      let initializationClaimed = false
      try {
        opened = openBoundSqliteDatabase(path, databaseFactory, busyTimeoutMs)
        initializationClaimed = opened.newDatabase || markerState === 'stale'
        if (initializationClaimed) await claimInitializationMarker(path)
        configureCipherDatabase(opened.database, databaseKey, { newDatabase: opened.newDatabase })
        applyConnectionPragmas(opened.database, busyTimeoutMs)
        observeStartup(options.startupObserver, 'cipher-open', stageStarted)
      } catch (error) {
        try {
          if (opened) closeBoundSqliteDatabase(opened)
        } catch {
          // The original error is the useful failure boundary.
        }
        databaseKey.fill(0)
        if (initializationClaimed) {
          if (opened?.newDatabase) await removeDatabaseArtifacts(path)
          await releaseInitializationMarker(path)
        }
        throw error instanceof StorageError ? error : classifySqliteError(error)
      }
      const storage = new SqliteStorage({
        path,
        workspaceRoot: approvedRoot,
        credentials: options.credentialStore,
        databaseKeyRef,
        databaseKey,
        databaseFactory,
        busyTimeoutMs,
        maxEvents,
        maxPayloadBytes,
        maxQueuedTransactions,
        backupDirectory,
        ...(options.migrationHooks === undefined ? {} : { migrationHooks: options.migrationHooks }),
        ...(options.durableBoundaryHook === undefined
          ? {}
          : { durableBoundaryHook: options.durableBoundaryHook }),
        ...(options.startupObserver === undefined
          ? {}
          : { startupObserver: options.startupObserver }),
        database: opened.database,
        databaseFileDescriptor: opened.fileDescriptor,
      })
      databaseKey.fill(0)
      try {
        await storage.initialize()
        if (initializationClaimed) await releaseInitializationMarker(path)
        await lock.release()
        lockReleased = true
        return storage
      } catch (error) {
        await storage.close().catch(() => undefined)
        if (initializationClaimed) {
          if (opened?.newDatabase) {
            await removeDatabaseArtifacts(path).catch(() => undefined)
            await releaseInitializationMarker(path).catch(() => undefined)
          } else {
            await markInitializationInterrupted(path).catch(() => undefined)
          }
        }
        throw error
      }
    } finally {
      if (!lockReleased) await lock.release()
    }
  }
}

function observeStartup(
  observer: SqliteStorageOptions['startupObserver'],
  name: SqliteStartupStage['name'],
  startedAt: number,
): void {
  try {
    observer?.({ name, durationMs: performance.now() - startedAt })
  } catch {
    // Diagnostics cannot change storage startup.
  }
}

async function resolveDatabaseKey(
  options: SqliteStorageOptions,
  ref: CredentialRef,
): Promise<Buffer> {
  if (options.databaseKeySource) return readHeadlessKey(options.databaseKeySource)
  let handle: SecretHandle | undefined
  try {
    handle = await options.credentialStore.resolve(ref)
    const key = Buffer.from(handle.read())
    if (key.length !== 32)
      throw new StorageError('SQLITE_KEY_INVALID', 'Stored SQLite key has invalid length')
    return key
  } catch (error) {
    if (credentialErrorCode(error) !== 'CREDENTIAL_NOT_FOUND') throw error
    const key = randomBytes(32)
    try {
      await options.credentialStore.store({ ref, value: key, label: 'Braid database key' })
      return Buffer.from(key)
    } finally {
      key.fill(0)
      handle?.dispose()
    }
  } finally {
    handle?.dispose()
  }
}

export function openSqliteStorage(options: SqliteStorageOptions): Promise<SqliteStorage> {
  return SqliteStorage.open(options)
}
