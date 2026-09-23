import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  containedOutputPath,
  readOwnedPrivateFileNoFollow,
  readRegularFileNoFollow,
  writeExclusiveAtomic,
} from './release-files.mjs'
import {
  assert,
  publicKeyId,
  signManifest,
  validateReleaseInputEnvelope,
  verifyManifestSignature,
} from './release-evidence.mjs'
import { assertBoundGitContext, createGitContext, git, gitNul, parseNulPaths } from './release-git.mjs'
import { parseJson } from './release-json.mjs'
import { readAndValidateProofs } from './release-proof.mjs'
import { renderReport } from './release-report.mjs'
import { readSpecifications, sourceDigest } from './release-specification.mjs'
import { validateEvidence } from './release-validation.mjs'

const repository = resolve(
  process.env.BRAID_RELEASE_CHECKOUT ?? fileURLToPath(new URL('../', import.meta.url)),
)
const gitContext = createGitContext(repository)
const resolvedRepository = gitContext.repository
const docsRoot = join(resolvedRepository, 'docs')
const artifactRoot = join(resolvedRepository, 'artifacts', 'verification')
const releaseInputRoot = join(artifactRoot, 'release')
const checksPath = join(releaseInputRoot, 'checks.json')
const packageProofPath = join(artifactRoot, 'w6', 'package-proof.json')
const visualProofPath = join(artifactRoot, 'w6', 'capture-manifest.json')
const publicKeyPath = join(resolvedRepository, 'release', 'execution-public-key.pem')
const publicKeyFingerprintPath = join(resolvedRepository, 'release', 'execution-public-key.fingerprint')
const STAGING_PREFIX = 'artifacts/verification/'

function stagedFiles(ignored = false) {
  return parseNulPaths(
    gitNul(
      gitContext,
    ...(ignored
        ? ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']
        : ['ls-files', '-z', '--others', '--exclude-standard']),
    ),
  )
}

function assertCleanSourceCheckout() {
  assert(
    resolve(process.cwd()) === resolvedRepository,
    'Release verification must run from its isolated checkout',
  )
  assertBoundGitContext(gitContext)
  assert(git(gitContext, 'rev-parse', '--is-inside-work-tree') === 'true', 'Release path is not a Git checkout')
  const status = git(gitContext, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching')
  for (const line of status.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2)
    const path = line.slice(3)
    if ((code === '??' || code === '!!') && path.startsWith(STAGING_PREFIX)) continue
    assert(false, 'Release checkout contains dirty or unexpected files')
  }
  for (const line of git(gitContext, 'ls-files', '-v').split('\n').filter(Boolean))
    assert(line[0] === 'H', 'Release checkout contains hidden tracked changes')
  assert(
    git(gitContext, 'ls-files', '--error-unmatch', 'release/execution-public-key.pem') ===
      'release/execution-public-key.pem',
    'Release public key must be tracked',
  )
  assert(
    git(gitContext, 'ls-files', '--error-unmatch', 'release/execution-public-key.fingerprint') ===
      'release/execution-public-key.fingerprint',
    'Release public-key fingerprint must be tracked',
  )
}

function assertStagingFiles(expected) {
  const actual = new Set([...stagedFiles(), ...stagedFiles(true)])
  const tracked = new Set(git(gitContext, 'ls-files').split('\n').filter(Boolean))
  for (const path of actual) assert(expected.has(path), `Unexpected release staging file ${path}`)
  for (const path of expected) {
    if (path.startsWith(STAGING_PREFIX))
      assert(actual.has(path) || tracked.has(path), `Expected release artifact is missing ${path}`)
  }
}

