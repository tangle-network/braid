import { execFileSync } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  containedOutputPath,
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
import { readAndValidateProofs } from './release-proof.mjs'
import { renderReport } from './release-report.mjs'
import { readSpecifications } from './release-specification.mjs'
import { validateEvidence } from './release-validation.mjs'

const repository = resolve(
  process.env.BRAID_RELEASE_CHECKOUT ?? new URL('../', import.meta.url).pathname,
)
const docsRoot = join(repository, 'docs')
const artifactRoot = join(repository, 'artifacts', 'verification')
const releaseInputRoot = join(artifactRoot, 'release')
const checksPath = join(releaseInputRoot, 'checks.json')
const packageProofPath = join(artifactRoot, 'w6', 'package-proof.json')
const visualProofPath = join(artifactRoot, 'w6', 'capture-manifest.json')
const publicKeyPath = join(repository, 'release', 'execution-public-key.pem')
const publicKeyFingerprintPath = join(repository, 'release', 'execution-public-key.fingerprint')

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
  } catch (error) {
    if (error?.status === 0 && typeof error.stdout === 'string') return error.stdout.trim()
    throw error
  }
}

const { requirements, specificationDigests } = await readSpecifications(docsRoot, repository)
assert(
  process.env.BRAID_RELEASE_ISOLATED_CHECKOUT === '1',
  'Release verification requires BRAID_RELEASE_ISOLATED_CHECKOUT=1',
)
assert(
  resolve(process.cwd()) === repository,
  'Release verification must run from its isolated checkout',
)
assert(git('rev-parse', '--is-inside-work-tree') === 'true', 'Release path is not a Git checkout')
assert(
  git('status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching') === '',
  'Release checkout contains tracked, untracked, or ignored files',
)
assert(
  git('ls-files', '--error-unmatch', 'release/execution-public-key.pem') ===
    'release/execution-public-key.pem',
  'Release public key must be tracked',
)
assert(
  git('ls-files', '--error-unmatch', 'release/execution-public-key.fingerprint') ===
    'release/execution-public-key.fingerprint',
  'Release public-key fingerprint must be tracked',
)

const { packageProof } = await readAndValidateProofs({
  packageProofPath,
  visualProofPath,
  artifactRoot,
})
const evidence = JSON.parse(
  await readRegularFileNoFollow(checksPath)
    .then((bytes) => bytes.toString('utf8'))
    .catch(() => {
      throw new Error(
        `Release evidence is incomplete: ${relative(repository, checksPath)} is missing`,
      )
    }),
)
const releaseWindow = validateReleaseInputEnvelope(evidence)
assert(evidence.braidVersion === packageProof.version, 'Release evidence version differs')
assert(evidence.gitCommit === git('rev-parse', 'HEAD'), 'Release evidence commit differs')
const sourceTree = git('rev-parse', 'HEAD^{tree}')
assert(packageProof.gitCommit === evidence.gitCommit, 'Package proof source commit differs')
assert(packageProof.treeSha256 === sourceTree, 'Package proof source tree differs')
assert(evidence.sourceState.commit === evidence.gitCommit, 'Release source commit differs')
assert(evidence.sourceState.treeSha256 === sourceTree, 'Release source tree differs')
const releaseStartedAt = releaseWindow.startedAt
const releaseFinishedAt = releaseWindow.finishedAt

assert(evidence.sourceState.clean === true, 'Source state is not clean')
assert(evidence.sourceState.commit === evidence.gitCommit, 'Source state commit differs')
assert(evidence.sourceState.tarballSha256 === packageProof.sha256, 'Source tarball digest differs')

const packageJson = JSON.parse(
  (await readRegularFileNoFollow(join(repository, 'package.json'))).toString('utf8'),
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
  repository,
  publicKey,
  releaseStartedAt,
  releaseFinishedAt,
})

const signingKeyPath = process.env.BRAID_RELEASE_SIGNING_KEY_PATH
assert(signingKeyPath, 'BRAID_RELEASE_SIGNING_KEY_PATH is required to sign the release manifest')
const signingKeyInfo = await lstat(signingKeyPath)
assert(signingKeyInfo.isFile(), 'Release signing key is not a file')
assert(!signingKeyInfo.isSymbolicLink(), 'Release signing key may not be a symlink')
assert((signingKeyInfo.mode & 0o077) === 0, 'Release signing key permissions are broader than 0600')
assert(
  !resolve(signingKeyPath).startsWith(`${repository}/`),
  'Release signing key must be outside checkout',
)
const signingKey = (await readRegularFileNoFollow(signingKeyPath)).toString('utf8')
const unsignedManifest = {
  ...evidence,
  sourceState: {
    ...evidence.sourceState,
    specificationDigests: specificationDigests.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  },
}
const manifest = signManifest(unsignedManifest, signingKey)
verifyManifestSignature(manifest, publicKey)
const outputRoot = await containedOutputPath(
  repository,
  join('artifacts', 'verification', evidence.braidVersion),
)
const outputPath = join(outputRoot, 'manifest.json')
const reportPath = join(outputRoot, 'report.md')
await mkdir(outputRoot, { recursive: true })
await writeExclusiveAtomic(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
await writeExclusiveAtomic(reportPath, renderReport(manifest))
process.stdout.write(
  `Validated ${requirements.size} requirements, ${checks.size} signed checks, and ${artifacts.size} artifacts for @tangle-network/braid@${evidence.braidVersion}\n`,
)
