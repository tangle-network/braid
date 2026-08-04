import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open as openFile, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson } from '../../domain/canonical.js'
import { StorageError } from './sqlite-errors.js'
import {
  assertApprovedPath,
  openProtectedInput,
  processIsAlive,
  syncDirectory,
} from './sqlite-paths.js'
import type { DurableBoundaryHook } from './sqlite-types.js'
import { RESTORE_MANIFEST_VERSION } from './sqlite-types.js'

export interface RestoreManifest {
  readonly version: 1
  readonly operationId: string
  readonly source: string
  readonly recovery: string
  readonly temporary: string
  readonly displaced: string
  readonly displacedWal: string
  readonly displacedSharedMemory: string
  readonly phase: 'prepared' | 'candidate-ready' | 'live-displaced' | 'installed' | 'verified'
}

export function restoreManifestPath(databasePath: string): string {
  return `${databasePath}.restore.manifest`
}

export async function readRestoreManifest(
  databasePath: string,
): Promise<RestoreManifest | undefined> {
  const path = restoreManifestPath(databasePath)
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openProtectedInput(path, 'restore manifest')
    const raw = await handle.readFile({ encoding: 'utf8' })
    if (raw.length > 16 * 1024)
      throw new StorageError('RESTORE_MANIFEST_INVALID', 'Restore manifest is too large')
    const parsed = JSON.parse(raw) as Partial<RestoreManifest>
    if (
      parsed.version !== RESTORE_MANIFEST_VERSION ||
      typeof parsed.operationId !== 'string' ||
      typeof parsed.source !== 'string' ||
      typeof parsed.recovery !== 'string' ||
      typeof parsed.temporary !== 'string' ||
      typeof parsed.displaced !== 'string' ||
      typeof parsed.displacedWal !== 'string' ||
      typeof parsed.displacedSharedMemory !== 'string' ||
      !['prepared', 'candidate-ready', 'live-displaced', 'installed', 'verified'].includes(
        parsed.phase ?? '',
      )
    ) {
      throw new StorageError('RESTORE_MANIFEST_INVALID', 'Restore manifest is invalid')
    }
    return parsed as RestoreManifest
  } catch (error) {
    throw error instanceof StorageError
      ? error
      : new StorageError('RESTORE_MANIFEST_INVALID', 'Restore manifest could not be read', {
          cause: error,
        })
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function writeRestoreManifest(
  databasePath: string,
  manifest: RestoreManifest,
  hook?: DurableBoundaryHook,
): Promise<void> {
  const path = restoreManifestPath(databasePath)
  const temporary = `${path}.write-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    hook?.(`before:restore.manifest.${manifest.phase}`)
    handle = await openFile(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    await handle.writeFile(`${canonicalJson(manifest)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await syncDirectory(dirname(databasePath))
    hook?.(`after:restore.manifest.${manifest.phase}`)
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error instanceof StorageError
      ? error
      : new StorageError('RESTORE_MANIFEST_WRITE_FAILED', 'Restore manifest could not be written', {
          cause: error,
        })
  }
}

export async function acquireExclusiveLock(path: string): Promise<{
  readonly release: () => Promise<void>
}> {
  // This file coordinates live processes only. A power loss ends every holder,
  // so forcing the file and parent directory to disk adds latency without
  // strengthening exclusion; stale files are still resolved by their PID.
  for (;;) {
    let handle: Awaited<ReturnType<typeof openFile>> | undefined
    try {
      handle = await openFile(path, 'wx', 0o600)
      await handle.writeFile(`${canonicalJson({ version: 1, pid: process.pid })}\n`)
      await handle.close()
      handle = undefined
      let released = false
      return {
        release: async () => {
          if (released) return
          released = true
          await unlink(path).catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          })
        },
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new StorageError('STORAGE_LOCK_FAILED', 'Could not acquire the storage lock', {
          cause: error,
        })
      }
      let metadata: { readonly pid?: unknown } | undefined
      let lockInput: Awaited<ReturnType<typeof openFile>> | undefined
      try {
        lockInput = await openProtectedInput(path, 'storage lock')
        if ((await lockInput.stat()).size > 1024) {
          throw new StorageError('STORAGE_LOCKED', 'Storage lock is held by another process')
        }
        metadata = JSON.parse(await lockInput.readFile({ encoding: 'utf8' })) as {
          readonly pid?: unknown
        }
      } catch {
        throw new StorageError('STORAGE_LOCKED', 'Storage lock is held by another process')
      } finally {
        await lockInput?.close().catch(() => undefined)
      }
      const pid = typeof metadata.pid === 'number' ? metadata.pid : 0
      if (processIsAlive(pid)) {
        throw new StorageError('STORAGE_LOCKED', 'Storage lock is held by another process')
      }
      await unlink(path).catch((unlinkError: unknown) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      })
    }
  }
}

export async function recoverRestoreManifest(
  databasePath: string,
  approvedRoot: string,
): Promise<void> {
  const manifest = await readRestoreManifest(databasePath)
  if (!manifest) return
  for (const [name, path] of Object.entries(manifest)) {
    if (name === 'version' || name === 'operationId' || name === 'phase') continue
    await assertApprovedPath(path, approvedRoot, `Restore manifest ${name}`, true)
  }
  const live = databasePath
  const displacedExists = await stat(manifest.displaced)
    .then(() => true)
    .catch(() => false)
  const liveExists = await stat(live)
    .then(() => true)
    .catch(() => false)
  if (manifest.phase === 'prepared' || manifest.phase === 'candidate-ready') {
    if (!liveExists && displacedExists) {
      await rename(manifest.displaced, live)
      await syncDirectory(dirname(databasePath))
    }
    await rm(manifest.temporary, { force: true })
    await syncDirectory(dirname(databasePath))
    await unlink(restoreManifestPath(databasePath)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await syncDirectory(dirname(databasePath))
    return
  }
  if (!liveExists && displacedExists) {
    await rename(manifest.displaced, live)
    await syncDirectory(dirname(databasePath))
  }
  for (const path of [
    manifest.displaced,
    manifest.displacedWal,
    manifest.displacedSharedMemory,
    manifest.temporary,
  ]) {
    await rm(path, { force: true })
    await syncDirectory(dirname(databasePath))
  }
  await unlink(restoreManifestPath(databasePath)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  await syncDirectory(dirname(databasePath))
}
