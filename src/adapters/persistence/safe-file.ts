import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  readSync,
  writeSync,
} from 'node:fs'
import { lockExclusiveNonBlocking } from './posix-at.js'
import {
  type DescriptorIdentity,
  descriptorIdentity,
  errorCode,
  normalizePathError,
  openChild,
  openParent,
  requireDescriptorIdentity,
  requireRegularFile,
  SafeFileError,
  type SafeFileErrorCode,
  unlinkAt,
} from './safe-file-descriptor.js'

export {
  assertNoSymlinkPath,
  assertSafeDirectory,
  ensurePrivateDirectory,
  requirePrivateDirectory,
  SafeFileError,
  type SafeFileErrorCode,
} from './safe-file-descriptor.js'
export {
  ensurePrivateFile,
  fsyncDirectory,
  type PrivateFileWriteOptions,
  readNoFollow,
  readPrivateFileAt,
  removePrivateFile,
  removePrivateFileAt,
  replacePrivateFile,
  replacePrivateFileAt,
  writePrivateFile,
  writePrivateFileAt,
} from './safe-file-io.js'

const LOCK_FLAGS =
  constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW
const LOCK_INSPECTION_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
const PRIVATE_FILE_LOCK_BRAND = Symbol('private-file-lock')

export interface PrivateFileLock {
  readonly [PRIVATE_FILE_LOCK_BRAND]: true
}

interface PrivateFileLockState {
  readonly directoryFd: number
  readonly directoryIdentity: DescriptorIdentity
  readonly handle: number
  readonly handleIdentity: DescriptorIdentity
  readonly leaf: string
  readonly leafPath: string
}

const privateFileLocks = new WeakMap<object, PrivateFileLockState>()

/** A small crash-recovery lock; stale owners are safe to reclaim within the opened parent directory. */
export function acquirePrivateFileLockAt(
  directoryFd: number,
  leaf: string,
  leafPath: string,
  description = 'Private storage',
): PrivateFileLock {
  let handle: number | undefined
  try {
    const directoryIdentity = descriptorIdentity(directoryFd)
    handle = openChild(directoryFd, leaf, leafPath, LOCK_FLAGS, 0o600)
    requireRegularFile(handle, leafPath)
    const handleIdentity = descriptorIdentity(handle)
    try {
      lockExclusiveNonBlocking(handle)
    } catch (error) {
      if (errorCode(error) === 'EAGAIN' || errorCode(error) === 'EWOULDBLOCK') {
        throw new Error(`${description} is busy in another process`)
      }
      throw error
    }

    validateLockOwnerRecord(readLockOwner(handle, leafPath), description)

    requireDescriptorIdentity(directoryFd, directoryIdentity, leafPath)
    requireDescriptorIdentity(handle, handleIdentity, leafPath)
    writeLockOwner(handle)
    fsyncSync(handle)
    requireDescriptorIdentity(directoryFd, directoryIdentity, leafPath)
    fsyncSync(directoryFd)
    const ownedHandle = handle
    handle = undefined
    const lock: PrivateFileLock = Object.freeze({ [PRIVATE_FILE_LOCK_BRAND]: true as const })
    privateFileLocks.set(lock, {
      directoryFd,
      directoryIdentity,
      handle: ownedHandle,
      handleIdentity,
      leaf,
      leafPath,
    })
    return lock
  } catch (error) {
    if (handle !== undefined) closeSync(handle)
    throw normalizePathError(error, leafPath)
  }
}

function writeLockOwner(handle: number): void {
  const ownerBytes = Buffer.from(`${process.pid}\n`, 'utf8')
  ftruncateSync(handle, 0)
  let offset = 0
  while (offset < ownerBytes.byteLength) {
    offset += writeSync(handle, ownerBytes, offset, ownerBytes.byteLength - offset, offset)
  }
}

function readLockOwner(handle: number, path: string): Buffer {
  const stats = fstatSync(handle)
  if (!stats.isFile()) {
    throw new SafeFileError(
      'SAFE_FILE_NOT_REGULAR',
      `Private storage path is not a regular file: ${path}`,
    )
  }
  if (stats.size > 128) throw new Error('Private storage lock owner record is too large')
  const bytes = Buffer.alloc(128)
  let total = 0
  while (total < bytes.byteLength) {
    const count = readSync(handle, bytes, total, bytes.byteLength - total, null)
    if (count === 0) break
    total += count
  }
  return bytes.subarray(0, total)
}

function validateLockOwnerRecord(record: Buffer, description: string): void {
  if (record.byteLength === 0) return
  const text = record.toString('utf8')
  if (/^[1-9]\d*$/u.test(text)) return
  if (/^[1-9]\d*\n$/u.test(text)) {
    const owner = Number(text.slice(0, -1))
    if (Number.isSafeInteger(owner)) return
    throw new Error(`${description} lock has an invalid owner record`)
  }
  throw new Error(`${description} lock has a corrupt owner record`)
}

export function acquirePrivateFileLock(
  path: string,
  description = 'Private storage',
): PrivateFileLock {
  const parent = openParent(path)
  try {
    return acquirePrivateFileLockAt(parent.fd, parent.leaf, parent.leafPath, description)
  } catch (error) {
    closeSync(parent.fd)
    throw error
  }
}

export function releasePrivateFileLock(path: string, lock: PrivateFileLock): void {
  const state = privateFileLocks.get(lock)
  if (state === undefined) {
    throw new SafeFileError(
      'SAFE_FILE_LOCK_NOT_OWNED' satisfies SafeFileErrorCode,
      `Private conversation storage lock is not owned by this process: ${path}`,
    )
  }
  privateFileLocks.delete(lock)
  let failure: unknown
  let directoryValid = false
  let handleValid = false
  try {
    requireDescriptorIdentity(state.directoryFd, state.directoryIdentity, state.leafPath)
    directoryValid = true
  } catch (error) {
    failure = error
  }
  try {
    requireDescriptorIdentity(state.handle, state.handleIdentity, state.leafPath)
    handleValid = true
  } catch (error) {
    failure ??= error
  }

  if (directoryValid && handleValid) {
    let entryHandle: number | undefined
    try {
      entryHandle = openChild(state.directoryFd, state.leaf, state.leafPath, LOCK_INSPECTION_FLAGS)
      requireRegularFile(entryHandle, state.leafPath)
      requireDescriptorIdentity(entryHandle, state.handleIdentity, state.leafPath)
      requireDescriptorIdentity(state.directoryFd, state.directoryIdentity, state.leafPath)
      requireDescriptorIdentity(state.handle, state.handleIdentity, state.leafPath)
      unlinkAt(state.directoryFd, state.leaf, state.leafPath)
      requireDescriptorIdentity(state.directoryFd, state.directoryIdentity, state.leafPath)
      fsyncSync(state.directoryFd)
    } catch (error) {
      failure ??= error
    } finally {
      if (entryHandle !== undefined) closeSync(entryHandle)
    }
  }

  if (handleValid) {
    try {
      closeSync(state.handle)
    } catch (error) {
      failure ??= error
    }
  }
  if (directoryValid) {
    try {
      closeSync(state.directoryFd)
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) throw failure
}
