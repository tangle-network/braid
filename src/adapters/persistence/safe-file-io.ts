import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  readSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { linkAt, renameAt } from './posix-at.js'
import {
  componentPath,
  errorCode,
  normalizePathError,
  type OpenParent,
  openChild,
  openDirectoryComponents,
  openExistingLeaf,
  openLeaf,
  openParent,
  requireRegularFile,
  SafeFileError,
  safePath,
  unlinkAt,
} from './safe-file-descriptor.js'

const CREATE_FLAGS =
  // O_EXCL makes the directory entry creation no-clobber; the temporary publication is anchored below.
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NONBLOCK |
  constants.O_NOFOLLOW

export interface PrivateFileWriteOptions {
  readonly overwrite: boolean
  readonly expected?: (current: Buffer | undefined) => void
  readonly maxExistingBytes?: number
  readonly verify?: (bytes: Buffer) => void
  readonly onPhase?: (phase: PrivateFileWritePhase) => void
}

export type PrivateFileWritePhase =
  | 'temporary-written'
  | 'temporary-fsynced'
  | 'renamed'
  | 'directory-fsynced'

function validateMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new SafeFileError(
      'SAFE_FILE_INVALID_LIMIT',
      'Private storage byte limits must be non-negative integers',
    )
  }
}

function readHandle(handle: number, path: string, maxBytes: number): Buffer {
  const stats = fstatSync(handle)
  if (!stats.isFile()) {
    throw new SafeFileError(
      'SAFE_FILE_NOT_REGULAR',
      `Private storage path is not a regular file: ${path}`,
    )
  }
  if (stats.size > maxBytes) throw new Error('Private storage file is too large')
  const chunks: Buffer[] = []
  let total = 0
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes))
  for (;;) {
    const count = readSync(handle, buffer, 0, buffer.byteLength, null)
    if (count === 0) break
    total += count
    if (total > maxBytes) throw new Error('Private storage file is too large')
    chunks.push(Buffer.from(buffer.subarray(0, count)))
  }
  return Buffer.concat(chunks, total)
}

