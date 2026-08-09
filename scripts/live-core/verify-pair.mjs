import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const repository = new URL('../../', import.meta.url)
const paths = ['pi.json', 'codex.json'].map(
  (name) => new URL(`artifacts/verification/live-core/${name}`, repository),
)
const records = await Promise.all(
  paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
)
const sha256 = /^[a-f0-9]{64}$/u

for (const [index, record] of records.entries()) {
  assert.equal(record.schemaVersion, 1, `${paths[index].pathname} has no supported schema`)
  assert.equal(record.status, 'passed', `${paths[index].pathname} did not pass`)
  assert.match(record.source?.commit ?? '', /^[a-f0-9]{40}$/u)
  assert.match(record.source?.indexTree ?? '', /^[a-f0-9]{40}$/u)
  assert.match(record.source?.stagedPatchSha256 ?? '', sha256)
  assert.match(record.artifact?.tarballSha256 ?? '', sha256)
  assert.match(record.artifact?.binarySha256 ?? '', sha256)
  assert.ok(Date.parse(record.completedAt) >= Date.parse(record.startedAt))
}

for (const field of ['commit', 'indexTree', 'stagedPatchSha256', 'packageVersion']) {
  assert.equal(records[0].source[field], records[1].source[field], `Live source ${field} differs`)
}
for (const field of ['tarballSha256', 'binarySha256']) {
  assert.equal(
    records[0].artifact[field],
    records[1].artifact[field],
    `Live artifact ${field} differs`,
  )
}

process.stdout.write(
  `Live Pi and Codex records share tarball ${records[0].artifact.tarballSha256}\n`,
)
