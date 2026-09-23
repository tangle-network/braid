import { readRegularFileNoFollow } from './release-files.mjs'
import { assert } from './release-evidence.mjs'
import { join } from 'node:path'

const PACKAGE_HEADER = /^ {2}(?:'([^']+)'|([^:\n]+)):\s*$/gmu
const INTEGRITY = /^\s+resolution:\s+\{[^\n}]*integrity:\s*([^,}\s]+)[^\n}]*\}/mu

function packageEntries(lockfile) {
  const headers = [...lockfile.matchAll(PACKAGE_HEADER)]
  const entries = []
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]
    const start = header.index + header[0].length
    const end = headers[index + 1]?.index ?? lockfile.length
    const body = lockfile.slice(start, end)
    const integrity = body.match(INTEGRITY)?.[1]
    if (integrity) entries.push({ key: header[1] ?? header[2], integrity })
  }
  return entries
}

export async function readDependencyIntegrity(repository, packageJson) {
  const dependencies = Object.entries(packageJson.dependencies ?? {})
  if (dependencies.length === 0) return new Map()
  const lockPath = join(repository, 'pnpm-lock.yaml')
  const lockfile = (await readRegularFileNoFollow(lockPath)).toString('utf8')
  assert(lockfile.length <= 16 * 1024 * 1024, 'Dependency lockfile is too large')
  const entries = packageEntries(lockfile)
  const result = new Map()
  for (const [name, version] of dependencies) {
    assert(
      typeof version === 'string' && version.length > 0,
      `Dependency ${name} has no package version`,
    )
    const matches = entries.filter((entry) => entry.key.startsWith(`${name}@${version}`))
    assert(matches.length === 1, `Dependency ${name}@${version} has no unique lock entry`)
    result.set(name, { version, integrity: matches[0].integrity })
  }
  return result
}
