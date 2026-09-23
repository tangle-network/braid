import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { redactProviderText } from './redaction.js'

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/**
 * Containment checks for workspace-controlled paths.
 *
 * A lexical `relative()` test only inspects the string, and an `lstat` of the
 * final component only inspects the leaf: `workspace/link/config` where `link`
 * points at `/etc` passes both while reading a file outside the workspace. Every
 * parent component is resolved here, and any symlink anywhere on the path — not
 * just at the leaf — disqualifies the path.
 */

export class WorkspacePathEscapeError extends Error {
  readonly path: string

  constructor(path: string, detail: string) {
    const safePath = redactProviderText(path, 1_024) ?? '<invalid path>'
    const safeDetail = redactProviderText(detail, 256) ?? 'invalid path'
    super(`Workspace trust path escapes the workspace: ${safePath} (${safeDetail})`)
    this.name = 'WorkspacePathEscapeError'
    this.path = safePath
  }
}

export interface ContainedWorkspacePath {
  /** Path relative to the workspace root, using forward slashes. */
  readonly relativePath: string
  /** Absolute path with every parent component fully resolved. */
  readonly realPath: string
}

export interface WorkspaceRootHandle {
  readonly root: string
  readonly descriptor: FileHandle
}

export interface WorkspaceFileRead {
  readonly present: boolean
  readonly digest?: string
}

function isEnoent(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/** Resolve the workspace root, refusing a root that is itself a link. */
export async function resolveWorkspaceRoot(root: string): Promise<string> {
  const absolute = resolve(root)
  const entry = await lstat(absolute)
  if (entry.isSymbolicLink()) {
    throw new Error(`Workspace trust root contains a symbolic link: ${absolute}`)
  }
  if (!entry.isDirectory()) {
    throw new Error(`Workspace trust root is not a regular directory: ${absolute}`)
  }
  const resolved = await realpath(absolute)
  if (resolved !== absolute) {
    throw new Error(`Workspace trust root contains a symbolic link: ${absolute}`)
  }
  return resolved
}

/**
 * Verify that `candidate` stays inside `realRoot` with no symlink on any
 * component. The leaf may be absent — a declared-but-missing configuration file
 * is a legitimate trust-preview entry — but every existing component must be a
 * real directory or a regular file.
 */
export async function containedWorkspacePath(
  realRoot: string,
  candidate: string,
): Promise<ContainedWorkspacePath> {
  if (
    typeof realRoot !== 'string' ||
    !isAbsolute(realRoot) ||
    !isAbsolute(candidate) ||
    realRoot.length > 4_096 ||
    candidate.length > 4_096 ||
    candidate.includes('\0')
  ) {
    throw new WorkspacePathEscapeError(candidate, 'the path is not a usable absolute path')
  }
  const absolute = resolve(candidate)
  const lexical = relative(realRoot, absolute)
  if (lexical === '' || lexical.startsWith('..') || isAbsolute(lexical)) {
    throw new WorkspacePathEscapeError(absolute, 'the path is outside the workspace root')
  }
  const components = lexical.split(sep)
  let cursor = realRoot
  for (const [index, component] of components.entries()) {
    if (component === '.' || component === '') continue
    if (component === '..') {
      throw new WorkspacePathEscapeError(absolute, 'the path contains a parent traversal')
    }
    const next = resolve(cursor, component)
    let entry: Awaited<ReturnType<typeof lstat>>
    try {
      entry = await lstat(next)
    } catch (error) {
      if (isEnoent(error) && index === components.length - 1) {
        return Object.freeze({ relativePath: components.join('/'), realPath: next })
      }
      throw error
    }
    if (entry.isSymbolicLink()) {
      throw new WorkspacePathEscapeError(absolute, `component ${component} is a symbolic link`)
    }
    const last = index === components.length - 1
    if (!last && !entry.isDirectory()) {
      throw new WorkspacePathEscapeError(absolute, `component ${component} is not a directory`)
    }
    if (last && !entry.isFile() && !entry.isDirectory()) {
      throw new WorkspacePathEscapeError(absolute, `component ${component} is not a regular file`)
    }
    cursor = next
  }
  const resolved = await realpath(cursor)
  if (resolved !== resolve(realRoot, components.join(sep))) {
    throw new WorkspacePathEscapeError(absolute, 'the resolved path left the workspace root')
  }
  return Object.freeze({ relativePath: components.join('/'), realPath: resolved })
}

/** Open the root once so later reads remain bound to this directory object. */
export async function openWorkspaceRoot(root: string): Promise<WorkspaceRootHandle> {
  const resolved = await resolveWorkspaceRoot(root)
  const expected = await lstat(resolved)
  const descriptor = await openDirectoryDescriptor(resolved)
  try {
    const actual = await descriptor.stat()
    if (actual.dev !== expected.dev || actual.ino !== expected.ino || !actual.isDirectory()) {
      throw new Error(`Workspace trust root changed during open: ${resolved}`)
    }
    return Object.freeze({ root: resolved, descriptor })
  } catch (error) {
    await descriptor.close().catch(() => undefined)
    throw error
  }
}

async function openDirectoryDescriptor(path: string): Promise<FileHandle> {
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0)
  if (process.platform !== 'linux') return open(path, flags)
  let descriptor = await open('/', flags)
  try {
    for (const component of path.split('/').filter((part) => part.length > 0)) {
      const parent = descriptor
      const child = await open(`/proc/self/fd/${parent.fd}/${component}`, flags)
      try {
        await parent.close()
      } catch (error) {
        await child.close().catch(() => undefined)
        throw error
      }
      descriptor = child
    }
    return descriptor
  } catch (error) {
    await descriptor.close().catch(() => undefined)
    if (isSymlinkError(error)) {
      throw new WorkspacePathEscapeError(path, 'a parent component is a symbolic link')
    }
    throw error
  }
}

