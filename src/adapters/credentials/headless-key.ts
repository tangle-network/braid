import type { Stats } from 'node:fs'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { CredentialError } from '../../ports/credentials.js'

export interface HeadlessKeyFileSource {
  readonly type: 'file'
  readonly path: string
  readonly workspaceRoot: string
}

export interface HeadlessKeyFdSource {
  readonly type: 'fd'
  readonly fd: number
  readonly workspaceRoot: string
}

export type HeadlessKeySource = HeadlessKeyFileSource | HeadlessKeyFdSource

const MAX_KEY_BYTES = 128

function isInside(path: string, root: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function assertWorkspaceExternal(path: string, workspaceRoot: string): void {
  if (isInside(path, workspaceRoot)) {
    throw new CredentialError(
      'HEADLESS_KEY_IN_WORKSPACE',
      'Headless key files must be outside the workspace',
    )
  }
}

/** Resolves a configured key relative to its protected Braid config directory. */
export function resolveHeadlessKeyPath(
  path: string,
  configDirectory: string,
  workspaceRoot: string,
): string {
  if (path.trim().length === 0) {
    throw new CredentialError('HEADLESS_KEY_SOURCE', 'A protected headless key file is required')
  }
  const absolute = isAbsolute(path) ? resolve(path) : resolve(configDirectory, path)
  assertWorkspaceExternal(absolute, workspaceRoot)
  return absolute
}

function canonicalWorkspaceRoot(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    throw new CredentialError(
      'HEADLESS_KEY_WORKSPACE',
      'The workspace root could not be resolved',
      { cause: error },
    )
  }
}

function assertNoSymlinkComponents(path: string): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    let stat: Stats
    try {
      stat = lstatSync(current)
    } catch (error) {
      throw new CredentialError('HEADLESS_KEY_UNREADABLE', `Cannot inspect key path ${current}`, {
        cause: error,
      })
    }
    if (stat.isSymbolicLink()) {
      throw new CredentialError('HEADLESS_KEY_SYMLINK', 'Symlinked headless key paths are rejected')
    }
  }
}

function assertOwnerAndMode(stat: Stats): void {
  if (!stat.isFile()) {
    throw new CredentialError('HEADLESS_KEY_NOT_FILE', 'Headless key source must be a regular file')
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new CredentialError('HEADLESS_KEY_PERMISSIONS', 'Headless key files must have mode 0600')
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new CredentialError(
      'HEADLESS_KEY_OWNER',
      'Headless key file ownership does not match the process',
    )
  }
  if (stat.nlink !== 1) {
    throw new CredentialError(
      'HEADLESS_KEY_LINK_COUNT',
      'Headless key files must have exactly one filesystem link',
    )
  }
}

function parseKey(bytes: Buffer): Buffer {
  if (bytes.length === 32) return Buffer.from(bytes)
  if (bytes.length > MAX_KEY_BYTES) {
    throw new CredentialError('HEADLESS_KEY_SIZE', 'Headless key input is too large')
  }
  const text = bytes.toString('utf8').trim()
  if (!/^[0-9a-f]{64}$/iu.test(text)) {
    throw new CredentialError(
      'HEADLESS_KEY_FORMAT',
      'Headless keys must be 32 bytes or 64 hexadecimal characters',
    )
  }
  return Buffer.from(text, 'hex')
}

function descriptorPath(fd: number): string | undefined {
  try {
    const path = readlinkSync(`/proc/self/fd/${fd}`)
    if (path.includes(' (deleted)')) {
      throw new CredentialError(
        'HEADLESS_KEY_FD_DELETED',
        'Deleted headless key files are rejected',
      )
    }
    return isAbsolute(path) ? resolve(path) : undefined
  } catch (error) {
    if (error instanceof CredentialError) throw error
    return undefined
  }
}

