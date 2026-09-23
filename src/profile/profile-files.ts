import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { type FileHandle, lstat, open, realpath, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Descriptor-bound atomic replacement.
 *
 * A path-based check followed by a path-based write is two different objects
 * whenever another writer runs in between: the baseline `lstat`/digest can pass
 * and the `rename` still overwrite a file that was swapped a microsecond later,
 * and a path-following `chmod` after the rename can land on a symlink pointing
 * outside the workspace. Every check here is performed on an open descriptor —
 * mode is set with `fchmod` before the rename, identity is re-read with `fstat`
 * immediately before it, and the directory is fsynced afterwards so the rename
 * survives a crash.
 */

export interface FileIdentity {
  readonly device: number
  readonly inode: number
  readonly size: number
  readonly digest: string
}

export class ConcurrentFileModificationError extends Error {
  constructor(path: string, detail: string) {
    super(`Profile changed since it was opened: ${path} (${detail})`)
    this.name = 'ConcurrentFileModificationError'
  }
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0
const DEFAULT_FILE_READ_BYTES = 1_048_576

interface SecureDirectory {
  readonly descriptor: FileHandle
  readonly path: string
}

async function openSecureDirectory(path: string): Promise<SecureDirectory> {
  const absolute = resolve(path)
  if (process.platform !== 'linux') return openCheckedDirectory(absolute, path)
  const flags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW
  let descriptor: FileHandle | undefined
  const opened: FileHandle[] = []
  try {
    descriptor = await open('/', flags)
    opened.push(descriptor)
    for (const component of absolute.split('/').filter((part) => part.length > 0)) {
      const child = await open(`/proc/self/fd/${descriptor.fd}/${component}`, flags)
      opened.push(child)
      await descriptor.close()
      opened.splice(opened.indexOf(descriptor), 1)
      descriptor = child
    }
    if (descriptor === undefined || !(await descriptor.stat()).isDirectory()) {
      throw new Error(`Refusing to use a changed profile directory: ${path}`)
    }
    const anchored = `/proc/self/fd/${descriptor.fd}`
    if ((await realpath(anchored)) !== absolute) {
      throw new Error(`Refusing to use a changed profile directory: ${path}`)
    }
    opened.splice(opened.indexOf(descriptor), 1)
    return Object.freeze({ descriptor, path: anchored })
  } catch (error) {
    await Promise.all(opened.reverse().map((handle) => handle.close().catch(() => undefined)))
    if (
      isErrorCode(error, 'ELOOP') ||
      isErrorCode(error, 'EMLINK') ||
      (isErrorCode(error, 'ENOTDIR') && (await resolvesThroughSymlink(absolute)))
    ) {
      throw new Error(`Refusing to use a symbolic-link directory: ${path}`)
    }
    throw error
  }
}

async function resolvesThroughSymlink(path: string): Promise<boolean> {
  try {
    return (await realpath(path)) !== resolve(path)
  } catch {
    return false
  }
}

async function openCheckedDirectory(
  absolute: string,
  displayPath: string,
): Promise<SecureDirectory> {
  const resolved = await realpath(absolute)
  if (resolved !== absolute) {
    throw new Error(`Refusing to use a symbolic-link directory: ${displayPath}`)
  }
  const expected = await lstat(absolute)
  if (!expected.isDirectory()) {
    throw new Error(`Refusing to use a changed profile directory: ${displayPath}`)
  }
  const descriptor = await open(
    absolute,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | NOFOLLOW,
  )
  try {
    const actual = await descriptor.stat()
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || !actual.isDirectory()) {
      throw new Error(`Refusing to use a changed profile directory: ${displayPath}`)
    }
    return Object.freeze({ descriptor, path: absolute })
  } catch (error) {
    await descriptor.close().catch(() => undefined)
    throw error
  }
}

async function readDescriptorBounded(
  descriptor: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(maxBytes + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await descriptor.read(buffer, offset, buffer.byteLength - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset > maxBytes) {
    throw new Error(`File exceeds the ${maxBytes}-byte read limit`)
  }
  return buffer.slice(0, offset)
}

/**
 * Read a regular file through a no-follow descriptor and report its identity.
 * `undefined` means the path does not exist; a symlink or non-regular file is an
 * error rather than a silent read of whatever it points at.
 */
export async function readFileIdentity(
  path: string,
  options: { readonly maxBytes?: number } = {},
): Promise<{ readonly bytes: Uint8Array; readonly identity: FileIdentity } | undefined> {
  const absolute = resolve(path)
  let directory: SecureDirectory
  try {
    directory = await openSecureDirectory(dirname(absolute))
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return undefined
    throw error
  }
  let descriptor: Awaited<ReturnType<typeof open>>
  try {
    descriptor = await open(
      join(directory.path, basename(absolute)),
      fsConstants.O_RDONLY | NOFOLLOW,
    )
  } catch (error) {
    await directory.descriptor.close()
    if (isErrorCode(error, 'ENOENT')) return undefined
    if (isErrorCode(error, 'ELOOP') || isErrorCode(error, 'EMLINK')) {
      throw new Error(`Refusing to read symbolic link profile target: ${path}`)
    }
    throw error
  }
  try {
    const stats = await descriptor.stat()
    if (!stats.isFile()) throw new Error(`Profile target is not a regular file: ${path}`)
    if ((stats.mode & 0o002) !== 0) {
      throw new Error(`Refusing to read a world-writable profile target: ${path}`)
    }
    if (stats.nlink > 1) {
      throw new Error(`Refusing to read a multiply-linked profile target: ${path}`)
    }
    const maxBytes = options.maxBytes ?? DEFAULT_FILE_READ_BYTES
    if (stats.size > maxBytes) {
      throw new Error(`Profile source is ${stats.size} bytes; the limit is ${maxBytes}`)
    }
    const bytes = await readDescriptorBounded(descriptor, maxBytes)
    return Object.freeze({
      bytes,
      identity: Object.freeze({
        device: Number(stats.dev),
        inode: Number(stats.ino),
        size: bytes.byteLength,
        digest: digestBytes(bytes),
      }),
    })
  } finally {
    await descriptor.close()
    await directory.descriptor.close()
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}

function identitiesMatch(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.digest === right.digest
  )
}

export interface AtomicReplaceInput {
  readonly path: string
  readonly bytes: Uint8Array
  readonly mode: number
  /**
   * The identity the caller opened. `undefined` means the caller expects the
   * target not to exist; any existing file then fails the swap.
   */
  readonly expected: FileIdentity | undefined
}

/**
 * Write `bytes` into a sibling temporary file and swap it in only while the
 * target still matches `expected`. The compare-and-swap window is the interval
 * between the final `fstat` and the `rename`, with no path resolution inside it.
 */
export async function replaceFileAtomically(input: AtomicReplaceInput): Promise<void> {
  const absolute = resolve(input.path)
  const directory = await openSecureDirectory(dirname(absolute))
  const temporary = join(
    directory.path,
    `.${basename(absolute)}.braid-${process.pid}-${process.hrtime.bigint()}.tmp`,
  )
  const target = join(directory.path, basename(absolute))
  let descriptor: Awaited<ReturnType<typeof open>> | undefined
  try {
    descriptor = await open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NOFOLLOW,
      input.mode,
    )
    await descriptor.writeFile(input.bytes)
    // Mode is set on the descriptor: a post-rename chmod(path) would follow a
    // symlink an attacker planted in the same window.
    await descriptor.chmod(input.mode)
    await descriptor.sync()
    await descriptor.close()
    descriptor = undefined

    await assertTargetUnchanged(directory, basename(absolute), input.expected)
    await rename(temporary, target)
    await syncDirectoryDescriptor(directory.descriptor)
  } catch (error) {
    if (descriptor !== undefined) await descriptor.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  } finally {
    await directory.descriptor.close().catch(() => undefined)
  }
}

async function assertTargetUnchanged(
  directory: SecureDirectory,
  name: string,
  expected: FileIdentity | undefined,
): Promise<void> {
  let current: { readonly identity: FileIdentity } | undefined
  try {
    const descriptor = await open(join(directory.path, name), fsConstants.O_RDONLY | NOFOLLOW)
    try {
      const stats = await descriptor.stat()
      if (!stats.isFile()) throw new Error(`Profile target is not a regular file: ${name}`)
      const bytes = await readDescriptorBounded(descriptor, DEFAULT_FILE_READ_BYTES)
      current = {
        identity: Object.freeze({
          device: Number(stats.dev),
          inode: Number(stats.ino),
          size: bytes.byteLength,
          digest: digestBytes(bytes),
        }),
      }
    } finally {
      await descriptor.close()
    }
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error
  }
  if (expected === undefined) {
    if (current !== undefined) {
      throw new ConcurrentFileModificationError(name, 'a file now exists at the target')
    }
    return
  }
  if (current === undefined) {
    throw new ConcurrentFileModificationError(name, 'the target was removed')
  }
  if (!identitiesMatch(current.identity, expected)) {
    throw new ConcurrentFileModificationError(name, 'the target was replaced by another writer')
  }
}

async function syncDirectoryDescriptor(handle: FileHandle): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    // Directory fsync is unavailable on some platforms and filesystems; the
    // rename itself is still atomic, so durability degrades without failing.
    if (
      !isErrorCode(error, 'EINVAL') &&
      !isErrorCode(error, 'EISDIR') &&
      !isErrorCode(error, 'EACCES')
    ) {
      throw error
    }
  }
}
