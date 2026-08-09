import { createHash } from 'node:crypto'
import { join, relative, resolve } from 'node:path'

import {
  containedArtifactPath,
  readRegularFileNoFollow,
  writeExclusiveAtomic,
} from '../release-files.mjs'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function artifactPath(root, id, extension) {
  assert(SAFE_ID.test(id), `Invalid release artifact identifier: ${id}`)
  return join(root, `${id}${extension}`)
}

async function preserveOrWrite(path, bytes) {
  try {
    const existing = await readRegularFileNoFollow(path)
    assert(existing.equals(bytes), `Release artifact changed: ${path}`)
  } catch (error) {
    if (error?.code !== 'ENOENT' && !/missing|no such file/iu.test(String(error))) throw error
    await writeExclusiveAtomic(path, bytes)
  }
}

export function createArtifactStore({ artifactRoot, relativeRoot = 'release/logs' }) {
  const root = resolve(artifactRoot, relativeRoot)
  return {
    root,
    async put({ id, bytes, mediaType = 'text/plain; charset=utf-8', extension = '.log' }) {
      assert(Buffer.isBuffer(bytes), `Artifact ${id} must be bytes`)
      const path = artifactPath(root, id, extension)
      await preserveOrWrite(path, bytes)
      return {
        id,
        path: relative(artifactRoot, path),
        sha256: sha256(bytes),
        mediaType,
      }
    },
    async register({ id, path, mediaType = 'application/octet-stream' }) {
      assert(SAFE_ID.test(id), `Invalid release artifact identifier: ${id}`)
      const absolute = await containedArtifactPath(artifactRoot, path)
      const bytes = await readRegularFileNoFollow(absolute)
      return { id, path: relative(artifactRoot, absolute), sha256: sha256(bytes), mediaType }
    },
  }
}

export function digestBytes(bytes) {
  assert(Buffer.isBuffer(bytes), 'Digest input must be bytes')
  return sha256(bytes)
}
