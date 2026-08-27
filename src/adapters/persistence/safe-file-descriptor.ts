import { closeSync, constants, fstatSync, openSync } from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import {
  mkdirAt as mkdirRelative,
  openAt as openRelative,
  unlinkAt as unlinkRelative,
} from './posix-at.js'

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
const LEAF_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW

// Koffi calls the operating system's openat family. Every component remains below
// the descriptor acquired for its parent; unsupported platforms reject before path I/O.

export type SafeFileErrorCode =
  | 'SAFE_FILE_DESCRIPTOR_CHANGED'
  | 'SAFE_FILE_INVALID_LIMIT'
  | 'SAFE_FILE_INVALID_PATH'
  | 'SAFE_FILE_LOCK_NOT_OWNED'
  | 'SAFE_FILE_NOT_DIRECTORY'
  | 'SAFE_FILE_NOT_REGULAR'
  | 'SAFE_FILE_PATH_RACE_UNSUPPORTED'
  | 'SAFE_FILE_PUBLISHED_INVALID'
  | 'SAFE_FILE_PRIVATE_PERMISSIONS'
  | 'SAFE_FILE_SYMLINK'

/** A fail-closed error from the private filesystem boundary. */
export class SafeFileError extends Error {
  readonly code: SafeFileErrorCode

  constructor(code: SafeFileErrorCode, message: string) {
    super(message)
    this.name = 'SafeFileError'
    this.code = code
  }
}

export interface SafePath {
  readonly absolute: string
  readonly root: string
  readonly components: readonly string[]
}

export interface DescriptorIdentity {
  readonly device: bigint
  readonly inode: bigint
}

export interface OpenParent {
  readonly path: SafePath
  readonly fd: number
  readonly identity: DescriptorIdentity
  readonly leaf: string
  readonly leafPath: string
}

function assertSupportedPlatform(): void {
  if (process.platform === 'linux' || process.platform === 'darwin') return
  throw new SafeFileError(
    'SAFE_FILE_PATH_RACE_UNSUPPORTED',
    `Descriptor-relative private-file access is unavailable on ${process.platform}; refusing the unsafe path operation`,
  )
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function safePath(path: string): SafePath {
  assertSupportedPlatform()
  if (path.includes('\u0000')) {
    throw new SafeFileError(
      'SAFE_FILE_INVALID_PATH',
      'Private storage paths must not contain NUL bytes',
    )
  }
  const absolute = resolve(path)
  const root = parse(absolute).root
  const components = absolute.slice(root.length).split(sep).filter(Boolean)
  if (components.some((component) => component === '.' || component === '..')) {
    throw new SafeFileError(
      'SAFE_FILE_INVALID_PATH',
      `Private storage path is not canonical: ${path}`,
    )
  }
  return { absolute, root, components }
}

export function componentPath(path: SafePath, count: number): string {
  return join(path.root, ...path.components.slice(0, count))
}

function assertLeaf(leaf: string): void {
  if (
    leaf.length === 0 ||
    leaf === '.' ||
    leaf === '..' ||
    leaf.includes('/') ||
    leaf.includes('\\')
  ) {
    throw new SafeFileError(
      'SAFE_FILE_INVALID_PATH',
      'Private storage path contains an invalid component',
    )
  }
}

export function normalizePathError(error: unknown, path: string): unknown {
  if (errorCode(error) === 'ELOOP') {
    return new SafeFileError(
      'SAFE_FILE_SYMLINK',
      `Private storage path must not contain a symbolic link: ${path}`,
    )
  }
  return error
}

export function requireDirectory(handle: number, path: string): void {
  if (!fstatSync(handle).isDirectory()) {
    throw new SafeFileError(
      'SAFE_FILE_NOT_DIRECTORY',
      `Private storage path is not a directory: ${path}`,
    )
  }
}

export function requirePrivateDirectory(handle: number, path: string, mode = 0o700): void {
  const stats = fstatSync(handle)
  if (!stats.isDirectory()) {
    throw new SafeFileError(
      'SAFE_FILE_NOT_DIRECTORY',
      `Private storage path is not a directory: ${path}`,
    )
  }
  if ((stats.mode & 0o7777) !== mode) {
    throw new SafeFileError(
      'SAFE_FILE_PRIVATE_PERMISSIONS',
      `Private storage directory must have mode ${mode.toString(8).padStart(4, '0')}: ${path}`,
    )
  }
}

export function descriptorIdentity(handle: number): DescriptorIdentity {
  const stats = fstatSync(handle, { bigint: true })
  return Object.freeze({ device: stats.dev, inode: stats.ino })
}

export function requireDescriptorIdentity(
  handle: number,
  expected: DescriptorIdentity,
  path: string,
): void {
  let actual: DescriptorIdentity
  try {
    actual = descriptorIdentity(handle)
  } catch {
    throw new SafeFileError(
      'SAFE_FILE_DESCRIPTOR_CHANGED',
      `Private storage descriptor is no longer valid for its opened path: ${path}`,
    )
  }
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new SafeFileError(
      'SAFE_FILE_DESCRIPTOR_CHANGED',
      `Private storage descriptor no longer identifies its opened path: ${path}`,
    )
  }
}

