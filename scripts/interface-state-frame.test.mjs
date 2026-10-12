import assert from 'node:assert/strict'
import { mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readFreshStateFrame, stateFrameVersion } from './interface-state-frame.mjs'

test('frame capture rejects stale state and observes atomic replacement without removing the publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-state-frame-'))
  const path = join(root, 'frame.json')
  try {
    assert.equal(await readFreshStateFrame(path), undefined)
    await writeFile(path, '{"sequence":1}')
    const previous = await stateFrameVersion(path)
    assert.equal(await readFreshStateFrame(path, previous), undefined)
    assert.equal(await readFile(path, 'utf8'), '{"sequence":1}')
    const metadata = await stat(path)
    const next = join(root, 'next.json')
    await writeFile(next, '{"sequence":2}')
    await utimes(next, metadata.atime, metadata.mtime)
    await rename(next, path)
    assert.deepEqual(await readFreshStateFrame(path, previous), { sequence: 2 })
    assert.equal(await readFile(path, 'utf8'), '{"sequence":2}')
    assert.notEqual(await stateFrameVersion(path), previous)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
