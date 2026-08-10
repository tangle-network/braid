import { closeSync, constants, fchmodSync, fstatSync, openSync, statSync } from 'node:fs'
import { chmod, lstat, mkdir, open as openFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StorageError } from './sqlite-errors.js'

export function validatePath(path: string, field: string): string {
  if (!isAbsolute(path)) throw new StorageError('STORAGE_PATH', `${field} must be an absolute path`)
  return resolve(path)
}

export function isInsideRoot(path: string, root: string): boolean {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

export async function assertApprovedPath(
  path: string,
  root: string,
  field: string,
  allowMissing = true,
): Promise<void> {
  const candidate = validatePath(path, field)
  const approved = validatePath(root, 'Approved root')
  if (!isInsideRoot(candidate, approved)) {
    throw new StorageError('STORAGE_APPROVED_ROOT', `${field} must remain inside the approved root`)
  }
  const rootStat = await lstat(approved).catch((error: unknown) => {
    throw new StorageError('STORAGE_APPROVED_ROOT', 'Approved root could not be inspected', {
      cause: error,
    })
  })
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new StorageError('STORAGE_APPROVED_ROOT', 'Approved root must be a directory')
  const components = candidate.slice(approved.length).split(sep).filter(Boolean)
  let current = approved
  for (const component of components) {
    current = join(current, component)
    try {
      const entry = await lstat(current)
      if (entry.isSymbolicLink()) {
        throw new StorageError('STORAGE_SYMLINK', `${field} contains a symbolic link`)
      }
      if (current !== candidate && !entry.isDirectory()) {
        throw new StorageError('STORAGE_PATH', `${field} contains a non-directory component`)
      }
    } catch (error) {
      if (error instanceof StorageError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissing) break
      throw new StorageError('STORAGE_PATH', `Cannot inspect ${field}`, { cause: error })
    }
  }
}

export function isNewDatabaseFile(path: string): boolean {
  try {
    const size = statSync(path).size
    if (size === 0) {
      throw new StorageError('STORAGE_CORRUPT_EMPTY', `Existing SQLite path is empty: ${path}`)
    }
    return false
  } catch (error) {
    if (error instanceof StorageError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw new StorageError('STORAGE_PATH', `Cannot inspect SQLite path ${path}`, { cause: error })
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

export async function openProtectedInput(path: string, field: string) {
  let handle: Awaited<ReturnType<typeof openFile>> | undefined
  try {
    handle = await openFile(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new StorageError(
        'STORAGE_INPUT_IDENTITY',
        `${field} must be a single linked regular file`,
      )
    }
    return handle
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (error instanceof StorageError) throw error
    throw new StorageError('STORAGE_INPUT_UNREADABLE', `Cannot open ${field}`, { cause: error })
  }
}

export async function copyProtectedFile(
  source: string,
  destination: string,
  field: string,
): Promise<void> {
  const sourceHandle = await openProtectedInput(source, field)
  let destinationHandle: Awaited<ReturnType<typeof openFile>> | undefined
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    destinationHandle = await openFile(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    for (;;) {
      const result = await sourceHandle.read(buffer, 0, buffer.length, null)
      if (result.bytesRead === 0) break
      let written = 0
      while (written < result.bytesRead) {
        const output = await destinationHandle.write(buffer, written, result.bytesRead - written)
        written += output.bytesWritten
      }
    }
    await destinationHandle.sync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StorageError('STORAGE_TEMP_EXISTS', `Temporary ${field} already exists`, {
        cause: error,
      })
    }
    throw error instanceof StorageError
      ? error
      : new StorageError('STORAGE_COPY_FAILED', `Could not copy ${field}`, { cause: error })
  } finally {
    buffer.fill(0)
    await destinationHandle?.close().catch(() => undefined)
    await sourceHandle.close().catch(() => undefined)
  }
}

export async function rejectSymlink(path: string, required: boolean): Promise<void> {
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink())
      throw new StorageError('STORAGE_SYMLINK', `Symlinked storage path rejected: ${path}`)
    if (required && !entry.isFile())
      throw new StorageError('STORAGE_PATH', `Storage path is not a file: ${path}`)
  } catch (error) {
    if (error instanceof StorageError) throw error
    if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function secureArtifact(path: string): Promise<void> {
  let fileDescriptor: number | undefined
  try {
    fileDescriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const metadata = fstatSync(fileDescriptor)
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new StorageError(
        'STORAGE_INPUT_IDENTITY',
        `Storage artifact is not a regular single-linked file: ${path}`,
      )
    }
    fchmodSync(fileDescriptor, 0o600)
  } catch (error) {
    throw new StorageError('STORAGE_PERMISSIONS', `Could not restrict storage artifact ${path}`, {
      cause: error,
    })
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor)
  }
}

/**
 * Restricts an artifact owned by a live SQLite connection without opening a
 * second descriptor. On Unix, closing any descriptor for the same inode can
 * cancel SQLite's process-wide advisory locks.
 */
export async function secureLiveSqliteArtifact(path: string): Promise<boolean> {
  let before: Awaited<ReturnType<typeof lstat>>
  try {
    before = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new StorageError(
      'STORAGE_PERMISSIONS',
      `Could not inspect live SQLite artifact ${path}`,
      { cause: error },
    )
  }

  try {
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new StorageError(
        'STORAGE_INPUT_IDENTITY',
        `Live SQLite artifact is not a regular single-linked file: ${path}`,
      )
    }
    if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
      throw new StorageError(
        'STORAGE_OWNERSHIP',
        `Live SQLite artifact is not owned by this process: ${path}`,
      )
    }

    await chmod(path, 0o600)

    const after = await lstat(path)
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      (typeof process.getuid === 'function' && after.uid !== process.getuid()) ||
      (after.mode & 0o777) !== 0o600
    ) {
      throw new StorageError(
        'STORAGE_INPUT_IDENTITY',
        `Live SQLite artifact changed while permissions were restricted: ${path}`,
      )
    }
    return true
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError(
      'STORAGE_PERMISSIONS',
      `Could not restrict live SQLite artifact ${path}`,
      { cause: error },
    )
  }
}

export async function syncFile(path: string): Promise<void> {
  const handle = await openFile(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await openFile(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
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

export function classifySqliteError(error: unknown): StorageError {
  if (error instanceof StorageError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/busy|locked/iu.test(message))
    return new StorageError('STORAGE_LOCKED', 'SQLite is locked', { cause: error })
  if (/full|disk|no space/iu.test(message)) {
    return new StorageError(
      'STORAGE_COMMIT_FAILED',
      'SQLite could not commit because storage is full',
      { cause: error },
    )
  }
  return new StorageError('STORAGE_COMMIT_FAILED', 'SQLite transaction failed', { cause: error })
}
