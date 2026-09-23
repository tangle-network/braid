import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { appendFile, chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assert } from './release-evidence.mjs'
import { cloneEvidence, writeEvidence } from './release-test-fixture.mjs'

function runVerifier(fixture) {
  rmSync(join(fixture.root, 'artifacts/verification/0.1.0'), { force: true, recursive: true })
  const result = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      BRAID_RELEASE_ISOLATED_CHECKOUT: '1',
      BRAID_RELEASE_SIGNING_KEY_PATH: fixture.keyPath,
    },
    encoding: 'utf8',
    timeout: 120000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

async function childReject(fixture, label, evidence, pattern) {
  await writeEvidence(fixture, evidence)
  try {
    const result = runVerifier(fixture)
    assert(result.status !== 0, `${label} was accepted by the release process`)
    assert(pattern.test(result.output), `${label} failed with an unrelated error`)
  } finally {
    await writeEvidence(fixture, fixture.evidence)
  }
}

export async function runChildMutations(fixture) {
  let rejected = 0
  const crossCommit = cloneEvidence(fixture.evidence)
  crossCommit.gitCommit = 'c'.repeat(40)
  crossCommit.sourceState.commit = crossCommit.gitCommit
  await childReject(fixture, 'cross-commit evidence', crossCommit, /commit differs/iu)
  rejected += 1

  const packageProofPath = join(fixture.root, 'artifacts/verification/w6/package-proof.json')
  const packageProof = await readFile(packageProofPath)
  await writeFile(
    packageProofPath,
    `${JSON.stringify({ ...fixture.packageProof, gitCommit: 'd'.repeat(40) }, null, 2)}\n`,
  )
  try {
    const result = runVerifier(fixture)
    assert(
      result.status !== 0 && /commit differs/iu.test(result.output),
      'cross-build package proof was accepted',
    )
  } finally {
    await writeFile(packageProofPath, packageProof)
  }
  rejected += 1

  const originalExclude = await readFile(join(fixture.root, '.git/info/exclude')).catch(() =>
    Buffer.from(''),
  )
  const dirtyPath = join(fixture.root, 'unexpected-dirty.txt')
  await writeFile(dirtyPath, 'dirty')
  try {
    const result = runVerifier(fixture)
    assert(
      result.status !== 0 && /dirty|unexpected/iu.test(result.output),
      'dirty checkout was accepted',
    )
  } finally {
    await rm(dirtyPath, { force: true })
  }
  rejected += 1

  const ignoredPath = join(fixture.root, 'unexpected-ignored.txt')
  const excludePath = join(fixture.root, '.git/info/exclude')
  await mkdir(join(fixture.root, '.git/info'), { recursive: true })
  await appendFile(excludePath, '\nunexpected-ignored.txt\n')
  await writeFile(ignoredPath, 'ignored')
  try {
    const result = runVerifier(fixture)
    assert(
      result.status !== 0 && /dirty|unexpected/iu.test(result.output),
      'ignored checkout was accepted',
    )
  } finally {
    await rm(ignoredPath, { force: true })
    await writeFile(excludePath, originalExclude)
  }
  rejected += 1

  await chmod(fixture.keyPath, 0o644)
  try {
    const result = runVerifier(fixture)
    assert(
      result.status !== 0 && /permissions/iu.test(result.output),
      'broadly readable signing key was accepted',
    )
  } finally {
    await chmod(fixture.keyPath, 0o600)
  }
  rejected += 1

  const keyLink = join(fixture.keyRoot, 'signing-key-link')
  await symlink(fixture.keyPath, keyLink)
  try {
    const result = runVerifier({ ...fixture, keyPath: keyLink })
    assert(
      result.status !== 0 && /regular|symlink/iu.test(result.output),
      'signing-key symlink was accepted',
    )
  } finally {
    await rm(keyLink, { force: true })
  }
  rejected += 1

  const fingerprintPath = join(fixture.root, 'release/execution-public-key.fingerprint')
  const fingerprint = await readFile(fingerprintPath)
  await writeFile(fingerprintPath, `${fingerprint.toString().trim()}-tampered\n`)
  try {
    const result = runVerifier(fixture)
    assert(
      result.status !== 0 && /dirty|unexpected|fingerprint|pinned/iu.test(result.output),
      'tampered public-key fingerprint was accepted',
    )
  } finally {
    await writeFile(fingerprintPath, fingerprint)
  }
  rejected += 1
  return rejected
}
