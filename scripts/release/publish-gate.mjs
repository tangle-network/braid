import { createHash } from 'node:crypto'

import { assertMultirunProof } from '../live-required/multirun-contract.mjs'
import { REQUIRED_CHECKS } from '../release-check-catalog.mjs'
import {
  assert,
  assertExactKeys,
  canonicalJson,
  validateReleaseInputEnvelope,
} from '../release-evidence.mjs'
import { readContainedFile } from '../release-files.mjs'
import { normalizeRequirementCheckBindings, selectRequirementCheckBindings } from './bindings.mjs'
import { readCandidateIdentity } from './build-identity.mjs'
import { structuredChildEvidence, verifyBinding } from './collection-contract.mjs'
import {
  CHECKPOINT_SCHEMA,
  COLLECTION_MANIFEST_SCHEMA,
  checkpointBuild,
  checkpointPlan,
  requirementIdsForPlan,
  validateCheckpoint,
} from './collector-validation.mjs'
import { assertLiveEvidenceBinding } from './live-evidence-binding.mjs'
import { assertTangleReceipts } from './live-tangle-proof.mjs'

const LIVE10_CHECK_ID = 'LIVE-10'
const LIVE10_COMMAND = 'pnpm test:live:tangle'
const TANGLE_CHECK_IDS = Object.freeze([
  'live-tangle',
  'LIVE-06',
  'LIVE-07',
  'LIVE-08',
  'LIVE-09',
  'LIVE-10',
])
const LIVE07_ARTIFACT_PATH = 'live/tangle/evidence.json'
const COLLECTION_MANIFEST_PATH = 'release/collection-manifest.json'
const CHECKS_PATH = 'release/checks.json'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(root, path, label) {
  try {
    return JSON.parse((await readContainedFile(root, path)).toString('utf8'))
  } catch (error) {
    throw new Error(`${label} is missing or invalid`, { cause: error })
  }
}

function assertIdentityMatch(candidate, evidence) {
  for (const field of [
    'braidVersion',
    'gitCommit',
    'treeSha256',
    'tarballSha256',
    'packageIntegrity',
    'dependencyDigest',
    'dependencies',
  ])
    assert(
      canonicalJson(candidate[field]) === canonicalJson(evidence[field]),
      `Live evidence ${field} differs from the candidate`,
    )
}

function assertEnvelopeIdentity(envelope, identity) {
  assert(envelope.braidVersion === identity.braidVersion, 'Live evidence version differs')
  assert(envelope.gitCommit === identity.gitCommit, 'Live evidence commit differs')
  assert(envelope.packageIntegrity === identity.packageIntegrity, 'Live evidence integrity differs')
  assert(envelope.sourceState.commit === identity.gitCommit, 'Live source commit differs')
  assert(envelope.sourceState.treeSha256 === identity.treeSha256, 'Live source tree differs')
  assert(
    envelope.sourceState.tarballSha256 === identity.tarballSha256,
    'Live source tarball differs',
  )
  assert(
    canonicalJson(envelope.dependencies) === canonicalJson(identity.dependencies),
    'Live evidence dependencies differ',
  )
}

function assertCollectionManifest(manifest, identity, checksBytes, envelope, plan) {
  assertExactKeys(
    manifest,
    [
      'schema',
      'schemaVersion',
      'braidVersion',
      'gitCommit',
      'gitTree',
      'treeSha256',
      'tarballSha256',
      'packageIntegrity',
      'packageFileManifestDigest',
      'dependencyDigest',
      'requirementIds',
      'checkIds',
      'checkCount',
      'result',
      'startedAt',
      'finishedAt',
      'checksPath',
      'checksSha256',
      'signatures',
    ],
    [],
    'Live collection manifest',
  )
  assert(manifest.schema === COLLECTION_MANIFEST_SCHEMA, 'Live collection manifest schema differs')
  assert(manifest.schemaVersion === 1, 'Live collection manifest version differs')
  assert(manifest.result === 'passed', 'Live collection did not pass')
  assert(manifest.braidVersion === identity.braidVersion, 'Live manifest version differs')
  assert(manifest.gitCommit === identity.gitCommit, 'Live manifest commit differs')
  assert(manifest.treeSha256 === identity.treeSha256, 'Live manifest tree differs')
  assert(manifest.tarballSha256 === identity.tarballSha256, 'Live manifest tarball differs')
  assert(manifest.packageIntegrity === identity.packageIntegrity, 'Live manifest integrity differs')
  assert(
    manifest.packageFileManifestDigest === identity.packageFileManifestDigest,
    'Live manifest package file manifest differs',
  )
  assert(
    manifest.dependencyDigest === identity.dependencyDigest,
    'Live manifest dependencies differ',
  )
  assert(
    Array.isArray(manifest.checkIds) &&
      TANGLE_CHECK_IDS.every((checkId) => manifest.checkIds.includes(checkId)),
    'Live manifest omits a required Tangle check',
  )
  assert(
    Array.isArray(manifest.requirementIds) &&
      canonicalJson([...manifest.requirementIds].sort()) ===
        canonicalJson(Object.keys(plan.requirements).sort()),
    'Live manifest requirement IDs differ from the release plan',
  )
  assert(manifest.checkCount === envelope.checks.length, 'Live manifest check count differs')
  assert(
    canonicalJson([...manifest.checkIds].sort()) ===
      canonicalJson(envelope.checks.map(({ id }) => id).sort()),
    'Live manifest check IDs differ from the release evidence',
  )
  assert(
    canonicalJson([...manifest.checkIds].sort()) === canonicalJson([...plan.checkIds].sort()),
    'Live manifest check IDs differ from the release plan',
  )
  assert(manifest.checksPath === CHECKS_PATH, 'Live manifest checks path differs')
  assert(manifest.checksSha256 === sha256(checksBytes), 'Live manifest checks digest differs')
  assert(Array.isArray(manifest.signatures) && manifest.signatures.length === 0)
}

