import { REQUIRED_CHECKS, SHA256_PATTERN, SHA512_INTEGRITY_PATTERN } from './release-catalog.mjs'
import { assert, assertExactKeys, finiteNumber, safeIdentifier, safeText, strictIsoTimestamp } from './release-evidence.mjs'
import { canonicalJson } from './release-json.mjs'
import { assertTracked } from './release-git.mjs'
import { containedArtifactPath } from './release-files.mjs'
import { validatePerformanceMeasurements } from './release-performance.mjs'
import { sha256 } from './release-specification.mjs'

export const REQUIREMENT_CASE_MEDIA_TYPE = 'application/vnd.braid.requirement-case+json'
export const REQUIREMENT_CASE_SCHEMA_VERSION = 1

export const REQUIREMENT_CASE_CHECK_FIELDS = Object.freeze([
  'requirementId',
  'requirementDigest',
  'source',
  'suiteId',
  'caseId',
  'broadCommand',
  'implementation',
  'assertions',
  'caseArtifact',
  'provenance',
])

const CASE_ARTIFACT_FIELDS = [
  'schemaVersion',
  'mediaType',
  'requirementId',
  'requirementDigest',
  'source',
  'checkId',
  'suiteId',
  'caseId',
  'command',
  'buildSha256',
  'environment',
  'startedAt',
  'completedAt',
  'result',
  'implementation',
  'assertions',
  'provenance',
]

function commandSuiteId(command) {
  const entry = [...REQUIRED_CHECKS.entries()].find(([, expected]) => expected.command === command)
  assert(entry, `No suite is registered for ${command}`)
  return entry[0]
}

export function requirementCaseIdentity(requirementId, command) {
  const suiteId = commandSuiteId(command)
  return { suiteId, caseId: `${suiteId}:${requirementId}` }
}

function validateDigest(value, label) {
  assert(SHA256_PATTERN.test(value), `${label} is not a SHA-256 digest`)
}

async function validateRequirementSource(source, requirement, repository, gitContext, label) {
  assertExactKeys(source, ['path', 'line', 'sha256'], [], `${label} source`)
  safeText(source.path, `${label} source path`, 4096)
  assert(source.path.startsWith('docs/'), `${label} source is outside the specification tree`)
  assert(Number.isInteger(source.line) && source.line > 0, `${label} source line is invalid`)
  validateDigest(source.sha256, `${label} source`)
  assert(canonicalJson(source) === canonicalJson(requirement.source), `${label} source differs`)
  assertTracked(gitContext, source.path)
  const path = await containedArtifactPath(repository, source.path)
  assert((await sha256(path)) === source.sha256, `${label} source changed`)
}

function validateImplementation(implementation, repository, gitContext, label) {
  assertExactKeys(implementation, ['sourcePath', 'sourceSha256'], [], `${label} implementation`)
  assertTracked(gitContext, implementation.sourcePath)
  assert(!implementation.sourcePath.startsWith('artifacts/verification/'), `${label} implementation is an artifact`)
  validateDigest(implementation.sourceSha256, `${label} implementation source`)
  return containedArtifactPath(repository, implementation.sourcePath).then(async (path) => {
    assert((await sha256(path)) === implementation.sourceSha256, `${label} implementation source changed`)
    return path
  })
}

function validateAssertions(assertions, requirement, label) {
  assert(Array.isArray(assertions) && assertions.length > 0, `${label} has no assertion outcomes`)
  const names = new Set()
  for (const assertion of assertions) {
    assertExactKeys(assertion, ['name', 'result'], [], `${label} assertion`)
    safeIdentifier(assertion.name, `${label} assertion name`)
    assert(
      assertion.name.startsWith(`${requirement.id}:${requirement.digest}:`),
      `${label} assertion is not bound to the requirement definition`,
    )
    assert(!names.has(assertion.name), `${label} repeats assertion ${assertion.name}`)
    assert(assertion.result === 'passed', `${label} assertion ${assertion.name} did not pass`)
    names.add(assertion.name)
  }
}

