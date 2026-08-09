import { lstat, readdir, readFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024

function fail(message) {
  throw new Error(message)
}

/**
 * Scans a generated evidence tree without following links or reading special files.
 * The caller supplies deterministic canaries so this never guesses at user secrets.
 */
export async function scanSecretArtifacts(root, canaries, options = {}) {
  const rootPath = resolve(root)
  const values = [...new Set(canaries)]
  if (values.length === 0) fail('Secret artifact scan requires at least one canary')
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0)
      fail('Secret artifact scan canaries must be non-empty strings')
  }
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0)
    fail('Secret artifact scan maxFileBytes must be a positive safe integer')

  const matches = []
  async function visit(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink())
      fail(`Secret artifact scan refuses symlink: ${relative(rootPath, path)}`)
    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true })
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      for (const entry of entries) await visit(resolve(path, entry.name))
      return
    }
    if (!info.isFile())
      fail(`Secret artifact scan refuses special file: ${relative(rootPath, path)}`)
    if (info.size > maxFileBytes)
      fail(`Secret artifact scan file exceeds ${maxFileBytes} bytes: ${relative(rootPath, path)}`)
    const bytes = await readFile(path)
    for (const canary of values) {
      if (bytes.includes(Buffer.from(canary, 'utf8')))
        matches.push({ path: relative(rootPath, path), canaryBytes: Buffer.byteLength(canary) })
    }
  }

  await visit(rootPath)
  return matches
}

export async function assertNoSecretArtifacts(root, canaries, options = {}) {
  const matches = await scanSecretArtifacts(root, canaries, options)
  if (matches.length > 0) {
    throw new Error(
      `Secret canary found in generated artifact(s): ${matches
        .map((match) => `${match.path} (${match.canaryBytes} bytes)`)
        .join(', ')}`,
    )
  }
}