function assertDescriptorPath(
  fd: number,
  sourcePath: string,
  workspaceRoot: string,
  descriptorStat: Stats,
): void {
  const canonicalWorkspace = canonicalWorkspaceRoot(workspaceRoot)
  const actualPath = descriptorPath(fd)
  if (actualPath) {
    assertWorkspaceExternal(actualPath, canonicalWorkspace)
    return
  }

  let canonicalPath: string
  let pathStat: Stats
  try {
    canonicalPath = realpathSync(sourcePath)
    pathStat = statSync(canonicalPath)
  } catch (error) {
    throw new CredentialError(
      'HEADLESS_KEY_PATH_CHANGED',
      'The headless key path changed while it was being opened',
      { cause: error },
    )
  }
  if (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino) {
    throw new CredentialError(
      'HEADLESS_KEY_PATH_CHANGED',
      'The headless key path changed while it was being opened',
    )
  }
  assertWorkspaceExternal(canonicalPath, canonicalWorkspace)
}

function inspectFd(fd: number): Stats {
  if (!Number.isInteger(fd) || fd < 3) {
    throw new CredentialError(
      'HEADLESS_KEY_FD',
      'Headless key file descriptors must be integers >= 3',
    )
  }
  let stat: Stats
  try {
    stat = fstatSync(fd)
  } catch (error) {
    throw new CredentialError(
      'HEADLESS_KEY_FD',
      'The inherited headless key descriptor is invalid',
      {
        cause: error,
      },
    )
  }
  if (stat.nlink === 0) {
    throw new CredentialError('HEADLESS_KEY_FD_DELETED', 'Deleted headless key files are rejected')
  }
  assertOwnerAndMode(stat)
  if (stat.size > MAX_KEY_BYTES) {
    throw new CredentialError('HEADLESS_KEY_SIZE', 'Headless key input is too large')
  }
  return stat
}

function readFd(fd: number, workspaceRoot: string): Buffer {
  inspectFd(fd)
  const actualPath = descriptorPath(fd)
  if (!actualPath) {
    throw new CredentialError(
      'HEADLESS_KEY_FD_PATH',
      'The inherited headless key descriptor path could not be verified',
    )
  }
  assertWorkspaceExternal(actualPath, canonicalWorkspaceRoot(workspaceRoot))
  const buffer = Buffer.alloc(MAX_KEY_BYTES + 1)
  let length = 0
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, length)
    if (count === 0) break
    length += count
  }
  if (length > MAX_KEY_BYTES) {
    buffer.fill(0)
    throw new CredentialError('HEADLESS_KEY_SIZE', 'Headless key input is too large')
  }
  try {
    return parseKey(buffer.subarray(0, length))
  } finally {
    buffer.fill(0)
  }
}

export function readHeadlessKey(source: HeadlessKeySource): Buffer {
  if (!source || typeof source !== 'object') {
    throw new CredentialError('HEADLESS_KEY_SOURCE', 'A protected file or descriptor is required')
  }
  if (source.type === 'fd') {
    if (!source.workspaceRoot) {
      throw new CredentialError(
        'HEADLESS_KEY_SOURCE',
        'Headless key descriptors require a workspace root',
      )
    }
    return readFd(source.fd, source.workspaceRoot)
  }
  if (source.type !== 'file' || !isAbsolute(source.path) || !source.workspaceRoot) {
    throw new CredentialError(
      'HEADLESS_KEY_SOURCE',
      'Headless keys require an absolute mode-0600 file path and workspace root',
    )
  }
  const fd = openHeadlessKeyFile(source.path, source.workspaceRoot)
  try {
    return readFd(fd, source.workspaceRoot)
  } finally {
    closeHeadlessKeyFile(fd)
  }
}

export function openHeadlessKeyFile(path: string, workspaceRoot: string): number {
  if (!isAbsolute(path))
    throw new CredentialError('HEADLESS_KEY_SOURCE', 'Headless key paths must be absolute')
  assertNoSymlinkComponents(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    assertOwnerAndMode(stat)
    assertDescriptorPath(fd, path, workspaceRoot, stat)
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function closeHeadlessKeyFile(fd: number): void {
  closeSync(fd)
}

export function rejectEnvironmentKeySource(value: unknown): never {
  throw new CredentialError(
    'HEADLESS_KEY_ENV_REJECTED',
    `Environment key sources are rejected (${typeof value === 'string' ? 'string' : 'unknown'})`,
  )
}