export function readAt(
  directoryFd: number,
  leaf: string,
  path: string,
  maxBytes: number,
): Buffer | undefined {
  let handle: number | undefined
  try {
    try {
      handle = openChild(directoryFd, leaf, path, safeLeafFlags())
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw normalizePathError(error, path)
    }
    return readHandle(handle, path, maxBytes)
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

function safeLeafFlags(): number {
  return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
}

function assertExistingRegularAt(parent: OpenParent): void {
  let handle: number | undefined
  try {
    try {
      handle = openLeaf(parent, safeLeafFlags())
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    }
    requireRegularFile(handle, parent.leafPath)
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

function writeAll(handle: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    offset += writeSync(handle, bytes, offset, bytes.byteLength - offset)
  }
}

function writeTemporary(
  parent: OpenParent,
  temporary: string,
  bytes: Buffer,
  onPhase?: PrivateFileWriteOptions['onPhase'],
): void {
  const temporaryPath = join(
    componentPath(parent.path, parent.path.components.length - 1),
    temporary,
  )
  let handle: number | undefined
  try {
    try {
      handle = openChild(parent.fd, temporary, temporaryPath, CREATE_FLAGS, 0o600)
    } catch (error) {
      throw normalizePathError(error, temporaryPath)
    }
    requireRegularFile(handle, `${parent.leafPath}.${temporary}`)
    writeAll(handle, bytes)
    onPhase?.('temporary-written')
    fsyncSync(handle)
    onPhase?.('temporary-fsynced')
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

export function readNoFollow(path: string, maxBytes: number): Buffer | undefined {
  validateMaxBytes(maxBytes)
  let handle: number | undefined
  try {
    handle = openExistingLeaf(path)
    return readHandle(handle, safePath(path).absolute, maxBytes)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

/** Removes one private regular file through its opened parent directory. */
export function removePrivateFile(path: string): void {
  const parent = openParent(path)
  let handle: number | undefined
  try {
    try {
      handle = openLeaf(parent, safeLeafFlags())
      requireRegularFile(handle, parent.leafPath)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw normalizePathError(error, parent.leafPath)
    } finally {
      if (handle !== undefined) closeSync(handle)
    }
    unlinkAt(parent.fd, parent.leaf, parent.leafPath)
    fsyncSync(parent.fd)
  } finally {
    closeSync(parent.fd)
  }
}

export function ensurePrivateFile(path: string): void {
  let handle: number | undefined
  try {
    handle = openExistingLeaf(path)
    requireRegularFile(handle, safePath(path).absolute)
    fchmodSync(handle, 0o600)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

export function fsyncDirectory(path: string): void {
  const parsed = safePath(path)
  const handle = openDirectoryComponents(parsed, parsed.components.length)
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
}

/**
 * Publishes a private file with a stable parent descriptor.
 * No-follow and regular-file checks happen on descriptors; unsupported platforms reject before any path I/O.
 * Node core has no renameat/linkat, so publication uses the platform descriptor namespace
 * and verifies the published bytes afterward; that closes the parent race without claiming
 * a stronger conditional-replacement guarantee than the available primitives provide.
 */
export function replacePrivateFile(
  path: string,
  value: string | Buffer,
  options: PrivateFileWriteOptions,
): void {
  const parent = openParent(path)
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  const temporary = `.${parent.leaf}.${randomUUID()}.tmp`
  const temporaryPath = join(
    componentPath(parent.path, parent.path.components.length - 1),
    temporary,
  )
  let temporaryExists = false
  let failure: unknown
  let cleanupFailure: unknown
  try {
    if (options.expected !== undefined) {
      const current = readAt(
        parent.fd,
        parent.leaf,
        parent.leafPath,
        options.maxExistingBytes ?? bytes.byteLength,
      )
      options.expected(current)
    }
    assertExistingRegularAt(parent)
    temporaryExists = true
    writeTemporary(parent, temporary, bytes, options.onPhase)
    const written = readAt(parent.fd, temporary, temporaryPath, bytes.byteLength)
    if (written === undefined || !written.equals(bytes)) {
      throw new SafeFileError(
        'SAFE_FILE_PUBLISHED_INVALID',
        `Private storage temporary file could not be verified: ${temporaryPath}`,
      )
    }
    options.verify?.(written)
    try {
      if (options.overwrite) renameAt(parent.fd, temporary, parent.fd, parent.leaf)
      else linkAt(parent.fd, temporary, parent.fd, parent.leaf)
    } catch (error) {
      throw normalizePathError(error, parent.leafPath)
    }
    if (options.overwrite) {
      temporaryExists = false
    } else {
      unlinkAt(parent.fd, temporary, temporaryPath)
      temporaryExists = false
    }
    options.onPhase?.('renamed')
    fsyncSync(parent.fd)
    options.onPhase?.('directory-fsynced')
    const published = readAt(parent.fd, parent.leaf, parent.leafPath, bytes.byteLength)
    if (published === undefined || !published.equals(bytes)) {
      throw new SafeFileError(
        'SAFE_FILE_PUBLISHED_INVALID',
        `Private storage file could not be verified after publication: ${parent.leafPath}`,
      )
    }
  } catch (error) {
    failure = error
  } finally {
    if (temporaryExists) {
      try {
        unlinkAt(parent.fd, temporary, temporaryPath)
      } catch (error) {
        cleanupFailure = error
      }
    }
    try {
      closeSync(parent.fd)
    } catch (error) {
      cleanupFailure ??= error
    }
  }
  if (failure !== undefined) throw failure
  if (cleanupFailure !== undefined) throw cleanupFailure
}

export function writePrivateFile(path: string, value: string | Buffer): void {
  replacePrivateFile(path, value, { overwrite: false })
}
