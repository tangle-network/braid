import { generateKeyPairSync } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { publicKeyId, signCheck } from './release-evidence.mjs'
import { createGitContext, git as gitCommand, initializeGit } from './release-git.mjs'
import { readSpecifications, sourceDigest } from './release-specification.mjs'
import { buildEvidence } from './release-test-evidence-fixture.mjs'
import { addArtifact, makeVisualProof } from './release-test-visual-fixture.mjs'

const STARTED_AT = '2026-08-03T00:00:00.000Z'
const FINISHED_AT = '2026-08-03T00:30:00.000Z'
const RESOURCE_ID = 'fixture-resource'
const PACKAGE_NAME = '@tangle-network/braid'
const PACKAGE_VERSION = '0.1.0'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function makeFixtureTarball() {
  const packageJson = Buffer.from(
    `${JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION })}\n`,
  )
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(`${packageJson.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.fill(0x20, 148, 156)
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = header.reduce((total, byte) => total + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  const paddedLength = Math.ceil(packageJson.byteLength / 512) * 512
  const paddedPackageJson = Buffer.alloc(paddedLength)
  packageJson.copy(paddedPackageJson)
  return gzipSync(Buffer.concat([header, paddedPackageJson, Buffer.alloc(1024)]), { level: 9 })
}

export async function createReleaseFixture(sourceRepository) {
  const root = await mkdtemp(join(tmpdir(), 'braid-release-fixture-'))
  const keyRoot = await mkdtemp(join(tmpdir(), 'braid-release-key-'))
  const keyPath = join(keyRoot, 'ephemeral-ed25519.pem')
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  try {
    await cp(join(sourceRepository, 'docs'), join(root, 'docs'), { recursive: true })
    await cp(join(sourceRepository, 'scripts'), join(root, 'scripts'), { recursive: true })
    await mkdir(join(root, 'release'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      `${JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION, dependencies: { 'fixture-dependency': '1.0.0' } })}\n`,
    )
    await writeFile(
      join(root, 'pnpm-lock.yaml'),
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      fixture-dependency:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  fixture-dependency@1.0.0:\n    resolution: {integrity: sha512-${Buffer.alloc(64, 7).toString('base64')}}\n`,
    )
    await writeFile(
      join(root, 'release/execution-public-key.pem'),
      publicKey.export({ format: 'pem', type: 'spki' }),
    )
    await writeFile(
      join(root, 'release/execution-public-key.fingerprint'),
      `${publicKeyId(publicKey)}\n`,
    )
    await writeFile(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    initializeGit(root, 'init', '-q')
    git(root, 'config', 'core.hooksPath', '/dev/null')
    git(root, 'config', 'user.email', 'fixture@example.invalid')
    git(root, 'config', 'user.name', 'Release Fixture')
    git(root, 'add', 'docs', 'scripts', 'package.json', 'pnpm-lock.yaml', 'release')
    git(root, 'commit', '-qm', 'fixture source')
    const commit = git(root, 'rev-parse', 'HEAD')
    const tree = git(root, 'rev-parse', 'HEAD^{tree}')
    const artifacts = []
    await addArtifact(
      root,
      artifacts,
      'package-tarball',
      'artifacts/verification/w6/fixture-package.tgz',
      makeFixtureTarball(),
      'application/gzip',
    )
    const packageProof = {
      tarball: 'fixture-package.tgz',
      sha256: artifacts.find((artifact) => artifact.id === 'package-tarball').sha256,
      version: PACKAGE_VERSION,
      gitCommit: commit,
      treeSha256: tree,
      sourceDigest: await sourceDigest(root),
      isolatedBuild: true,
      sourceCheckout: 'isolated-copy-of-worktree',
      rpcRecords: 1,
      referenceSizes: [
        { columns: 40, rows: 12, events: 1 },
        { columns: 80, rows: 24, events: 1 },
        { columns: 120, rows: 40, events: 1 },
        { columns: 200, rows: 60, events: 1 },
      ],
      alternateScreenRestored: true,
      sigintRestored: true,
      stateWriteSymlinkSafe: true,
      inlineStayedInMainScreen: true,
      keyboardMatchesRpc: true,
      eventLedgerMatchesRpc: true,
      flowParity: { rpc: ['send'], terminal: ['send'], plain: ['send'], allFlowsMatch: true },
      plainRecordState: true,
    }
    await mkdir(join(root, 'artifacts/verification/w6'), { recursive: true })
    await writeFile(
      join(root, 'artifacts/verification/w6/package-proof.json'),
      `${JSON.stringify(packageProof, null, 2)}\n`,
    )
    await makeVisualProof(root, STARTED_AT, packageProof.sha256, 'a'.repeat(64), artifacts)
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const { requirements } = await readSpecifications(join(root, 'docs'), root)
    const evidenceArtifacts = artifacts.slice(1)
    const evidence = await buildEvidence({
      root,
      privateKey,
      packageProof,
      artifacts: evidenceArtifacts,
      requirements,
      packageJson,
      startedAt: STARTED_AT,
      finishedAt: FINISHED_AT,
      resourceId: RESOURCE_ID,
    })
    await mkdir(join(root, 'artifacts/verification/release'), { recursive: true })
    await writeFile(
      join(root, 'artifacts/verification/release/checks.json'),
      `${JSON.stringify(evidence, null, 2)}\n`,
    )
    return {
      root,
      keyRoot,
      keyPath,
      privateKey,
      publicKey,
      packageProof,
      evidence,
      requirements,
      artifacts,
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    await rm(keyRoot, { recursive: true, force: true })
    throw error
  }
}

function git(root, ...args) {
  return gitCommand(createGitContext(root), ...args)
}

export async function writeEvidence(fixture, evidence) {
  await writeFile(
    join(fixture.root, 'artifacts/verification/release/checks.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
}

export function cloneEvidence(evidence) {
  return clone(evidence)
}

export function resignCheck(evidence, id, update, privateKey) {
  const index = evidence.checks.findIndex((check) => check.id === id)
  if (index < 0) throw new Error(`Unknown fixture check ${id}`)
  evidence.checks[index] = signCheck({ ...evidence.checks[index], ...update }, privateKey)
}

export async function disposeFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true })
  await rm(fixture.keyRoot, { recursive: true, force: true })
}