async function liveCheckpointPlan({ repository, identity }) {
  const requirementBindings = await readJson(
    repository,
    'release/requirement-bindings.json',
    'Release requirement bindings',
  )
  const allBindings = normalizeRequirementCheckBindings(
    requirementBindings,
    identity.requirementIds,
    [...new Set([...REQUIRED_CHECKS.keys(), ...identity.requirementIds, ...TANGLE_CHECK_IDS])],
  )
  const selectedBindings = selectRequirementCheckBindings(allBindings, TANGLE_CHECK_IDS)
  const plan = checkpointPlan({
    checkIds: [...TANGLE_CHECK_IDS].sort(),
    requirementBindings: selectedBindings,
  })
  return plan
}

async function validateLiveCheckpoint({ liveEvidenceRoot, identity, envelope, plan }) {
  assert(
    canonicalJson(envelope.checks.map(({ id }) => id).sort()) ===
      canonicalJson([...plan.checkIds].sort()),
    'Live evidence check IDs differ from the release plan',
  )
  await validateCheckpoint(
    {
      schema: CHECKPOINT_SCHEMA,
      build: checkpointBuild(identity),
      plan,
      envelope,
    },
    { artifactRoot: liveEvidenceRoot, identity, plan },
  )
  return plan
}

function assertLive10Check(check, identity, requirementIds) {
  assert(check && typeof check === 'object' && !Array.isArray(check), 'LIVE-10 check is missing')
  assert(check.id === LIVE10_CHECK_ID, 'Live evidence selected another check')
  assert(check.category === 'live', 'LIVE-10 check has the wrong category')
  assert(check.required === true, 'LIVE-10 check is not required')
  assert(check.command === LIVE10_COMMAND, 'LIVE-10 check uses another command')
  assert(check.result === 'passed', 'LIVE-10 did not pass')
  assert(check.exitCode === 0, 'LIVE-10 did not exit successfully')
  assert(check.buildSha256 === identity.tarballSha256, 'LIVE-10 used another tarball')
  verifyBinding(check, identity, requirementIds)
  assert(
    Array.isArray(check.measurements) && check.measurements.length === 1,
    'LIVE-10 has no unique release measurement',
  )
  assertExactKeys(
    check.measurements[0],
    ['kind', 'name', 'unit', 'value'],
    [],
    'LIVE-10 measurement',
  )
  assert(check.measurements[0].kind === 'scalar', 'LIVE-10 measurement is not scalar')
  assert(check.measurements[0].name === LIVE10_CHECK_ID, 'LIVE-10 measurement names another check')
  assert(check.measurements[0].unit === 'verified-flow', 'LIVE-10 measurement uses another unit')
  assert(check.measurements[0].value === 1, 'LIVE-10 measurement did not verify one flow')
}

async function assertLive10ReleaseMarker({ root, check, envelope }) {
  const stdoutArtifact = envelope.artifacts.find(({ id }) => id === check.stdout?.artifactId)
  assert(stdoutArtifact, 'LIVE-10 stdout artifact is missing')
  assert(stdoutArtifact.sha256 === check.stdout.sha256, 'LIVE-10 stdout digest differs')
  const stdout = await readContainedFile(root, stdoutArtifact.path)
  assert(sha256(stdout) === stdoutArtifact.sha256, 'LIVE-10 stdout artifact changed')
  const evidence = structuredChildEvidence('live', stdout, check.durationMs, LIVE10_CHECK_ID)
  assert(evidence.result === 'passed', evidence.reason ?? 'LIVE-10 release receipt did not pass')
  assert(
    canonicalJson(evidence.measurements) === canonicalJson(check.measurements),
    'LIVE-10 measurement differs from its release receipt',
  )
}

