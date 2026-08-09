import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'

import {
  assert,
  assertExactKeys,
  canonicalJson,
  strictIsoTimestamp,
  validateReleaseInputEnvelope,
} from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'

export const REQUIRED_RELEASE_TARGETS = Object.freeze([
  Object.freeze({ id: 'linux-x64', platform: 'linux', architecture: 'x64' }),
  Object.freeze({ id: 'macos-arm64', platform: 'darwin', architecture: 'arm64' }),
  Object.freeze({ id: 'windows-x64', platform: 'win32', architecture: 'x64' }),
])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function containedPath(root, path, label) {
  assert(typeof path === 'string' && path.length > 0, `${label} has no path`)
  const target = resolve(root, path)
  const pathFromRoot = relative(root, target)
  assert(
    pathFromRoot !== '' &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !pathFromRoot.includes(`..${sep}`),
    `${label} escapes the release artifact root`,
  )
  return target
}

function validateSmokeRecord(record, { phase, target, packageProof }) {
  assertExactKeys(
    record,
    [
      'schema',
      'platform',
      'architecture',
      'node',
      'package',
      'tarball',
      'tarballSha256',
      'source',
      'installationRoot',
      'plainFlow',
      'encryptedStorage',
      'temporaryStateRemoved',
      'completedAt',
    ],
    [],
    `${phase} package smoke ${target.id}`,
  )
  assert(record.schema === 'braid.package-smoke.v1', `${phase} smoke schema differs`)
  assert(record.platform === target.platform, `${target.id} ran on ${record.platform}`)
  assert(record.architecture === target.architecture, `${target.id} ran on ${record.architecture}`)
  assert(/^v\d+\.\d+\.\d+$/u.test(record.node), `${target.id} has an invalid Node version`)
  assert(
    record.package === `@tangle-network/braid@${packageProof.version}`,
    `${target.id} package version differs`,
  )
  assert(record.tarball === packageProof.tarball, `${target.id} archive name differs`)
  assert(record.tarballSha256 === packageProof.sha256, `${target.id} archive digest differs`)
  assert(record.source === phase, `${target.id} source differs`)
  assert(
    record.installationRoot === '<temporary>/install/node_modules/@tangle-network',
    `${target.id} install root is not isolated`,
  )
  assert(record.plainFlow === true, `${target.id} plain flow failed`)
  assert(record.encryptedStorage === true, `${target.id} encrypted storage failed`)
  assert(record.temporaryStateRemoved === true, `${target.id} temporary state remains`)
  strictIsoTimestamp(record.completedAt, `${target.id} completion`)
}

async function readPhase({ artifactRoot, phase, packageProof }) {
  const directory = join(artifactRoot, 'publication', phase)
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort()
  const expectedNames = REQUIRED_RELEASE_TARGETS.map(({ id }) => `${id}.json`).sort()
  assert(
    canonicalJson(names) === canonicalJson(expectedNames),
    `${phase} smoke files differ from the required platform set`,
  )
  const results = []
  for (const target of REQUIRED_RELEASE_TARGETS) {
    const artifactPath = `publication/${phase}/${target.id}.json`
    const bytes = await readRegularFileNoFollow(
      containedPath(artifactRoot, artifactPath, target.id),
    )
    const record = JSON.parse(bytes.toString('utf8'))
    validateSmokeRecord(record, { phase, target, packageProof })
    results.push({
      target: target.id,
      artifactPath,
      sha256: sha256(bytes),
      record,
    })
  }
  return results
}

export async function createPublicationProof({
  artifactRoot,
  packageProof,
  completedAt = new Date().toISOString(),
}) {
  const root = resolve(artifactRoot)
  const candidate = await readPhase({ artifactRoot: root, phase: 'candidate', packageProof })
  const registry = await readPhase({ artifactRoot: root, phase: 'registry', packageProof })
  const completion = strictIsoTimestamp(completedAt, 'Publication proof completion')
  for (const result of [...candidate, ...registry])
    assert(
      strictIsoTimestamp(result.record.completedAt, `${result.target} completion`) <= completion,
      `${result.target} completed after publication proof`,
    )
  return {
    schema: 'braid.publication-proof.v1',
    package: '@tangle-network/braid',
    version: packageProof.version,
    gitCommit: packageProof.gitCommit,
    tarball: packageProof.tarball,
    tarballSha256: packageProof.sha256,
    requiredTargets: REQUIRED_RELEASE_TARGETS,
    candidate,
    registry,
    completedAt,
  }
}

