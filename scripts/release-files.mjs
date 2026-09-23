import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open, lstat, realpath, unlink, link, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_RELEASE_FILE_BYTES = 128 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

function inside(root, target) {
  const location = relative(root, target)
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location)
}

function assertRelativePath(path, label) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4096 ||
    isAbsolute(path) ||
    path.includes('\\')
  )
    fail(`${label} must be a canonical relative path`)
  if (
    path
      .split('/')
      .some((component) => component.length === 0 || component === '.' || component === '..')
  )
    fail(`${label} contains a traversal component`)
}

async function assertNoSymlinkComponents(root, target) {
  const rootPath = await realpath(root)
  const targetPath = resolve(target)
  if (!inside(rootPath, targetPath)) fail(`Path leaves release root: ${target}`)
  const location = relative(rootPath, targetPath)
  let current = rootPath
  for (const component of location ? location.split(sep) : []) {
    current = resolve(current, component)
    const info = await lstat(current).catch(() => undefined)
    if (info?.isSymbolicLink()) fail(`Symlink is not allowed in release path: ${target}`)
  }
  return targetPath
}

async function assertNoSymlinkAncestors(path) {
  let current = resolve(path)
  while (true) {
    const info = await lstat(current).catch(() => undefined)
    if (info) {
      if (info.isSymbolicLink()) fail(`Symlink is not allowed in release path: ${path}`)
      if ((await realpath(current)) !== current)
        fail(`Release path resolves through a symlink: ${path}`)
      return
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

export async function containedArtifactPath(repository, artifactPath) {
  assertRelativePath(artifactPath, 'Artifact path')
  const root = await realpath(repository)
  const target = resolve(root, artifactPath)
  await assertNoSymlinkComponents(root, target)
  const resolvedTarget = await realpath(target).catch(() =>
    fail(`Artifact is missing: ${artifactPath}`),
  )
  if (!inside(root, resolvedTarget)) fail(`Artifact leaves repository: ${artifactPath}`)
  if (resolvedTarget !== target) fail(`Artifact path resolves through a symlink: ${artifactPath}`)
  return target
}

export async function containedOutputPath(repository, outputPath) {
  assertRelativePath(outputPath, 'Release output path')
  const root = await realpath(repository)
  const target = resolve(root, outputPath)
  await assertNoSymlinkComponents(root, target)
  await assertNoSymlinkAncestors(target)
  if (!inside(root, target)) fail(`Release output leaves repository: ${outputPath}`)
  return target
}

const FILE_METADATA_FIELDS = ['dev', 'ino', 'nlink', 'size', 'mode', 'uid', 'gid', 'rdev', 'mtimeMs', 'ctimeMs']
const FILE_IDENTITY_FIELDS = ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'rdev']

function sameFields(left, right, fields) {
  for (const field of fields) {
    if (left[field] !== undefined && right[field] !== undefined && left[field] !== right[field])
      return false
  }
  return true
}

export function sameFileMetadata(left, right) {
  if (!left.isFile() || !right.isFile()) return false
  return sameFields(left, right, FILE_METADATA_FIELDS)
}

function sameFileIdentity(left, right) {
  if (!left.isFile() || !right.isFile()) return false
  return sameFields(left, right, FILE_IDENTITY_FIELDS)
}

function assertSizeLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_RELEASE_FILE_BYTES)
    fail('Release file size limit is invalid')
}

