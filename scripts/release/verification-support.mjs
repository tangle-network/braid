import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { assert } from '../release-evidence.mjs'
import { containedArtifactPath, readRegularFileNoFollow } from '../release-files.mjs'

export async function filesBelow(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await filesBelow(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

export function uniqueBy(items, key, label) {
  assert(Array.isArray(items), `${label} collection is not an array`)
  const values = new Map()
  for (const item of items) {
    const value = item?.[key]
    assert(typeof value === 'string' && value.length > 0, `${label} has no ${key}`)
    assert(!values.has(value), `Duplicate ${label} ${value}`)
    values.set(value, item)
  }
  return values
}

export function createGit(repository) {
  return (...args) => {
    try {
      return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
    } catch (error) {
      if (error?.status === 0 && typeof error.stdout === 'string') return error.stdout.trim()
      throw error
    }
  }
}

export async function sha256File(path) {
  return createHash('sha256')
    .update(await readRegularFileNoFollow(path))
    .digest('hex')
}

export async function sha512IntegrityFile(path) {
  return `sha512-${createHash('sha512')
    .update(await readRegularFileNoFollow(path))
    .digest('base64')}`
}

export function artifactPath(repository, path) {
  assert(typeof path === 'string' && path.length > 0, 'Evidence artifact has no path')
  return containedArtifactPath(repository, path)
}
