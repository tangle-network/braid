import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open, lstat, realpath, unlink, link, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function fail(message) {
  throw new Error(message)
}

function inside(root, target) {
  const location = relative(root, target)
  return location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location)
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
  if (typeof artifactPath !== 'string' || artifactPath.length === 0 || isAbsolute(artifactPath))
    fail(`Artifact path must be relative: ${String(artifactPath)}`)
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
  if (typeof outputPath !== 'string' || outputPath.length === 0 || isAbsolute(outputPath))
    fail(`Release output path must be relative: ${String(outputPath)}`)
  const root = await realpath(repository)
  const target = resolve(root, outputPath)
  await assertNoSymlinkComponents(root, target)
  await assertNoSymlinkAncestors(target)
  if (!inside(root, target)) fail(`Release output leaves repository: ${outputPath}`)
  return target
}

function sameFile(left, right) {
  if (!left.isFile() || !right.isFile()) return false
  if (typeof left.dev === 'number' && typeof right.dev === 'number' && left.dev !== right.dev)
    return false
  if (typeof left.ino === 'number' && typeof right.ino === 'number' && left.ino !== right.ino)
    return false
  return true
}

export async function readRegularFileNoFollow(path) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink())
    fail(`Regular non-symlink file required: ${path}`)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const after = await handle.stat()
    if (!sameFile(before, after)) fail(`Release file changed while opening: ${path}`)
    const bytes = await handle.readFile()
    const resolvedPath = await realpath(path)
    if (resolvedPath !== resolve(path)) fail(`Release file resolved through a symlink: ${path}`)
    return bytes
  } finally {
    await handle.close()
  }
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
  const parent = dirname(path)
  await assertNoSymlinkAncestors(parent)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const assertParent = async () => {
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
      fail(`Release output parent is not a real directory: ${parent}`)
    if ((await realpath(parent)) !== resolve(parent))
      fail(`Release output parent resolves through a symlink: ${parent}`)
  }
  await assertParent()
  const temporary = resolve(parent, `.${randomUUID()}.tmp`)
  const noFollow = constants.O_NOFOLLOW ?? 0
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode,
    )
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await assertParent()
    await link(temporary, path)
    await unlink(temporary)
    await fsyncDirectory(parent)
  } finally {
    await handle?.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}