function artifact(id, path, bytes) {
  return { id, path, sha256: sha256(bytes), mediaType: 'application/json' }
}

export async function applyPublicationProof({ evidence, artifactRoot, packageProof }) {
  const root = resolve(artifactRoot)
  const proofPath = 'publication/proof.json'
  const proofBytes = await readRegularFileNoFollow(
    containedPath(root, proofPath, 'Publication proof'),
  )
  const proof = JSON.parse(proofBytes.toString('utf8'))
  assertExactKeys(
    proof,
    [
      'schema',
      'package',
      'version',
      'gitCommit',
      'tarball',
      'tarballSha256',
      'requiredTargets',
      'candidate',
      'registry',
      'completedAt',
    ],
    [],
    'Publication proof',
  )
  assert(proof.schema === 'braid.publication-proof.v1', 'Publication proof schema differs')
  assert(proof.package === '@tangle-network/braid', 'Publication proof package differs')
  assert(proof.version === evidence.braidVersion, 'Publication proof version differs')
  assert(proof.version === packageProof.version, 'Publication proof package version differs')
  assert(proof.gitCommit === evidence.gitCommit, 'Publication proof commit differs')
  assert(proof.gitCommit === packageProof.gitCommit, 'Publication proof package commit differs')
  assert(proof.tarball === packageProof.tarball, 'Publication proof archive name differs')
  assert(proof.tarballSha256 === packageProof.sha256, 'Publication proof archive digest differs')
  assert(
    canonicalJson(proof.requiredTargets) === canonicalJson(REQUIRED_RELEASE_TARGETS),
    'Publication proof target set differs',
  )
  const expected = await createPublicationProof({
    artifactRoot: root,
    packageProof,
    completedAt: proof.completedAt,
  })
  assert(canonicalJson(proof) === canonicalJson(expected), 'Publication proof content differs')
  assert(
    strictIsoTimestamp(proof.completedAt, 'Publication proof completion') >=
      strictIsoTimestamp(evidence.finishedAt, 'Release completion'),
    'Publication proof predates release checks',
  )

  const publicationArtifacts = [artifact('publication-proof', proofPath, proofBytes)]
  for (const phase of ['candidate', 'registry']) {
    for (const result of proof[phase]) {
      const bytes = await readRegularFileNoFollow(
        containedPath(root, result.artifactPath, `${phase} ${result.target}`),
      )
      publicationArtifacts.push(
        artifact(`publication-${phase}-${result.target}`, result.artifactPath, bytes),
      )
    }
  }
  const existingArtifactIds = new Set(evidence.artifacts.map(({ id }) => id))
  for (const value of publicationArtifacts)
    assert(!existingArtifactIds.has(value.id), `Publication artifact ${value.id} already exists`)
  const vr10 = evidence.requirements['VR-10']
  assert(vr10, 'Release evidence has no VR-10 mapping')
  const augmented = {
    ...evidence,
    finishedAt: proof.completedAt,
    requirements: {
      ...evidence.requirements,
      'VR-10': {
        ...vr10,
        artifacts: [...vr10.artifacts, ...publicationArtifacts.map(({ id }) => id)],
      },
    },
    artifacts: [...evidence.artifacts, ...publicationArtifacts],
  }
  const releaseWindow = validateReleaseInputEnvelope(augmented)
  return { evidence: augmented, publicationProof: proof, releaseWindow }
}

export async function readPackageProof(artifactRoot) {
  return JSON.parse(await readFile(join(resolve(artifactRoot), 'w6', 'package-proof.json'), 'utf8'))
}

export function publicationProofPath(artifactRoot) {
  return join(resolve(artifactRoot), 'publication', 'proof.json')
}

export function publicationResultName(path) {
  return basename(path, '.json')
}
