import { closeSync, constants, fchmodSync, fstatSync, openSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { openAt, unlinkAt } from '../persistence/posix-at.js'
import type { SqliteDatabase, SqliteDatabaseFactory } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'

export interface BoundSqliteDatabase {
  readonly database: SqliteDatabase
  readonly fileDescriptor: number
  readonly newDatabase: boolean
}

const REQUIRED_PARENT_FLAGS = constants.O_DIRECTORY | (constants.O_NOFOLLOW ?? 0)
const REQUIRED_FILE_FLAGS = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)

function unsupported(message: string): StorageError {
  return new StorageError('STORAGE_PATH_RACE_UNSUPPORTED', message)
}

function descriptorPath(fileDescriptor: number): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fileDescriptor}`
  if (process.platform === 'darwin') return `/dev/fd/${fileDescriptor}`
  throw unsupported('This platform has no inode-bound SQLite descriptor path')
}

function sameInode(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertOwnedDirectory(metadata: ReturnType<typeof fstatSync>, path: string): void {
  if (!metadata.isDirectory()) throw new StorageError('STORAGE_PATH', `Not a directory: ${path}`)
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new StorageError(
      'STORAGE_OWNERSHIP',
      `Storage directory is not owned by this process: ${path}`,
    )
  }
  if ((Number(metadata.mode) & 0o077) !== 0)
    throw new StorageError('STORAGE_PERMISSIONS', `Storage directory is too permissive: ${path}`)
}

function assertOwnedDatabase(metadata: ReturnType<typeof fstatSync>, path: string): void {
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new StorageError(
      'STORAGE_INPUT_IDENTITY',
      `SQLite path must be a single-linked regular file: ${path}`,
    )
  }
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new StorageError('STORAGE_OWNERSHIP', `SQLite path is not owned by this process: ${path}`)
  }
}

function openDirectoryChain(path: string): number {
  let descriptor = openSync('/', REQUIRED_PARENT_FLAGS)
  try {
    for (const component of resolve(path).split('/').filter(Boolean)) {
      const next = openAt(descriptor, component, REQUIRED_PARENT_FLAGS)
      closeSync(descriptor)
      descriptor = next
    }
    return descriptor
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function openDatabaseFile(
  parentDescriptor: number,
  path: string,
): { readonly fileDescriptor: number; readonly newDatabase: boolean } {
  const name = basename(path)
  const createFlags = REQUIRED_FILE_FLAGS | constants.O_CREAT | constants.O_EXCL
  try {
    return { fileDescriptor: openAt(parentDescriptor, name, createFlags, 0o600), newDatabase: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return {
      fileDescriptor: openAt(parentDescriptor, name, REQUIRED_FILE_FLAGS),
      newDatabase: false,
    }
  }
}

/**
 * Opens SQLite through an inode-bound descriptor path.
 *
 * The native driver only accepts a filename, so the filename must refer to a
 * descriptor we already opened with O_NOFOLLOW. The descriptor remains open
 * until the owning storage closes the database.
 */
export function openBoundSqliteDatabase(
  path: string,
  factory: SqliteDatabaseFactory,
  timeout: number,
): BoundSqliteDatabase {
  if (
    process.platform === 'win32' ||
    constants.O_NOFOLLOW === undefined ||
    constants.O_DIRECTORY === undefined
  ) {
    throw unsupported('This platform cannot provide no-follow inode-bound SQLite opening')
  }
  if ((REQUIRED_PARENT_FLAGS & constants.O_NOFOLLOW) === 0) {
    throw unsupported('The platform did not expose O_NOFOLLOW')
  }
  const normalizedPath = resolve(path)
  const parentDescriptor = openDirectoryChain(dirname(normalizedPath))
  let fileDescriptor: number | undefined
  let database: SqliteDatabase | undefined
  let created = false
  let openedMetadata: ReturnType<typeof fstatSync> | undefined
  try {
    const parentBefore = fstatSync(parentDescriptor)
    assertOwnedDirectory(parentBefore, dirname(normalizedPath))
    const opened = openDatabaseFile(parentDescriptor, normalizedPath)
    fileDescriptor = opened.fileDescriptor
    created = opened.newDatabase
    const parentAfter = fstatSync(parentDescriptor)
    if (!sameInode(parentBefore, parentAfter)) {
      throw new StorageError('STORAGE_PATH_RACE', 'SQLite parent directory changed during open')
    }
    const metadata = fstatSync(fileDescriptor)
    openedMetadata = metadata
    assertOwnedDatabase(metadata, normalizedPath)
    if (!opened.newDatabase && metadata.size === 0) {
      throw new StorageError(
        'STORAGE_CORRUPT_EMPTY',
        `Existing SQLite path is empty: ${normalizedPath}`,
      )
    }
    fchmodSync(fileDescriptor, 0o600)
    database = factory(descriptorPath(fileDescriptor), { timeout })
    return { database, fileDescriptor, newDatabase: opened.newDatabase }
  } catch (error) {
    try {
      database?.close()
    } catch {
      // Preserve the original open error.
    }
    if (fileDescriptor !== undefined) closeSync(fileDescriptor)
    if (created) {
      try {
        const name = basename(normalizedPath)
        const currentDescriptor = openAt(parentDescriptor, name, REQUIRED_FILE_FLAGS)
        try {
          const current = fstatSync(currentDescriptor)
          if (openedMetadata !== undefined && sameInode(openedMetadata, current))
            unlinkAt(parentDescriptor, name)
        } finally {
          closeSync(currentDescriptor)
        }
      } catch {
        // The path may have been replaced; never remove an unverified inode.
      }
    }
    if (error instanceof StorageError) throw error
    throw new StorageError('STORAGE_PATH', `Cannot open SQLite path: ${normalizedPath}`, {
      cause: error,
    })
  } finally {
    closeSync(parentDescriptor)
  }
}

export function closeBoundSqliteDatabase(bound: BoundSqliteDatabase): void {
  try {
    bound.database.close()
  } finally {
    closeSync(bound.fileDescriptor)
  }
}

export function bindDescriptorLifetime(
  database: SqliteDatabase,
  fileDescriptor: number,
): SqliteDatabase {
  const close = database.close.bind(database)
  let closed = false
  database.close = () => {
    if (closed) return
    closed = true
    try {
      close()
    } finally {
      closeSync(fileDescriptor)
    }
  }
  return database
}
