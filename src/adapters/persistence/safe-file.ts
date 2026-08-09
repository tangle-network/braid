import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs'
import {
  childPath,
  errorCode,
  normalizePathError,
  openParent,
  requireRegularFile,
  SafeFileError,
  type SafeFileErrorCode,
  unlinkAt,
} from './safe-file-descriptor.js'
import { readAt } from './safe-file-io.js'

export {
  assertNoSymlinkPath,
  assertSafeDirectory,
  ensurePrivateDirectory,
  SafeFileError,
  type SafeFileErrorCode,
} from './safe-file-descriptor.js'
export {
  ensurePrivateFile,
  fsyncDirectory,
  removePrivateFile,
  type PrivateFileWriteOptions,
  readNoFollow,
  replacePrivateFile,
  writePrivateFile,
} from './safe-file-io.js'

const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NONBLOCK |
  constants.O_NOFOLLOW

const privateFileLocks = new Map<
  number,
  { readonly directoryFd: number; readonly leaf: string; readonly leafPath: string }
>()

/** A small crash-recovery lock; stale owners are safe to reclaim within the opened parent directory. */
export function acquirePrivateFileLock(path: string, description = 'Private storage'): number {
  const parent = openParent(path)
  for (;;) {
    let handle: number | undefined
    try {
      try {
        handle = openSync(childPath(parent.fd, parent.leaf), CREATE_FLAGS, 0o600)
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw normalizePathError(error, parent.leafPath)
        const bytes = readAt(parent.fd, parent.leaf, parent.leafPath, 128)
        const ownerText = bytes?.toString('utf8').trim()
        if (!ownerText || !/^\d+$/.test(ownerText)) {
          throw new Error(`${description} lock is corrupt or incomplete`)
        }
        const owner = Number(ownerText)
        if (!Number.isSafeInteger(owner) || owner <= 0) {
          throw new Error(`${description} lock has an invalid owner`)
        }
        try {
          process.kill(owner, 0)
          throw new Error(`${description} is busy in another process`)
        } catch (probeError) {
          if (errorCode(probeError) !== 'ESRCH') throw probeError
          unlinkAt(parent.fd, parent.leaf, parent.leafPath)
        }
        continue
      }
      requireRegularFile(handle, parent.leafPath)
      let offset = 0
      const ownerBytes = Buffer.from(`${process.pid}\n`, 'utf8')
      while (offset < ownerBytes.byteLength) {
        offset += writeSync(handle, ownerBytes, offset, ownerBytes.byteLength - offset)
      }
      fsyncSync(handle)
      privateFileLocks.set(handle, {
        directoryFd: parent.fd,
        leaf: parent.leaf,
        leafPath: parent.leafPath,
      })
      return handle
    } catch (error) {
      if (handle !== undefined) {
        closeSync(handle)
        privateFileLocks.delete(handle)
      }
      closeSync(parent.fd)
      throw error
    }
  }
}

export function releasePrivateFileLock(path: string, handle: number): void {
  const lock = privateFileLocks.get(handle)
  if (lock === undefined) {
    throw new SafeFileError(
      'SAFE_FILE_LOCK_NOT_OWNED' satisfies SafeFileErrorCode,
      `Private conversation storage lock is not owned by this process: ${path}`,
    )
  }
  privateFileLocks.delete(handle)
  let failure: unknown
  try {
    closeSync(handle)
  } catch (error) {
    failure = error
  }
  try {
    unlinkAt(lock.directoryFd, lock.leaf, lock.leafPath)
  } catch (error) {
    failure ??= error
  }
  try {
    closeSync(lock.directoryFd)
  } catch (error) {
    failure ??= error
  }
  if (failure !== undefined) throw failure
}
