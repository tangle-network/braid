import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assert } from './release-evidence.mjs'
import { parseJson } from './release-json.mjs'
import { cloneEvidence } from './release-test-fixture.mjs'
import { validateEvidence } from './release-validation.mjs'

export async function validateFixture(fixture, evidence, publicKey = fixture.publicKey) {
  const packageJson = parseJson(
    (await readFile(join(fixture.root, 'package.json'))).toString('utf8'),
    'Fixture package manifest',
  )
  return validateEvidence({
    evidence,
    requirements: fixture.requirements,
    packageProof: fixture.packageProof,
    packageJson,
    repository: fixture.root,
    publicKey,
    releaseStartedAt: Date.parse(fixture.evidence.startedAt),
    releaseFinishedAt: Date.parse(fixture.evidence.finishedAt),
  })
}

export async function expectReject(action, label, pattern = /./u) {
  try {
    await action()
  } catch (error) {
    assert(pattern.test(String(error)), `${label} failed with an unrelated error`)
    return
  }
  throw new Error(`${label} was accepted`)
}

export async function mutateEvidence(
  fixture,
  label,
  mutate,
  pattern,
  publicKey = fixture.publicKey,
) {
  const evidence = cloneEvidence(fixture.evidence)
  await mutate(evidence)
  await expectReject(() => validateFixture(fixture, evidence, publicKey), label, pattern)
}