async function assertLive07Artifact({ root, envelope, identity }) {
  const candidates = envelope.artifacts.filter(
    ({ id, path }) => id.startsWith('check-LIVE-10-attempt-') && path === LIVE07_ARTIFACT_PATH,
  )
  assert(candidates.length === 1, 'LIVE-10 has no unique retained LIVE-07 artifact')
  const artifact = candidates[0]
  const bytes = await readContainedFile(root, artifact.path)
  assert(sha256(bytes) === artifact.sha256, 'LIVE-07 artifact digest changed')
  const proof = JSON.parse(bytes.toString('utf8'))
  assertMultirunProof(proof)
  assertLiveEvidenceBinding(proof.releaseBinding, identity, 'LIVE-07 multirun evidence')
  const requirement = envelope.requirements?.[LIVE10_CHECK_ID]
  assert(requirement && Array.isArray(requirement.checks), 'LIVE-10 requirement mapping is missing')
  assert(requirement.checks.includes(LIVE10_CHECK_ID), 'LIVE-10 requirement uses another check')
  assert(
    Array.isArray(requirement.artifacts) && requirement.artifacts.includes(artifact.id),
    'LIVE-10 requirement does not retain its LIVE-07 artifact',
  )
}

async function assertLive10Receipt({ root, envelope, identity }) {
  const path = 'live/tangle/receipts.json'
  const bytes = await readContainedFile(root, path)
  const artifact = envelope.artifacts.find(
    (candidate) => candidate?.id?.startsWith('check-LIVE-10-attempt-') && candidate.path === path,
  )
  assert(artifact, 'LIVE-10 has no retained receipt artifact')
  assert(sha256(bytes) === artifact.sha256, 'LIVE-10 receipt artifact digest changed')
  const receipts = JSON.parse(bytes.toString('utf8'))
  assertTangleReceipts(receipts, identity)
  const aggregateCheck = envelope.checks.find(({ id }) => id === 'live-tangle')
  assert(aggregateCheck?.result === 'passed', 'live-tangle check did not pass')
  for (const row of TANGLE_CHECK_IDS.slice(1)) {
    const flow = receipts.flows.find(({ row: candidate }) => candidate === row)
    assert(flow?.status === 'passed', `${row} receipt did not pass`)
    const check = envelope.checks.find(({ id }) => id === row)
    assert(check?.result === 'passed', `${row} check did not pass`)
    assert(check.buildSha256 === identity.tarballSha256, `${row} used another tarball`)
  }
  const live10 = receipts.flows.find(({ row }) => row === LIVE10_CHECK_ID)
  assert(live10?.status === 'passed', 'LIVE-10 receipt did not pass')
  assertLiveEvidenceBinding(live10.evidence?.releaseBinding, identity, 'LIVE-10 live evidence')
  const requirement = envelope.requirements?.[LIVE10_CHECK_ID]
  assert(
    Array.isArray(requirement?.artifacts) && requirement.artifacts.includes(artifact.id),
    'LIVE-10 requirement does not retain its receipt artifact',
  )
}

/** Verify that checked live evidence belongs to the exact candidate being published. */
export async function verifyLive10Candidate({
  repository,
  candidateRoot,
  liveEvidenceRoot,
  expectedCommit,
  expectedVersion,
} = {}) {
  const candidate = await readCandidateIdentity({
    repository,
    artifactRoot: candidateRoot,
    expectedCommit,
    expectedVersion,
  })
  const live = await readCandidateIdentity({
    repository,
    artifactRoot: liveEvidenceRoot,
    expectedCommit,
    expectedVersion,
  })
  assertIdentityMatch(candidate.identity, live.identity)

  const checksBytes = await readContainedFile(liveEvidenceRoot, CHECKS_PATH)
  const envelope = await readJson(liveEvidenceRoot, CHECKS_PATH, 'Live release evidence')
  validateReleaseInputEnvelope(envelope)
  assertEnvelopeIdentity(envelope, candidate.identity)

  const manifest = await readJson(
    liveEvidenceRoot,
    COLLECTION_MANIFEST_PATH,
    'Live collection manifest',
  )
  const plan = await liveCheckpointPlan({ repository, identity: candidate.identity })
  assertCollectionManifest(manifest, candidate.identity, checksBytes, envelope, plan)
  await validateLiveCheckpoint({ liveEvidenceRoot, identity: candidate.identity, envelope, plan })

  const check = envelope.checks.find(({ id }) => id === LIVE10_CHECK_ID)
  assertLive10Check(check, candidate.identity, requirementIdsForPlan(plan, LIVE10_CHECK_ID))
  await assertLive10ReleaseMarker({ root: liveEvidenceRoot, check, envelope })
  await assertLive10Receipt({ root: liveEvidenceRoot, envelope, identity: candidate.identity })
  await assertLive07Artifact({
    root: liveEvidenceRoot,
    envelope,
    identity: candidate.identity,
  })
  return { candidate, live, check, manifest }
}