export function requireRegularFile(handle: number, path: string): void {
  if (!fstatSync(handle).isFile()) {
    throw new SafeFileError(
      'SAFE_FILE_NOT_REGULAR',
      `Private storage path is not a regular file: ${path}`,
    )
  }
}

export function openDirectoryComponents(path: SafePath, count: number): number {
  let currentFd: number | undefined
  try {
    currentFd = openSync(path.root, DIRECTORY_FLAGS)
    requireDirectory(currentFd, path.root)
    let currentPath = path.root
    for (const component of path.components.slice(0, count)) {
      const nextPath = join(currentPath, component)
      let nextFd: number
      try {
        assertLeaf(component)
        nextFd = openRelative(currentFd, component, DIRECTORY_FLAGS)
      } catch (error) {
        throw normalizePathError(error, nextPath)
      }
      try {
        requireDirectory(nextFd, nextPath)
      } catch (error) {
        closeSync(nextFd)
        throw error
      }
      const previousFd = currentFd
      currentFd = nextFd
      currentPath = nextPath
      closeSync(previousFd)
    }
    const result = currentFd
    currentFd = undefined
    return result
  } finally {
    if (currentFd !== undefined) closeSync(currentFd)
  }
}

function openedParent(parsed: SafePath, directoryFd: number): OpenParent {
  if (parsed.components.length === 0) {
    closeSync(directoryFd)
    throw new SafeFileError(
      'SAFE_FILE_NOT_REGULAR',
      `Private storage path is not a regular file: ${parsed.absolute}`,
    )
  }
  const parentCount = parsed.components.length - 1
  const leaf = parsed.components[parsed.components.length - 1]
  if (leaf === undefined) {
    closeSync(directoryFd)
    throw new SafeFileError(
      'SAFE_FILE_INVALID_PATH',
      `Private storage path has no file name: ${parsed.absolute}`,
    )
  }
  try {
    return Object.freeze({
      path: parsed,
      fd: directoryFd,
      identity: descriptorIdentity(directoryFd),
      leaf,
      leafPath: join(componentPath(parsed, parentCount), leaf),
    })
  } catch (error) {
    closeSync(directoryFd)
    throw error
  }
}

export function openParent(path: string): OpenParent {
  const parsed = safePath(path)
  const directoryFd = openDirectoryComponents(parsed, Math.max(0, parsed.components.length - 1))
  return openedParent(parsed, directoryFd)
}

export function requireOpenParentIdentity(parent: OpenParent): void {
  const parentPath = componentPath(parent.path, parent.path.components.length - 1)
  requireDescriptorIdentity(parent.fd, parent.identity, parentPath)
  requireDirectory(parent.fd, parentPath)
}

export function openChild(
  directoryFd: number,
  leaf: string,
  path: string,
  flags: number,
  mode?: number,
): number {
  assertLeaf(leaf)
  try {
    return mode === undefined
      ? openRelative(directoryFd, leaf, flags)
      : openRelative(directoryFd, leaf, flags, mode)
  } catch (error) {
    throw normalizePathError(error, path)
  }
}

export function openLeaf(parent: OpenParent, flags: number, mode?: number): number {
  return openChild(parent.fd, parent.leaf, parent.leafPath, flags, mode)
}

