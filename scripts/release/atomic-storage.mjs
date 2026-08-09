import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function assertDirectory(path) {
  const info = await lstat(path)
  assert(info.isDirectory() && !info.isSymbolicLink(), `Release path is not a directory: ${path}`)
  assert(
    (await realpath(path)) === resolve(path),
    `Release path resolves through a symlink: ${path}`,
  )
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeAtomic(path, data, { mode = 0o600, beforeRename } = {}) {
  const parent = dirname(resolve(path))
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await assertDirectory(parent)
  const temporary = resolve(parent, `.${randomUUID()}.tmp`)
  let handle
  let renamed = false
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      mode,
    )
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await beforeRename?.()
    await assertDirectory(parent)
    await rename(temporary, resolve(path))
    renamed = true
    await syncDirectory(parent)
  } finally {
    await handle?.close().catch(() => {})
    if (!renamed) await unlink(temporary).catch(() => {})
  }
}

export async function writeJsonAtomic(path, value, options = {}) {
  await writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`, options)
}

export async function readJson(path, readFile) {
  const bytes = await readFile(path)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`Invalid release JSON at ${path}`, { cause: error })
  }
}

export async function cleanTemporaryFiles(directory) {
  const info = await lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return []
  await assertDirectory(directory)
  const entries = await readdir(directory, { withFileTypes: true })
  const removed = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^\.[0-9a-f-]+\.tmp$/u.test(entry.name)) continue
    const path = resolve(directory, entry.name)
    await unlink(path)
    removed.push(path)
  }
  return removed
}
