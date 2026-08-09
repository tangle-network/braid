import { join } from 'node:path'

import { readRegularFileNoFollow } from '../release-files.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function artifactPrefix(checkId) {
  return `check-${checkId.replaceAll(/[^A-Za-z0-9._-]/gu, '_')}-evidence-`
}

export function restoredCheckArtifacts(checkId, artifacts) {
  const prefix = artifactPrefix(checkId)
  return artifacts.filter(({ id }) => id.startsWith(prefix)).map(({ id }) => id)
}

export async function registerCheckArtifacts({ checkId, artifactRoot, store }) {
  const manifestPath =
    checkId === 'capture'
      ? 'w0/capture-manifest.json'
      : checkId === 'visual'
        ? 'w6/capture-manifest.json'
        : undefined
  if (!manifestPath) return []
  const manifest = JSON.parse(
    (await readRegularFileNoFollow(join(artifactRoot, manifestPath))).toString('utf8'),
  )
  assert(Array.isArray(manifest.artifacts), `${checkId} manifest has no artifact list`)
  const entries = [
    { path: manifestPath, mediaType: 'application/json' },
    ...manifest.artifacts.map((artifact) => ({
      path: join(checkId === 'capture' ? 'w0' : 'w6', artifact.path),
      sha256: artifact.sha256,
      mediaType: artifact.path.endsWith('.json')
        ? 'application/json'
        : artifact.path.endsWith('.png') || artifact.path.endsWith('.gif')
          ? `image/${artifact.path.endsWith('.png') ? 'png' : 'gif'}`
          : 'text/plain; charset=utf-8',
    })),
  ]
  const registered = []
  const seenPaths = new Set()
  for (const [index, entry] of entries.entries()) {
    assert(!seenPaths.has(entry.path), `${checkId} manifest repeats ${entry.path}`)
    seenPaths.add(entry.path)
    const artifact = await store.register({
      id: `${artifactPrefix(checkId)}${String(index + 1).padStart(3, '0')}`,
      path: entry.path,
      mediaType: entry.mediaType,
    })
    if (entry.sha256)
      assert(artifact.sha256 === entry.sha256, `${checkId} artifact changed: ${entry.path}`)
    registered.push(artifact)
  }
  return registered
}