export function openExistingLeaf(path: string): number {
  const parsed = safePath(path)
  if (parsed.components.length === 0) {
    try {
      return openSync(parsed.root, LEAF_FLAGS)
    } catch (error) {
      throw normalizePathError(error, parsed.absolute)
    }
  }
  const parent = openParent(path)
  let handle: number | undefined
  let parentClosed = false
  try {
    handle = openLeaf(parent, LEAF_FLAGS)
    closeSync(parent.fd)
    parentClosed = true
    return handle
  } catch (error) {
    if (handle !== undefined) closeSync(handle)
    throw error
  } finally {
    if (!parentClosed) {
      try {
        closeSync(parent.fd)
      } catch {
        // Preserve the operation error; the descriptor is already on the failure path.
      }
    }
  }
}

export function unlinkAt(parentFd: number, leaf: string, path: string): void {
  assertLeaf(leaf)
  try {
    unlinkRelative(parentFd, leaf)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw normalizePathError(error, path)
  }
}

/** Performs a one-shot descriptor-relative symlink check; it is not a later path-operation proof. */
export function assertNoSymlinkPath(path: string): void {
  const parsed = safePath(path)
  if (parsed.components.length === 0) return
  let parent: OpenParent | undefined
  try {
    parent = openParent(path)
    let handle: number | undefined
    try {
      handle = openLeaf(parent, LEAF_FLAGS)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return
      throw error
    } finally {
      if (handle !== undefined) closeSync(handle)
    }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  } finally {
    if (parent !== undefined) closeSync(parent.fd)
  }
}

/** Verifies that an existing path is a real directory through a stable descriptor. */
export function assertSafeDirectory(path: string): void {
  const parsed = safePath(path)
  const handle = openDirectoryComponents(parsed, parsed.components.length)
  closeSync(handle)
}

function openOrCreatePrivateDirectoryComponents(
  parsed: SafePath,
  count: number,
  mode: number,
): number {
  let currentFd: number | undefined
  try {
    currentFd = openSync(parsed.root, DIRECTORY_FLAGS)
    requireDirectory(currentFd, parsed.root)
    let currentPath = parsed.root
    for (const component of parsed.components.slice(0, count)) {
      const nextPath = join(currentPath, component)
      let nextFd: number | undefined
      for (;;) {
        try {
          assertLeaf(component)
          nextFd = openRelative(currentFd, component, DIRECTORY_FLAGS)
          break
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw normalizePathError(error, nextPath)
          try {
            mkdirRelative(currentFd, component, mode)
          } catch (mkdirError) {
            if (errorCode(mkdirError) !== 'EEXIST') {
              throw normalizePathError(mkdirError, nextPath)
            }
          }
        }
      }
      try {
        requireDirectory(nextFd, nextPath)
      } catch (error) {
        closeSync(nextFd)
        throw error
      }
      const previousFd = currentFd
      currentFd = nextFd
      currentPath = nextPath
      closeSync(previousFd)
    }
    if (count > 0) requirePrivateDirectory(currentFd, componentPath(parsed, count), mode)
    const result = currentFd
    currentFd = undefined
    return result
  } finally {
    if (currentFd !== undefined) closeSync(currentFd)
  }
}

/** Opens one newly created or existing private parent without reopening it by path. */
export function openOrCreatePrivateParent(path: string, mode = 0o700): OpenParent {
  const parsed = safePath(path)
  if (parsed.components.length === 0) {
    throw new SafeFileError(
      'SAFE_FILE_NOT_REGULAR',
      `Private storage path is not a regular file: ${parsed.absolute}`,
    )
  }
  const parentCount = parsed.components.length - 1
  const directoryFd = openOrCreatePrivateDirectoryComponents(parsed, parentCount, mode)
  try {
    requirePrivateDirectory(directoryFd, componentPath(parsed, parentCount), mode)
  } catch (error) {
    closeSync(directoryFd)
    throw error
  }
  return openedParent(parsed, directoryFd)
}

/** Creates missing private directories without resolving a renamed parent by path. */
export function ensurePrivateDirectory(path: string, mode = 0o700): void {
  const parsed = safePath(path)
  const directoryFd = openOrCreatePrivateDirectoryComponents(parsed, parsed.components.length, mode)
  closeSync(directoryFd)
}

export { DIRECTORY_FLAGS, LEAF_FLAGS }
