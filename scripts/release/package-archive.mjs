import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { canonicalJson } from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'

const SOURCE_EXCLUSIONS = new Set(['.git', 'node_modules', 'dist', '.test-dist', 'artifacts'])
const HEX_SHA256 = /^[a-f0-9]{64}$/u

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function sourceDigest(root, excludedPaths = new Set()) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SOURCE_EXCLUSIONS.has(entry.name)) continue
      const path = join(directory, entry.name)
      if (excludedPaths.has(path)) continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await walk(root)
  files.sort()
  const hash = createHash('sha256')
  for (const path of files) {
    hash.update(relative(root, path))
    hash.update('\0')
    hash.update(await readRegularFileNoFollow(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function tarField(header, start, length, label) {
  const field = header.subarray(start, start + length)
  const terminator = field.indexOf(0)
  const end = terminator === -1 ? field.length : terminator
  const value = field.subarray(0, end).toString('utf8')
  assert(!value.includes('\uFFFD'), `Tar ${label} is not valid UTF-8`)
  if (terminator !== -1) {
    for (const byte of field.subarray(terminator + 1))
      assert(byte === 0, `Tar ${label} has bytes after its NUL terminator`)
  }
  return value
}

function tarOctal(header, start, length, label) {
  const field = header.subarray(start, start + length)
  const text = field.toString('ascii').replace(/\0/gu, '').trim()
  assert(/^[0-7]*$/u.test(text), `Tar ${label} is not octal`)
  const value = text.length === 0 ? 0 : Number.parseInt(text, 8)
  assert(Number.isSafeInteger(value) && value >= 0, `Tar ${label} is out of range`)
  return value
}

function tarChecksum(header) {
  const expected = tarOctal(header, 148, 8, 'checksum')
  let actual = 0
  for (let index = 0; index < header.length; index += 1)
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  assert(actual === expected, `Tar header checksum differs for ${tarField(header, 0, 100, 'path')}`)
}

function safePackagePath(path) {
  assert(path.length > 0, 'Tar entry has no path')
  if (path === 'package/') return path
  assert(path.startsWith('package/'), `Tar entry is outside package/: ${path}`)
  assert(
    !path.startsWith('/') && !path.includes('\\') && !path.includes('\0'),
    `Unsafe tar path: ${path}`,
  )
  const segments = path.split('/')
  assert(
    segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    `Unsafe tar path: ${path}`,
  )
  assert(segments.join('/') === path, `Non-canonical tar path: ${path}`)
  return path
}

function archiveEntries(bytes) {
  let tar
  try {
    tar = gunzipSync(bytes)
  } catch (error) {
    throw new Error('Packed artifact is not valid gzip', { cause: error })
  }
  const entries = []
  const paths = new Set()
  let offset = 0
  let ended = false
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) {
      ended = true
      assert(
        tar.subarray(offset).every((byte) => byte === 0),
        'Tar has data after its end marker',
      )
      break
    }
    tarChecksum(header)
    const name = tarField(header, 0, 100, 'path')
    const prefix = tarField(header, 345, 155, 'path prefix')
    const path = safePackagePath(prefix ? `${prefix}/${name}` : name)
    assert(!paths.has(path), `Tar contains duplicate entry: ${path}`)
    paths.add(path)
    const size = tarOctal(header, 124, 12, `size for ${path}`)
    const type = String.fromCharCode(header[156] || 0)
    assert(
      type === '\0' || type === '0' || type === '5',
      `Tar entry type is unsafe for ${path}: ${JSON.stringify(type)}`,
    )
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    assert(bodyEnd <= tar.length, `Tar entry is truncated: ${path}`)
    const body = Buffer.from(tar.subarray(bodyStart, bodyEnd))
    entries.push({ path, type: type === '5' ? 'directory' : 'file', size, bytes: body })
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  assert(ended, 'Tar has no complete end marker')
  return entries
}

export function packageFileManifestFromTarball(bytes) {
  assert(Buffer.isBuffer(bytes), 'Packed artifact must be bytes')
  const entries = archiveEntries(bytes)
    .filter((entry) => entry.type === 'file')
    .map(({ path, size, bytes: body }) => ({ path, size, sha256: sha256(body) }))
  return packageFileManifest(entries)
}

function packageFileManifest(entries) {
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  assert(entries.length > 0, 'Package has no files')
  return {
    algorithm: 'sha256-path-size',
    entries,
    digest: sha256(Buffer.from(canonicalJson({ algorithm: 'sha256-path-size', entries }))),
  }
}

async function assertRealDirectory(path) {
  const info = await lstat(path)
  assert(
    info.isDirectory() && !info.isSymbolicLink(),
    `Package directory must be a real directory: ${path}`,
  )
  assert(
    (await realpath(path)) === resolve(path),
    `Package directory resolves through a symlink: ${path}`,
  )
}

/**
 * Build the exact npm package file manifest from an installed package directory.
 * Dependency directories are excluded because they are installed beside or beneath
 * the package and are not bytes from the candidate tarball.
 */
export async function packageFileManifestFromDirectory(packageRoot) {
  assert(
    typeof packageRoot === 'string' && packageRoot.trim().length > 0,
    'Installed package root is required',
  )
  const root = resolve(packageRoot)
  await assertRealDirectory(root)
  const entries = []

  async function walk(directory, segments) {
    await assertRealDirectory(directory)
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const child of children) {
      const path = join(directory, child.name)
      const info = await lstat(path)
      if (info.isSymbolicLink())
        throw new Error(`Symlink is not allowed in package directory: ${path}`)
      if (info.isDirectory()) {
        if (child.name === 'node_modules') continue
        await walk(path, [...segments, child.name])
        continue
      }
      if (!info.isFile())
        throw new Error(`Special file is not allowed in package directory: ${path}`)
      const body = await readRegularFileNoFollow(path)
      const manifestPath = safePackagePath(`package/${[...segments, child.name].join('/')}`)
      entries.push({ path: manifestPath, size: body.length, sha256: sha256(body) })
    }
  }

  await walk(root, [])
  return packageFileManifest(entries)
}

export function packageFileBytesFromTarball(bytes, path) {
  const entry = archiveEntries(bytes).find((candidate) => candidate.path === path)
  assert(entry?.type === 'file', `Tar has no regular ${path}`)
  return Buffer.from(entry.bytes)
}

function normalizeManifest(value) {
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    'Package file manifest is not an object',
  )
  assert(
    value.algorithm === 'sha256-path-size',
    'Package file manifest has an unsupported algorithm',
  )
  assert(
    Array.isArray(value.entries) && value.entries.length > 0,
    'Package file manifest has no entries',
  )
  const paths = new Set()
  const entries = value.entries.map((entry, index) => {
    assert(
      entry && typeof entry === 'object' && !Array.isArray(entry),
      `Package file manifest entry ${index} is invalid`,
    )
    assert(
      Object.keys(entry).sort().join(',') === 'path,sha256,size',
      `Package file manifest entry ${index} has unexpected fields`,
    )
    const path = safePackagePath(entry.path)
    assert(!paths.has(path), `Package file manifest repeats ${path}`)
    paths.add(path)
    assert(HEX_SHA256.test(entry.sha256), `Package file manifest has invalid digest for ${path}`)
    assert(
      Number.isSafeInteger(entry.size) && entry.size >= 0,
      `Package file manifest has invalid size for ${path}`,
    )
    return { path, size: entry.size, sha256: entry.sha256 }
  })
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const digest = sha256(Buffer.from(canonicalJson({ algorithm: value.algorithm, entries })))
  assert(value.digest === digest, 'Package file manifest digest differs')
  return { algorithm: value.algorithm, entries, digest }
}

export function assertPackageFileManifestMatches(expected, actual) {
  const normalized = normalizeManifest(expected)
  const normalizedActual = normalizeManifest(actual)
  assert(
    canonicalJson(normalized) === canonicalJson(normalizedActual),
    'Tar package file manifest differs from package proof',
  )
  return normalized
}

export async function readPackageProof({ repository, packageProofPath, packageProof }) {
  if (packageProof) return packageProof
  assert(
    typeof packageProofPath === 'string' && packageProofPath.length > 0,
    'Package proof is required',
  )
  return JSON.parse(
    (await readRegularFileNoFollow(join(repository, packageProofPath))).toString('utf8'),
  )
}