function validateNamedPackages(packages, label, requireIntegrity) {
  assert(Array.isArray(packages) && packages.length > 0, `${label} has no packages`)
  const names = new Set()
  for (const packageInfo of packages) {
    assertExactKeys(
      packageInfo,
      requireIntegrity ? ['name', 'version', 'integrity'] : ['name', 'version'],
      [],
      `${label} package`,
    )
    safeText(packageInfo.name, `${label} package name`)
    safeText(packageInfo.version, `${label} package version`)
    assert(!names.has(packageInfo.name), `${label} repeats package ${packageInfo.name}`)
    if (requireIntegrity)
      assert(SHA512_INTEGRITY_PATTERN.test(packageInfo.integrity), `${label} package integrity is invalid`)
    names.add(packageInfo.name)
  }
}

function validateLiveProvenance(provenance, check, label) {
  assertExactKeys(
    provenance,
    [
      'kind',
      'provider',
      'runner',
      'model',
      'profileDigest',
      'environment',
      'resources',
      'packageVersions',
      'serverVersions',
      'identifiers',
      'usage',
      'cost',
      'cleanup',
    ],
    [],
    `${label} live provenance`,
  )
  assert(provenance.kind === 'live', `${label} live provenance kind differs`)
  for (const field of ['provider', 'runner', 'model']) safeText(provenance[field], `${label} ${field}`)
  validateDigest(provenance.profileDigest, `${label} profile`)
  assert(provenance.environment === check.environment, `${label} live environment differs`)
  assert(canonicalJson(provenance.resources) === canonicalJson(check.resources), `${label} live resources differ`)
  validateNamedPackages(provenance.packageVersions, `${label} live package versions`, true)
  validateNamedPackages(provenance.serverVersions, `${label} live server versions`, false)
  validateNamedRecords(provenance.identifiers, `${label} live identifiers`, (record) => {
    assertExactKeys(record, ['name', 'value'], [], `${label} live identifier`)
    safeText(record.name, `${label} live identifier name`)
    safeText(record.value, `${label} live identifier value`)
  })
  validateNamedRecords(provenance.usage, `${label} live usage`, (record) => {
    assertExactKeys(record, ['name', 'unit', 'value'], [], `${label} live usage`)
    safeText(record.name, `${label} live usage name`)
    safeText(record.unit, `${label} live usage unit`)
    finiteNumber(record.value, `${label} live usage value`)
  })
  assertExactKeys(provenance.cost, ['currency', 'value'], [], `${label} live cost`)
  safeText(provenance.cost.currency, `${label} live cost currency`)
  finiteNumber(provenance.cost.value, `${label} live cost value`)
  validateNamedRecords(provenance.cleanup, `${label} live cleanup`, (record) => {
    assertExactKeys(record, ['resourceId', 'status'], [], `${label} live cleanup`)
    safeIdentifier(record.resourceId, `${label} live cleanup resource`)
    assert(record.status === 'confirmed', `${label} live cleanup is unresolved`)
  })
  assert(
    canonicalJson(provenance.cleanup.map((record) => record.resourceId).sort()) ===
      canonicalJson([...check.resources].sort()),
    `${label} live cleanup resources differ`,
  )
}

function validateNamedRecords(records, label, validate) {
  assert(Array.isArray(records), `${label} is not an array`)
  const names = new Set()
  for (const record of records) {
    validate(record)
    const name = record.name ?? record.resourceId
    assert(!names.has(name), `${label} repeats ${name}`)
    names.add(name)
  }
}

