import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { open as openFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson } from '../../domain/canonical.js'
import { StorageError } from './sqlite-errors.js'
import { syncDirectory } from './sqlite-paths.js'

export interface InitializationMarker {
  readonly version: 1
  readonly databaseDigest: string
  readonly pid: number
}

export type InitializationMarkerState = 'none' | 'active' | 'stale'

export function initializationMarkerPath(databasePath: string): string {
  return `${databasePath}.initializing`
}

export function initializationMarker(
  databasePath: string,
  pid = process.pid,
): InitializationMarker {
  return {
    version: 1,
    databaseDigest: createHash('sha256').update(databasePath).digest('hex'),
    pid,
  }
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function inspectInitializationMarker(
  databasePath: string,
): Promise<InitializationMarkerState> {
  const markerPath = initializationMarkerPath(databasePath)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openFile(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 512) {
      throw new StorageError(
        'STORAGE_INITIALIZATION_MARKER',
        'Database initialization marker is invalid',
      )
    }
    if (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600) {
      throw new StorageError(
        'STORAGE_INITIALIZATION_MARKER',
        'Database initialization marker must have mode 0600',
      )
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
      throw new StorageError(
        'STORAGE_INITIALIZATION_MARKER',
        'Database initialization marker ownership does not match the process',
      )
    }
    const raw = await handle.readFile({ encoding: 'utf8' })
    const parsed = JSON.parse(raw) as Partial<InitializationMarker>
    const expected = initializationMarker(databasePath, 0).databaseDigest
    if (
      parsed.version !== 1 ||
      parsed.databaseDigest !== expected ||
      !Number.isSafeInteger(parsed.pid)
    ) {
      throw new StorageError(
        'STORAGE_INITIALIZATION_MARKER',
        'Database initialization marker is invalid',
      )
    }
    return processIsAlive(parsed.pid as number) ? 'active' : 'stale'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'
    if (error instanceof StorageError) throw error
    throw new StorageError(
      'STORAGE_INITIALIZATION_MARKER',
      'Database initialization marker could not be read',
      { cause: error },
    )
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function claimInitializationMarker(databasePath: string): Promise<void> {
  const markerPath = initializationMarkerPath(databasePath)
  for (;;) {
    let handle: Awaited<ReturnType<typeof openFile>> | undefined
    try {
      handle = await openFile(markerPath, 'wx', 0o600)
      await handle.writeFile(`${canonicalJson(initializationMarker(databasePath))}\n`)
      await handle.sync()
      await handle.close()
      handle = undefined
      await syncDirectory(dirname(databasePath))
      return
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const state = await inspectInitializationMarker(databasePath)
      if (state === 'active') {
        throw new StorageError(
          'STORAGE_INITIALIZING',
          'Another process is initializing the encrypted database',
        )
      }
      await rm(markerPath, { force: true })
    }
  }
}

export async function releaseInitializationMarker(databasePath: string): Promise<void> {
  await rm(initializationMarkerPath(databasePath), { force: true })
  await syncDirectory(dirname(databasePath))
}

export async function markInitializationInterrupted(databasePath: string): Promise<void> {
  const markerPath = initializationMarkerPath(databasePath)
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openFile(markerPath, 'r+')
    await handle.truncate(0)
    await handle.writeFile(`${canonicalJson(initializationMarker(databasePath, 0))}\n`)
    await handle.sync()
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function removeDatabaseArtifacts(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true })
  await rm(`${databasePath}-wal`, { force: true })
  await rm(`${databasePath}-shm`, { force: true })
  await syncDirectory(dirname(databasePath))
}
