import { lstat, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

import { readRegularFileNoFollow } from '../release-files.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function artifactPrefix(checkId) {
  return `check-${checkId.replaceAll(/[^A-Za-z0-9._-]/gu, '_')}-evidence-`
}

function mediaType(path) {
  switch (extname(path).toLowerCase()) {
    case '.json':
    case '.jsonl':
      return 'application/json'
    case '.png':
      return 'image/png'
    case '.gif':
      return 'image/gif'
    case '.md':
    case '.txt':
    case '.log':
      return 'text/plain; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}

function evidenceDirectory(checkId) {
  if (checkId === 'performance' || /^PERF-[0-9]{2}$/u.test(checkId)) return 'performance'
  if (checkId === 'eval' || /^EVAL-[0-9]{2}$/u.test(checkId)) return 'eval'
  if (checkId === 'live-bridge' || /^LIVE-0[1-5]$/u.test(checkId)) return 'live/bridge'
  if (checkId === 'live-tangle' || /^LIVE-(?:0[6-9]|10)$/u.test(checkId)) return 'live/tangle'
  if (checkId === 'live-supervisor' || checkId === 'LIVE-11') return 'live/supervisor'
  if (checkId === 'live-analysis' || checkId === 'LIVE-12') return 'live/analysis'
  if (checkId === 'independent-review') return 'review'
  return undefined
}

async function filesUnder(artifactRoot, directory) {
  const root = join(artifactRoot, directory)
  const rootInfo = await lstat(root)
  assert(
    rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),
    `${directory} is not a real directory`,
  )
  const files = []
  async function walk(path) {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(path, entry.name)
      assert(!entry.isSymbolicLink(), `${relative(artifactRoot, child)} is a symlink`)
      if (entry.isDirectory()) await walk(child)
      else {
        assert(entry.isFile(), `${relative(artifactRoot, child)} is not a regular file`)
        files.push(relative(artifactRoot, child))
        assert(files.length <= 20_000, `${directory} produced too many evidence files`)
      }
    }
  }
  await walk(root)
  return files.sort()
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
  if (!manifestPath) {
    const directory = evidenceDirectory(checkId)
    if (!directory) return []
    const registered = []
    for (const [index, path] of (await filesUnder(artifactRoot, directory)).entries())
      registered.push(
        await store.register({
          id: `${artifactPrefix(checkId)}${String(index + 1).padStart(5, '0')}`,
          path,
          mediaType: mediaType(path),
        }),
      )
    assert(registered.length > 0, `${checkId} produced no retained evidence files`)
    return registered
  }
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