function validateEvalProvenance(provenance, check, label) {
  assertExactKeys(
    provenance,
    ['kind', 'environment', 'resources', 'model', 'judge', 'source', 'calibration', 'rawEvidence'],
    [],
    `${label} eval provenance`,
  )
  assert(provenance.kind === 'eval', `${label} eval provenance kind differs`)
  assert(provenance.environment === check.environment, `${label} eval environment differs`)
  assert(canonicalJson(provenance.resources) === canonicalJson(check.resources), `${label} eval resources differ`)
  safeText(provenance.model, `${label} eval model`)
  assertExactKeys(
    provenance.judge,
    ['name', 'version', 'packageVersion', 'rubricSha256', 'promptSha256', 'calibrationId'],
    [],
    `${label} judge`,
  )
  for (const field of ['name', 'version', 'packageVersion', 'calibrationId'])
    safeText(provenance.judge[field], `${label} judge ${field}`)
  for (const field of ['rubricSha256', 'promptSha256']) validateDigest(provenance.judge[field], `${label} judge ${field}`)
  assertExactKeys(provenance.source, ['id', 'sha256'], [], `${label} eval source`)
  safeIdentifier(provenance.source.id, `${label} eval source id`)
  validateDigest(provenance.source.sha256, `${label} eval source`)
  assertExactKeys(
    provenance.calibration,
    ['id', 'pairs', 'preferred', 'trivialBaselineRejected'],
    [],
    `${label} calibration`,
  )
  safeIdentifier(provenance.calibration.id, `${label} calibration id`)
  for (const field of ['pairs', 'preferred'])
    assert(Number.isInteger(provenance.calibration[field]) && provenance.calibration[field] > 0, `${label} calibration ${field} is invalid`)
  assert(provenance.calibration.preferred <= provenance.calibration.pairs, `${label} calibration preference count is invalid`)
  assert(provenance.calibration.trivialBaselineRejected === true, `${label} calibration accepted a trivial baseline`)
  assertExactKeys(provenance.rawEvidence, ['inputSha256', 'outputSha256', 'score', 'cost'], [], `${label} eval raw evidence`)
  validateDigest(provenance.rawEvidence.inputSha256, `${label} eval input`)
  validateDigest(provenance.rawEvidence.outputSha256, `${label} eval output`)
  finiteNumber(provenance.rawEvidence.score, `${label} eval score`)
  finiteNumber(provenance.rawEvidence.cost, `${label} eval cost`)
}

function validateProvenance(provenance, requirement, check, label) {
  const prefix = requirement.id.slice(0, requirement.id.indexOf('-'))
  if (prefix === 'PERF') {
    assertExactKeys(provenance, ['kind', 'measurement'], [], `${label} performance provenance`)
    assert(provenance.kind === 'performance', `${label} performance provenance kind differs`)
    validatePerformanceMeasurements([provenance.measurement], `${label} performance case`)
    assert(provenance.measurement.name === requirement.id, `${label} performance case name differs`)
    assert(canonicalJson(provenance.measurement) === canonicalJson(check.measurements[0]), `${label} performance distribution differs`)
    return
  }
  if (prefix === 'UP') {
    assertExactKeys(provenance, ['kind', 'package', 'version', 'integrity', 'repository', 'commit'], [], `${label} upstream provenance`)
    assert(provenance.kind === 'upstream', `${label} upstream provenance kind differs`)
    for (const field of ['package', 'version', 'repository']) safeText(provenance[field], `${label} upstream ${field}`)
    assert(SHA512_INTEGRITY_PATTERN.test(provenance.integrity), `${label} upstream integrity is invalid`)
    assert(/^[a-f0-9]{40}$/u.test(provenance.commit), `${label} upstream commit is invalid`)
    return
  }
  if (prefix === 'LIVE') return validateLiveProvenance(provenance, check, label)
  if (prefix === 'EVAL') return validateEvalProvenance(provenance, check, label)
  assertExactKeys(provenance, ['kind'], [], `${label} deterministic provenance`)
  assert(provenance.kind === 'deterministic', `${label} deterministic provenance kind differs`)
}