const { requirements, specificationDigests } = await readSpecifications(docsRoot, resolvedRepository)
assert(
  process.env.BRAID_RELEASE_ISOLATED_CHECKOUT === '1',
  'Release verification requires BRAID_RELEASE_ISOLATED_CHECKOUT=1',
)
assertCleanSourceCheckout()
const { packageProof, visualProof } = await readAndValidateProofs({
  packageProofPath,
  visualProofPath,
  artifactRoot,
})
const evidence = parseJson(
  (await readRegularFileNoFollow(checksPath, 32 * 1024 * 1024)).toString('utf8'),
  'Release evidence',
  32 * 1024 * 1024,
)
const releaseWindow = validateReleaseInputEnvelope(evidence)
assert(evidence.braidVersion === packageProof.version, 'Release evidence version differs')
assert(evidence.gitCommit === git(gitContext, 'rev-parse', 'HEAD'), 'Release evidence commit differs')
const sourceTree = git(gitContext, 'rev-parse', 'HEAD^{tree}')
assert(packageProof.gitCommit === evidence.gitCommit, 'Package proof source commit differs')
assert(packageProof.treeSha256 === sourceTree, 'Package proof source tree differs')
assert(evidence.sourceState.commit === evidence.gitCommit, 'Release source commit differs')
assert(evidence.sourceState.treeSha256 === sourceTree, 'Release source tree differs')
assert(
  packageProof.sourceDigest === (await sourceDigest(resolvedRepository)),
  'Package proof source digest differs',
)
assert(evidence.sourceState.clean === true, 'Source state is not clean')
assert(evidence.sourceState.commit === evidence.gitCommit, 'Source state commit differs')
assert(evidence.sourceState.tarballSha256 === packageProof.sha256, 'Source tarball digest differs')

const packageJson = parseJson(
  (await readRegularFileNoFollow(join(resolvedRepository, 'package.json'))).toString('utf8'),
  'Package manifest',
  2 * 1024 * 1024,
)
const publicKey = (await readRegularFileNoFollow(publicKeyPath)).toString('utf8')
const publicKeyFingerprint = (await readRegularFileNoFollow(publicKeyFingerprintPath))
  .toString('utf8')
  .trim()
assert(
  publicKeyFingerprint === publicKeyId(publicKey),
  'Release public key fingerprint is not pinned',
)
const { checks, artifacts } = await validateEvidence({
  evidence,
  requirements,
  packageProof,
  packageJson,
  repository: resolvedRepository,
  publicKey,
  gitContext,
  releaseStartedAt: releaseWindow.startedAt,
  releaseFinishedAt: releaseWindow.finishedAt,
})

const stagedExpected = new Set([
  relative(resolvedRepository, checksPath),
  relative(resolvedRepository, packageProofPath),
  relative(resolvedRepository, visualProofPath),
  ...visualProof.artifacts.map((artifact) =>
    relative(resolvedRepository, join(artifactRoot, 'w6', artifact.path)),
  ),
  ...[...artifacts.values()].map((artifact) => artifact.path),
])
assertStagingFiles(stagedExpected)

const signingKeyPath = process.env.BRAID_RELEASE_SIGNING_KEY_PATH
assert(signingKeyPath, 'BRAID_RELEASE_SIGNING_KEY_PATH is required to sign the release manifest')
const signingKeyResolved = resolve(signingKeyPath)
const signingKeyLocation = relative(resolvedRepository, signingKeyResolved)
assert(
  isAbsolute(signingKeyLocation) ||
    signingKeyLocation === '..' ||
    signingKeyLocation.startsWith(`..${sep}`),
  'Release signing key must be outside checkout',
)
const signingKeyInfo = await readOwnedPrivateFileNoFollow(signingKeyResolved)
assert(signingKeyInfo.byteLength > 0, 'Release signing key is empty')
const unsignedManifest = {
  ...evidence,
  sourceState: {
    ...evidence.sourceState,
    specificationDigests: specificationDigests.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  },
}
const manifest = signManifest(unsignedManifest, signingKeyInfo.toString('utf8'))
verifyManifestSignature(manifest, publicKey)
const outputRoot = await containedOutputPath(
  resolvedRepository,
  `artifacts/verification/${evidence.braidVersion}`,
)
const outputPath = join(outputRoot, 'manifest.json')
const reportPath = join(outputRoot, 'report.md')
await mkdir(outputRoot, { recursive: true })
await writeExclusiveAtomic(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
await writeExclusiveAtomic(reportPath, renderReport(manifest))
process.stdout.write(
  `Validated ${requirements.size} requirements, ${checks.size} signed checks, and ${artifacts.size} artifacts for @tangle-network/braid@${evidence.braidVersion}\n`,
)