async function readStableFile(path, maxBytes, validate) {
  assertSizeLimit(maxBytes)
  const before = await lstat(path)
  validate(before, path)
  if (before.size > maxBytes) fail(`Release file exceeds its size limit: ${path}`)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const after = await handle.stat()
    validate(after, path)
    if (!sameFileMetadata(before, after)) fail(`Release file changed while opening: ${path}`)
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxBytes) fail(`Release file exceeds its size limit: ${path}`)
    const finalHandle = await handle.stat()
    const finalPath = await lstat(path)
    validate(finalHandle, path)
    validate(finalPath, path)
    if (!sameFileMetadata(before, finalHandle) || !sameFileMetadata(before, finalPath))
      fail(`Release file changed while reading: ${path}`)
    if (finalHandle.size !== bytes.byteLength || finalPath.size !== bytes.byteLength)
      fail(`Release file size changed while reading: ${path}`)
    const resolvedPath = await realpath(path)
    if (resolvedPath !== resolve(path)) fail(`Release file resolved through a symlink: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
}

export async function readRegularFileNoFollow(path, maxBytes = MAX_RELEASE_FILE_BYTES) {
  return readStableFile(path, maxBytes, (info, target) => {
    if (!info.isFile() || info.isSymbolicLink())
      fail(`Regular non-symlink file required: ${target}`)
    if (info.nlink !== 1) fail(`Release file must not be hard-linked: ${target}`)
  })
}

function validatePrivateFile(info, path) {
  if (!info.isFile() || info.isSymbolicLink()) fail(`Private signing key is not a regular file: ${path}`)
  if (info.nlink !== 1) fail(`Private signing key must not be hard-linked: ${path}`)
  if ((info.mode & 0o777) !== 0o600) fail(`Private signing key permissions are not 0600: ${path}`)
  if (typeof process.getuid === 'function' && typeof info.uid === 'number' && info.uid !== process.getuid())
    fail(`Private signing key is not owned by the current user: ${path}`)
}

export async function readOwnedPrivateFileNoFollow(path, maxBytes = MAX_RELEASE_FILE_BYTES) {
  return readStableFile(path, maxBytes, validatePrivateFile)
}

export async function readContainedFile(repository, artifactPath) {
  const path = await containedArtifactPath(repository, artifactPath)
  return readRegularFileNoFollow(path)
}

export async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeExclusiveAtomic(path, data, mode = 0o600) {
  if (!Buffer.isBuffer(data) && typeof data !== 'string')
    fail('Release output is not bytes or text')
  const expected = Buffer.from(data)
  if (expected.byteLength > MAX_RELEASE_FILE_BYTES)
    fail('Release output exceeds its size limit')
  const parent = dirname(path)
  await assertNoSymlinkAncestors(parent)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentSnapshot = async () => {
    await assertNoSymlinkAncestors(parent)
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
      fail(`Release output parent is not a real directory: ${parent}`)
    const resolvedParent = await realpath(parent)
    if (resolvedParent !== resolve(parent))
      fail(`Release output parent resolves through a symlink: ${parent}`)
    return { info: parentInfo, resolvedParent }
  }
  const originalParent = await parentSnapshot()
  const assertParentUnchanged = async () => {
    const current = await parentSnapshot()
    if (
      current.resolvedParent !== originalParent.resolvedParent ||
      !sameFields(originalParent.info, current.info, ['dev', 'ino', 'mode', 'uid', 'gid'])
    )
      fail(`Release output parent changed while writing: ${parent}`)
  }
  const temporary = resolve(parent, `.${randomUUID()}.tmp`)
  const noFollow = constants.O_NOFOLLOW ?? 0
  let handle
  let temporaryInfo
  let linked = false
  let completed = false
  const removeOwnedOutput = async () => {
    if (!linked || completed) return
    const current = await lstat(path).catch(() => undefined)
    if (current && temporaryInfo && sameFileIdentity(current, temporaryInfo))
      await unlink(path).catch(() => {})
  }
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode,
    )
    await handle.writeFile(expected)
    await handle.sync()
    temporaryInfo = await handle.stat()
    if (!temporaryInfo.isFile() || temporaryInfo.nlink !== 1)
      fail('Release temporary output identity is invalid')
    if (temporaryInfo.size !== expected.byteLength) fail('Release temporary output size differs')
    await handle.close()
    handle = undefined
    await assertParentUnchanged()
    await link(temporary, path)
    linked = true
    await assertParentUnchanged()
    const linkedInfo = await lstat(path)
    if (!sameFileIdentity(temporaryInfo, linkedInfo)) fail('Release output identity differs after link')
    if (linkedInfo.nlink !== temporaryInfo.nlink + 1) fail('Release output link count differs')
    const outputHandle = await open(path, constants.O_RDONLY | noFollow)
    try {
      const openedInfo = await outputHandle.stat()
      if (!sameFileIdentity(linkedInfo, openedInfo)) fail('Release output identity changed while opening')
      const actual = await outputHandle.readFile()
      if (!actual.equals(expected)) fail('Release output bytes differ after link')
      const finalInfo = await outputHandle.stat()
      if (!sameFileIdentity(linkedInfo, finalInfo) || finalInfo.size !== expected.byteLength)
        fail('Release output changed while reading')
      await outputHandle.sync()
    } finally {
      await outputHandle.close()
    }
    await unlink(temporary)
    await fsyncDirectory(parent)
    await assertParentUnchanged()
    const finalPathInfo = await lstat(path)
    if (!sameFileIdentity(temporaryInfo, finalPathInfo) || finalPathInfo.nlink !== 1)
      fail('Release output identity changed after installation')
    completed = true
  } finally {
    await handle?.close().catch(() => {})
    await removeOwnedOutput()
    await unlink(temporary).catch(() => {})
  }
}