export async function validateRequirementCase({
  requirement,
  check,
  artifact,
  caseResult,
  repository,
  packageProof,
  gitContext,
}) {
  const label = `Requirement ${requirement.id}`
  assertExactKeys(check, ['id', ...REQUIREMENT_CASE_CHECK_FIELDS, 'category', 'required', 'command', 'cwd', 'environment', 'resources', 'startedAt', 'completedAt', 'durationMs', 'attempt', 'exitCode', 'result', 'buildSha256', 'measurements', 'stdout', 'stderr', 'failureDetails', 'receipt'], [], `Check ${check.id}`)
  assertExactKeys(caseResult, CASE_ARTIFACT_FIELDS, [], `${label} case artifact`)
  assert(artifact.id === requirement.id, `${label} case artifact id differs`)
  assert(artifact.mediaType === REQUIREMENT_CASE_MEDIA_TYPE, `${label} case artifact media type differs`)
  assert(artifact.path.startsWith('artifacts/verification/') && artifact.path.endsWith('.json'), `${label} case artifact is outside the release artifact root`)
  assert(caseResult.schemaVersion === REQUIREMENT_CASE_SCHEMA_VERSION, `${label} case schema differs`)
  assert(caseResult.mediaType === REQUIREMENT_CASE_MEDIA_TYPE, `${label} case media type differs`)
  assert(check.id === requirement.id && check.requirementId === requirement.id, `${label} check identity differs`)
  assert(caseResult.requirementId === requirement.id, `${label} artifact requirement differs`)
  assert(check.requirementDigest === requirement.digest, `${label} check requirement digest differs`)
  assert(caseResult.requirementDigest === requirement.digest, `${label} artifact requirement digest differs`)
  assert(canonicalJson(check.source) === canonicalJson(requirement.source), `${label} check source differs`)
  assert(canonicalJson(caseResult.source) === canonicalJson(requirement.source), `${label} artifact source differs`)
  await validateRequirementSource(check.source, requirement, repository, gitContext, label)
  assert(check.checkId === undefined || check.checkId === check.id, `${label} has an invalid check identity`)
  const identity = requirementCaseIdentity(requirement.id, check.command)
  assert(check.suiteId === identity.suiteId && caseResult.suiteId === identity.suiteId, `${label} suite identity differs`)
  assert(check.caseId === identity.caseId && caseResult.caseId === identity.caseId, `${label} case identity differs`)
  assert(check.broadCommand === check.command, `${label} broad command differs from command`)
  assert(caseResult.command === check.broadCommand, `${label} artifact command differs`)
  assert(caseResult.checkId === check.id, `${label} artifact check identity differs`)
  assert(check.buildSha256 === packageProof.sha256 && caseResult.buildSha256 === check.buildSha256, `${label} build digest differs`)
  assert(caseResult.environment === check.environment, `${label} artifact environment differs`)
  assert(caseResult.startedAt === check.startedAt && caseResult.completedAt === check.completedAt, `${label} artifact timestamps differ`)
  strictIsoTimestamp(caseResult.startedAt, `${label} case start`)
  strictIsoTimestamp(caseResult.completedAt, `${label} case completion`)
  assert(caseResult.result === 'passed' && check.result === 'passed', `${label} case did not pass`)
  assert(canonicalJson(check.assertions) === canonicalJson(caseResult.assertions), `${label} assertion outcomes differ`)
  validateAssertions(check.assertions, requirement, `${label} check`)
  validateAssertions(caseResult.assertions, requirement, `${label} artifact`)
  assert(canonicalJson(check.implementation) === canonicalJson(caseResult.implementation), `${label} implementation identity differs`)
  await validateImplementation(check.implementation, repository, gitContext, label)
  assertExactKeys(check.caseArtifact, ['artifactId', 'sha256'], [], `${label} case artifact reference`)
  assert(check.caseArtifact.artifactId === artifact.id && check.caseArtifact.sha256 === artifact.sha256, `${label} case artifact reference differs`)
  assert(canonicalJson(check.provenance) === canonicalJson(caseResult.provenance), `${label} provenance differs`)
  validateProvenance(check.provenance, requirement, check, label)
}

export function requirementCaseSemanticKey(check) {
  return canonicalJson({
    requirementDigest: check.requirementDigest,
    command: check.command,
    environment: check.environment,
    resources: check.resources,
    buildSha256: check.buildSha256,
    measurements: check.measurements,
    implementation: check.implementation,
    assertions: check.assertions,
    provenance: check.provenance,
    stdoutSha256: check.stdout.sha256,
    stderrSha256: check.stderr.sha256,
  })
}

export function requirementArtifactContent(caseResult) {
  return `${JSON.stringify(caseResult, null, 2)}\n`
}
