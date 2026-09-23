import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  ADMISSIBLE_CATEGORIES,
  EXPECTED_REQUIREMENT_COUNT,
  REQUIREMENT_PATTERN,
  REQUIREMENT_PREFIXES,
} from './release-catalog.mjs'
import { assert, sha256Text } from './release-evidence.mjs'
import { containedArtifactPath, readRegularFileNoFollow } from './release-files.mjs'
import { canonicalJson } from './release-json.mjs'

const MAX_SPEC_FILES = 256
const MAX_SPEC_FILE_BYTES = 2 * 1024 * 1024
const MAX_SPEC_BYTES = 16 * 1024 * 1024
const MAX_SOURCE_FILES = 4096
const MAX_SOURCE_BYTES = 128 * 1024 * 1024
const REQUIREMENT_ROW = /^\s*\|\s*([A-Z]{2,4}-\d{2})\s*\|\s*([^|].*?)\s*\|/u
const REQUIREMENT_ID = /^([A-Z]{2,4})-(\d{2})$/u
const REQUIREMENT_RANGE = /^([A-Z]{2,4})-(\d{2})–([A-Z]{2,4})-(\d{2})$/u

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function splitCells(line) {
  if (!/^\s*\|/u.test(line)) return []
  return line
    .trim()
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
}

export async function filesBelow(root, depth = 0, state = { count: 0, bytes: 0 }) {
  assert(depth <= 16, 'Specification tree is too deep')
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(path, depth + 1, state)))
    } else {
      state.count += 1
      assert(state.count <= MAX_SPEC_FILES, 'Specification tree has too many files')
      const info = await readRegularFileNoFollow(path)
      assert(info.byteLength <= MAX_SPEC_FILE_BYTES, `Specification file is too large: ${path}`)
      state.bytes += info.byteLength
      assert(state.bytes <= MAX_SPEC_BYTES, 'Specification tree is too large')
      files.push(path)
    }
  }
  return files
}

export function normalizeRequirementDefinition(description) {
  assert(typeof description === 'string', 'Requirement definition is not text')
  const normalized = description.replace(/\s+/gu, ' ').trim()
  assert(normalized.length > 0, 'Requirement definition is empty')
  return normalized
}

function addDefinition(definitions, id, description, path, lineNumber, repository, sourceSha256) {
  const parsed = id.match(REQUIREMENT_ID)
  assert(parsed, `Malformed requirement definition ${id}`)
  const prefix = parsed[1]
  assert(ADMISSIBLE_CATEGORIES.has(prefix), `Unknown requirement prefix ${prefix}`)
  const definition = normalizeRequirementDefinition(description)
  assert(
    !definitions.has(id),
    `Duplicate requirement definition ${id} at ${relative(process.cwd(), path)}:${lineNumber}`,
  )
  const digest = sha256Text(canonicalJson({ id, definition }))
  definitions.set(id, {
    id,
    definition,
    digest,
    source: { path: relative(repository, path), line: lineNumber, sha256: sourceSha256 },
  })
}

function expandOwnership(text, ownershipPath) {
  const start = text.indexOf('## Requirement ownership')
  assert(start >= 0, 'Requirement ownership table is missing')
  const end = text.indexOf('\n## ', start + 4)
  const section = text.slice(start, end < 0 ? text.length : end)
  const ranges = []
  for (const [index, line] of section.split('\n').entries()) {
    const cells = splitCells(line)
    if (cells.length === 0 || cells[0] === 'Requirement range' || /^-+$/u.test(cells[0])) continue
    const rangeCell = cells[0].replaceAll('`', '').trim()
    const single = rangeCell.match(REQUIREMENT_ID)
    if (single) {
      ranges.push([rangeCell])
      continue
    }
    const match = rangeCell.match(REQUIREMENT_RANGE)
    assert(
      match,
      `Malformed requirement range at ${relative(process.cwd(), ownershipPath)}:${index + 1}`,
    )
    const [, startPrefix, startNumber, endPrefix, endNumber] = match
    assert(startPrefix === endPrefix, `Requirement range crosses prefixes at ${index + 1}`)
    const first = Number(startNumber)
    const last = Number(endNumber)
    assert(first <= last, `Requirement range is reversed at ${index + 1}`)
    assert(last - first < 100, `Requirement range is too broad at ${index + 1}`)
    ranges.push(
      Array.from(
        { length: last - first + 1 },
        (_, offset) => `${startPrefix}-${String(first + offset).padStart(2, '0')}`,
      ),
    )
  }
  const ids = new Set()
  for (const range of ranges.flat()) {
    assert(!ids.has(range), `Requirement range repeats ${range}`)
    ids.add(range)
  }
  return ids
}

