import { spawn, type ChildProcess } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export interface FileLockOptions {
  readonly timeoutMs?: number
  /**
   * Retained as part of the persistence-port contract. Linux advisory locks
   * are released by the kernel when the owning process exits, so no age-based
   * lock stealing is needed or permitted.
   */
  readonly staleAfterMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_STALE_AFTER_MS = 30_000
const ACQUIRED_MARKER = 'BRAID_LOCK_ACQUIRED\n'
const RELEASE_TIMEOUT_MS = 1_000

interface SecureDirectory {
  readonly descriptor: FileHandle
  readonly path: string
}

export class FileLockTimeoutError extends Error {
  constructor(path: string) {
    super(`Timed out waiting for the file lock for ${path}`)
    this.name = 'FileLockTimeoutError'
  }
}

function lockPath(resource: string): string {
  const target = resolve(resource)
  return join(dirname(target), `.${basename(target)}.braid.lock`)
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error
    ? ((error as { readonly code?: unknown }).code as string | undefined)
    : undefined
}

function childExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.race([childExit(child), delay(RELEASE_TIMEOUT_MS)])
}

/**
 * Ask a shell to hold the descriptor lock while a pipe-fed process stays alive.
 * The descriptor is opened with O_NOFOLLOW by Node, then passed as fd 3; the
 * helper never receives a resource path and cannot follow a replacement symlink.
 * Kernel ownership makes crash recovery automatic.
 */
async function tryFlock(descriptor: FileHandle, waitMs: number): Promise<ChildProcess | undefined> {
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      `flock --exclusive --nonblock 3 || exit $?; printf '${ACQUIRED_MARKER.trim()}\\n'; exec cat >/dev/null`,
    ],
    { stdio: ['pipe', 'pipe', 'pipe', descriptor.fd] },
  )
  const acquired = new Promise<'acquired' | 'busy'>((resolve, reject) => {
    let output = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      if (output.includes(ACQUIRED_MARKER)) resolve('acquired')
    })
    child.once('error', (error) => {
      reject(
        errorCode(error) === 'ENOENT'
          ? new Error('The Linux flock utility is required for profile persistence')
          : error,
      )
    })
    child.once('exit', () => resolve('busy'))
  })
  try {
    const outcome = await Promise.race([acquired, delay(waitMs).then(() => 'busy' as const)])
    if (outcome === 'acquired') return child
    await stopChild(child)
    return undefined
  } catch (error) {
    await stopChild(child)
    throw error
  }
}

async function acquire(path: string, options: Required<FileLockOptions>): Promise<ChildProcess> {
  if (process.platform !== 'linux') {
    throw new Error('Braid profile persistence requires Linux advisory file locks')
  }
  const deadline = Date.now() + options.timeoutMs
  const parentPath = dirname(path)
  await rejectSymlinkDirectory(parentPath)
  await mkdir(parentPath, { recursive: true, mode: 0o700 })
  const parent = await openSecureDirectory(parentPath)
  let descriptor: FileHandle | undefined
  try {
    await parent.descriptor.chmod(0o700)
    descriptor = await open(
      join(parent.path, basename(path)),
      fsConstants.O_CREAT | fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    )
    const stats = await descriptor.stat()
    if (!stats.isFile() || stats.nlink > 1) {
      throw new Error('Refusing a multiply-linked or non-regular file lock')
    }
    await descriptor.chmod(0o600)
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new FileLockTimeoutError(path)
      const child = await tryFlock(descriptor, Math.min(50, remaining))
      if (child !== undefined) {
        await descriptor.close()
        descriptor = undefined
        return child
      }
    }
  } catch (error) {
    await descriptor?.close().catch(() => undefined)
    throw error
  } finally {
    await parent.descriptor.close().catch(() => undefined)
  }
}

/** Reject an already-linked parent before recursive creation can follow it. */
async function rejectSymlinkDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  let cursor = resolve('/')
  for (const component of absolute.split('/').filter((entry) => entry.length > 0)) {
    const next = join(cursor, component)
    try {
      const entry = await lstat(next)
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to use a symbolic-link lock directory: ${absolute}`)
      }
      if (!entry.isDirectory()) {
        throw new Error(`Refusing to use a non-directory lock parent: ${absolute}`)
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    cursor = next
  }
}

async function openSecureDirectory(path: string): Promise<SecureDirectory> {
  const absolute = resolve(path)
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0)
  if (process.platform !== 'linux') {
    if ((await realpath(absolute)) !== absolute) {
      throw new Error(`Refusing to use a symbolic-link lock directory: ${absolute}`)
    }
    const descriptor = await open(absolute, flags)
    return Object.freeze({ descriptor, path: absolute })
  }
  let descriptor = await open('/', flags)
  try {
    for (const component of absolute.split('/').filter((entry) => entry.length > 0)) {
      const parent = descriptor
      const child = await open(`/proc/self/fd/${parent.fd}/${component}`, flags)
      await parent.close()
      descriptor = child
    }
    return Object.freeze({ descriptor, path: `/proc/self/fd/${descriptor.fd}` })
  } catch (error) {
    await descriptor.close().catch(() => undefined)
    if (errorCode(error) === 'ELOOP' || errorCode(error) === 'EMLINK') {
      throw new Error(`Refusing to use a symbolic-link lock directory: ${absolute}`)
    }
    throw error
  }
}

export async function withFileLock<T>(
  resource: string,
  work: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const settings: Required<FileLockOptions> = {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  }
  if (!Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs <= 0) {
    throw new Error('File lock timeout must be a positive integer')
  }
  if (!Number.isSafeInteger(settings.staleAfterMs) || settings.staleAfterMs <= 0) {
    throw new Error('File lock stale interval must be a positive integer')
  }
  const child = await acquire(lockPath(resource), settings)
  try {
    return await work()
  } finally {
    child.stdin?.end()
    await Promise.race([childExit(child), delay(RELEASE_TIMEOUT_MS).then(() => stopChild(child))])
  }
}

export function fileLockPath(resource: string): string {
  return lockPath(resource)
}