export async function closeWorkspaceRoot(root: WorkspaceRootHandle): Promise<void> {
  await root.descriptor.close()
}

/**
 * Read a workspace file from descriptors opened beneath an already-open root.
 * `/proc/self/fd/<dirfd>/child` is descriptor-relative on Linux: replacing a
 * named parent directory after it was opened cannot redirect this walk.
 */
export async function readWorkspaceFile(
  root: WorkspaceRootHandle,
  candidate: string,
  maxBytes: number,
): Promise<WorkspaceFileRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16 * 1_048_576) {
    throw new Error('Workspace file read limit must be finite and bounded')
  }
  const contained = await containedWorkspacePath(root.root, candidate)
  const components = contained.relativePath.split('/').filter((component) => component.length > 0)
  let parent = root.descriptor
  const opened: FileHandle[] = []
  try {
    for (const component of components.slice(0, -1)) {
      const next = await openRelativeDirectory(parent, component)
      opened.push(next)
      parent = next
    }
    const final = components.at(-1)
    if (final === undefined) throw new WorkspacePathEscapeError(candidate, 'the path is empty')
    let descriptor: FileHandle
    try {
      descriptor = await openRelative(parent, final, fsConstants.O_RDONLY)
    } catch (error) {
      if (isEnoent(error)) return { present: false }
      if (isSymlinkError(error)) {
        throw new WorkspacePathEscapeError(candidate, 'the final component is a symbolic link')
      }
      throw error
    }
    try {
      const stats = await descriptor.stat()
      if (!stats.isFile()) {
        throw new Error(`Workspace configuration is not a regular file: ${candidate}`)
      }
      if (stats.size > maxBytes) {
        throw new Error(
          `Workspace configuration ${candidate} is ${stats.size} bytes; the limit is ${maxBytes}`,
        )
      }
      const bytes = await readDescriptorBounded(descriptor, maxBytes)
      return { present: true, digest: digestBytes(bytes) }
    } finally {
      await descriptor.close()
    }
  } finally {
    for (const descriptor of opened.reverse()) await descriptor.close().catch(() => undefined)
  }
}

async function openRelativeDirectory(parent: FileHandle, component: string): Promise<FileHandle> {
  try {
    const descriptor = await open(
      descriptorPath(parent, component),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | (fsConstants.O_NOFOLLOW ?? 0),
    )
    const stats = await descriptor.stat()
    if (!stats.isDirectory()) {
      await descriptor.close()
      throw new Error(`Workspace path component ${component} is not a directory`)
    }
    return descriptor
  } catch (error) {
    if (isSymlinkError(error)) {
      throw new WorkspacePathEscapeError(component, 'a parent component is a symbolic link')
    }
    throw error
  }
}

async function openRelative(
  parent: FileHandle,
  component: string,
  flags: number,
): Promise<FileHandle> {
  return open(descriptorPath(parent, component), flags | (fsConstants.O_NOFOLLOW ?? 0))
}

function descriptorPath(parent: FileHandle, component: string): string {
  if (process.platform !== 'linux') {
    throw new Error('Descriptor-relative workspace inspection requires Linux')
  }
  return `/proc/self/fd/${parent.fd}/${component}`
}

async function readDescriptorBounded(
  descriptor: FileHandle,
  maxBytes: number,
): Promise<Uint8Array> {
  const buffer = new Uint8Array(maxBytes + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await descriptor.read(buffer, offset, buffer.byteLength - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset > maxBytes) throw new Error(`Workspace file exceeds the ${maxBytes}-byte limit`)
  return buffer.slice(0, offset)
}

function isSymlinkError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    ((error as { readonly code?: unknown }).code === 'ELOOP' ||
      (error as { readonly code?: unknown }).code === 'EMLINK')
  )
}

/** Open flags that refuse to traverse a final symlink component. */
export const WORKSPACE_READ_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