export async function readSpecifications(docsRoot, repository) {
  const docFiles = (await filesBelow(docsRoot))
    .filter((path) => path.endsWith('.md'))
    .sort(compareText)
  assert(docFiles.length > 0, 'No specification documents found')
  const definitions = new Map()
  const occurrences = []
  const specificationDigests = []
  let totalBytes = 0
  let ownershipPath
  let ownershipText

  for (const path of docFiles) {
    const bytes = await readRegularFileNoFollow(path)
    totalBytes += bytes.byteLength
    assert(totalBytes <= MAX_SPEC_BYTES, 'Specification documents are too large')
    const text = bytes.toString('utf8')
    specificationDigests.push({
      path: relative(repository, path),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    if (path.endsWith('docs/09-delivery-plan.md')) {
      ownershipPath = path
      ownershipText = text
    }
    for (const [index, line] of text.split('\n').entries()) {
      const row = line.match(REQUIREMENT_ROW)
      if (row)
        addDefinition(
          definitions,
          row[1],
          row[2],
          path,
          index + 1,
          repository,
          specificationDigests.at(-1).sha256,
        )
    }
    for (const match of text.matchAll(REQUIREMENT_PATTERN)) occurrences.push(match[0])
  }

  assert(ownershipPath && ownershipText, 'Requirement ownership document is missing')
  const owned = expandOwnership(ownershipText, ownershipPath)
  const prefixes = new Set()
  for (const id of definitions.keys()) prefixes.add(id.slice(0, id.indexOf('-')))
  assert(
    definitions.size === EXPECTED_REQUIREMENT_COUNT,
    `Expected ${EXPECTED_REQUIREMENT_COUNT} requirement definitions`,
  )
  assert(
    prefixes.size === REQUIREMENT_PREFIXES.length &&
      REQUIREMENT_PREFIXES.every((prefix) => prefixes.has(prefix)),
    'Requirement definition prefixes drifted',
  )
  assert(owned.size === definitions.size, 'Requirement ownership ranges drifted')
  for (const id of definitions.keys())
    assert(owned.has(id), `Requirement ${id} is outside ownership ranges`)
  for (const id of owned) assert(definitions.has(id), `Ownership range names undefined ${id}`)
  for (const id of occurrences)
    assert(definitions.has(id), `Specification references undefined ${id}`)
  for (const prefix of REQUIREMENT_PREFIXES)
    assert(
      [...definitions.keys()].some((id) => id.startsWith(`${prefix}-`)),
      `Requirement prefix ${prefix} is empty`,
    )
  assert(definitions.size > 0, 'No requirement identifiers found in docs')
  return {
    requirements: definitions,
    specificationDigests,
  }
}

export async function sourceDigest(root) {
  const excluded = new Set(['.git', 'node_modules', 'dist', '.test-dist', 'artifacts'])
  const files = []
  const state = { count: 0, bytes: 0 }
  async function walk(directory, depth = 0) {
    assert(depth <= 32, 'Source tree is too deep')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, depth + 1)
      else {
        state.count += 1
        assert(state.count <= MAX_SOURCE_FILES, 'Source tree has too many files')
        files.push(path)
      }
    }
  }
  await walk(root)
  files.sort((left, right) => compareText(relative(root, left), relative(root, right)))
  const digest = createHash('sha256')
  for (const path of files) {
    const name = relative(root, path)
    assert(
      name.length > 0 &&
        name.length <= 1024 &&
        !name.includes('\0') &&
        !name
          .split('/')
          .some((component) => component.length === 0 || component === '.' || component === '..'),
      'Source path is not canonical',
    )
    digest.update(name)
    digest.update('\0')
    const bytes = await readRegularFileNoFollow(path)
    state.bytes += bytes.byteLength
    assert(state.bytes <= MAX_SOURCE_BYTES, 'Source tree is too large')
    digest.update(bytes)
    digest.update('\0')
  }
  return digest.digest('hex')
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
