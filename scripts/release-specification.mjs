import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { REQUIREMENT_PATTERN } from './release-catalog.mjs'
import { assert } from './release-evidence.mjs'
import { containedArtifactPath, readRegularFileNoFollow } from './release-files.mjs'

export async function filesBelow(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await filesBelow(path)))
    else files.push(path)
  }
  return files
}

export async function readSpecifications(docsRoot, repository) {
  const docFiles = (await filesBelow(docsRoot)).filter((path) => path.endsWith('.md'))
  const requirements = new Set()
  const specificationDigests = []
  for (const path of docFiles) {
    const text = (await readRegularFileNoFollow(path)).toString('utf8')
    for (const match of text.matchAll(REQUIREMENT_PATTERN)) requirements.add(match[0])
    specificationDigests.push({
      path: relative(repository, path),
      sha256: createHash('sha256').update(text).digest('hex'),
    })
  }
  assert(requirements.size > 0, 'No requirement identifiers found in docs')
  return { requirements, specificationDigests }
}

export async function sha256(path) {
  return createHash('sha256')
    .update(await readRegularFileNoFollow(path))
    .digest('hex')
}

export async function sha512Integrity(path) {
  return `sha512-${createHash('sha512')
    .update(await readRegularFileNoFollow(path))
    .digest('base64')}`
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

export async function artifactPath(repository, path) {
  assert(typeof path === 'string' && path.length > 0, 'Evidence artifact has no path')
  return containedArtifactPath(repository, path)
}
