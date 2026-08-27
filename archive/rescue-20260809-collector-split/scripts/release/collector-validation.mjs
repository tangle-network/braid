import { createHash } from 'node:crypto'
import { releaseCheckEntry, SHA256_PATTERN } from '../release-check-catalog.mjs'
import {
  assert,
  assertExactKeys,
  canonicalJson,
  strictIsoTimestamp,
  validateReleaseInputEnvelope,
} from '../release-evidence.mjs'
import { readContainedFile } from '../release-files.mjs'
import { normalizeRequirementBindings } from './bindings.mjs'
import { identityDigest } from './build-identity.mjs'
import { restoredCheckArtifacts } from './check-artifacts.mjs'
import { verifyBinding } from './collection-contract.mjs'
import { validateReleaseContext } from './verification-context.mjs'

export const CHECKPOINT_SCHEMA = 'braid.release-checkpoint.v1'
export const COLLECTION_MANIFEST_SCHEMA = 'braid.release-collection.v1'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function uniqueBy(items, key, label) {
  assert(Array.isArray(items), `${label} is not an array`)
  const values = new Map()
  for (const item of items) {
    const value = item?.[key]
    assert(typeof value === 'string' && value.length > 0, `${label} has no ${key}`)
    assert(!values.has(value), `Duplicate ${label} ${value}`)
    values.set(value, item)
  }
  return values
}

export function checkpointBuild(identity) {
  return {
    schemaVersion: 1,
    identityDigest: identityDigest(identity),
    braidVersion: identity.braidVersion,
    gitCommit: identity.gitCommit,
    gitTree: identity.gitTree,
    treeSha256: identity.treeSha256,
    tarballSha256: identity.tarballSha256,
    packageIntegrity: identity.packageIntegrity,
    packageFileManifestDigest: identity.packageFileManifestDigest,
    dependencyDigest: identity.dependencyDigest,
    dependencies: identity.dependencies,
    requirementIds: identity.requirementIds,
  }
}

export function checkpointPlan({ checkIds, requirementBindings }) {
  return {
    schemaVersion: 1,
    checkIds: [...checkIds],
    requirements: Object.fromEntries(
      [...requirementBindings.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
    receiptMode: 'archive-endorsement',
  }
}

function validateEnvironmentSnapshot(snapshot, label) {
  assertExactKeys(snapshot, ['variables', 'omittedCount'], [], label)
  assert(Array.isArray(snapshot.variables), `${label} variables are not an array`)
  assert(
    Number.isInteger(snapshot.omittedCount) && snapshot.omittedCount >= 0,
    `${label} omitted count is invalid`,
  )
  const names = new Set()
  for (const variable of snapshot.variables) {
    assertExactKeys(variable, ['name', 'value', 'byteLength'], [], `${label} variable`)
    assert(
      typeof variable.name === 'string' && variable.name.length > 0,
      `${label} variable has no name`,
    )
    assert(!names.has(variable.name), `${label} repeats ${variable.name}`)
    names.add(variable.name)
    assert(
      typeof variable.value === 'string',
      `${label} variable ${variable.name} is not sanitized text`,
    )
    assert(
      Number.isSafeInteger(variable.byteLength) && variable.byteLength >= 0,
      `${label} variable ${variable.name} has invalid length`,
    )
    assert(!Object.hasOwn(variable, 'sha256'), `${label} publishes a value digest`)
    assert(!Object.hasOwn(variable, 'digest'), `${label} publishes a value digest`)
  }
}

function validateLog(log, label) {
  assertExactKeys(
    log,
    [
      'rawByteLength',
      'redactedSha256',
      'redactedByteLength',
      'redactedTruncated',
      'redactionFailClosed',
    ],
    [],
    label,
  )
  assert(SHA256_PATTERN.test(log.redactedSha256), `${label} has an invalid redacted digest`)
  assert(
    Number.isSafeInteger(log.rawByteLength) && log.rawByteLength >= 0,
    `${label} has an invalid raw length`,
  )
  assert(
    Number.isSafeInteger(log.redactedByteLength) && log.redactedByteLength >= 0,
    `${label} has an invalid redacted length`,
  )
  assert(typeof log.redactedTruncated === 'boolean', `${label} has an invalid truncation flag`)
  assert(typeof log.redactionFailClosed === 'boolean', `${label} has an invalid fail-closed flag`)
}

function validateCheckShape(check, { identity, requirementIds, expectedCategory }) {
  assertExactKeys(
    check,
    [
      'id',
      'category',
      'required',
      'command',
      'cwd',
      'environment',
      'startedAt',
      'completedAt',
      'durationMs',
      'attempt',
      'exitCode',
      'result',
      'buildSha256',
      'measurements',
      'stdout',
      'stderr',
      'failureDetails',
      'resources',
      'argv',
      'environmentSnapshot',
      'boundary',
      'binding',
      'logs',
    ],
    [],
    `Check ${check.id}`,
  )
  assert(check.category === expectedCategory, `Check ${check.id} has category ${check.category}`)
  assert(check.required === true, `Check ${check.id} is not required`)
  assert(
    check.command === releaseCheckEntry(check.id)?.command,
    `Check ${check.id} command differs from catalog`,
  )
  assert(typeof check.cwd === 'string' && check.cwd.length > 0, `Check ${check.id} has no cwd`)
  assert(
    Array.isArray(check.argv) && check.argv.length > 0,
    `Check ${check.id} has no sanitized argv`,
  )
  assert(
    check.argv.every(
      (value) =>
        typeof value === 'string' &&
        !value.includes('\0') &&
        !value.includes('\n') &&
        !value.includes('\r'),
    ),
    `Check ${check.id} has unsafe argv text`,
  )
  validateEnvironmentSnapshot(check.environmentSnapshot, `Check ${check.id} environment`)
  assertExactKeys(
    check.boundary,
    [
      'schemaVersion',
      'shell',
      'cwd',
      'processTreeStrategy',
      'cleanupConfirmed',
      'tarballSha256',
      'gitCommit',
      'dependencyDigest',
      'requirementIds',
      'resources',
    ],
    [],
    `Check ${check.id} boundary`,
  )
  assert(check.boundary.shell === false, `Check ${check.id} used a shell`)
  assert(check.boundary.cwd === check.cwd, `Check ${check.id} boundary cwd differs`)
  assert(
    check.boundary.tarballSha256 === identity.tarballSha256,
    `Check ${check.id} boundary tarball differs`,
  )
  assert(
    check.boundary.gitCommit === identity.gitCommit,
    `Check ${check.id} boundary commit differs`,
  )
  assert(
    check.boundary.dependencyDigest === identity.dependencyDigest,
    `Check ${check.id} boundary dependencies differ`,
  )
  assert(Array.isArray(check.resources), `Check ${check.id} resources are not an array`)
  assert(
    canonicalJson(check.boundary.requirementIds) === canonicalJson([...requirementIds].sort()),
    `Check ${check.id} boundary requirements differ`,
  )
  assert(
    canonicalJson(check.boundary.resources) === canonicalJson([...check.resources].sort()),
    `Check ${check.id} boundary resources differ`,
  )
  assert(
    typeof check.boundary.processTreeStrategy === 'string',
    `Check ${check.id} has no process tree strategy`,
  )
  assert(
    typeof check.boundary.cleanupConfirmed === 'boolean',
    `Check ${check.id} has no cleanup result`,
  )
  assert(
    ['passed', 'failed', 'unavailable', 'uncaptured'].includes(check.result),
    `Check ${check.id} has invalid result`,
  )
  assert(check.buildSha256 === identity.tarballSha256, `Check ${check.id} build differs`)
  assert(
    Number.isInteger(check.attempt) && check.attempt > 0,
    `Check ${check.id} has invalid attempt`,
  )
  const startedAt = strictIsoTimestamp(check.startedAt, `Check ${check.id} start`)
  const completedAt = strictIsoTimestamp(check.completedAt, `Check ${check.id} completion`)
  assert(completedAt >= startedAt, `Check ${check.id} completed before it started`)
  assert(
    check.durationMs === completedAt - startedAt,
    `Check ${check.id} duration differs from timestamps`,
  )
  assert(
    check.exitCode === null || Number.isInteger(check.exitCode),
    `Check ${check.id} has invalid exit code`,
  )
  assert(
    check.stdout && typeof check.stdout === 'object',
    `Check ${check.id} has no stdout artifact`,
  )
  assert(
    check.stderr && typeof check.stderr === 'object',
    `Check ${check.id} has no stderr artifact`,
  )
  assertExactKeys(check.stdout, ['artifactId', 'sha256'], [], `Check ${check.id} stdout`)
  assertExactKeys(check.stderr, ['artifactId', 'sha256'], [], `Check ${check.id} stderr`)
  assert(SHA256_PATTERN.test(check.stdout.sha256), `Check ${check.id} stdout digest is invalid`)
  assert(SHA256_PATTERN.test(check.stderr.sha256), `Check ${check.id} stderr digest is invalid`)
  assertExactKeys(check.logs, ['stdout', 'stderr'], [], `Check ${check.id} logs`)
  validateLog(check.logs.stdout, `Check ${check.id} stdout log`)
  validateLog(check.logs.stderr, `Check ${check.id} stderr log`)
  assert(
    check.logs.stdout.redactedSha256 === check.stdout.sha256,
    `Check ${check.id} stdout redacted digest differs`,
  )
  assert(
    check.logs.stderr.redactedSha256 === check.stderr.sha256,
    `Check ${check.id} stderr redacted digest differs`,
  )
  verifyBinding(check, identity, requirementIds)
  return { startedAt, completedAt }
}

async function validateArtifacts(envelope, artifactRoot, identity) {
  const artifacts = uniqueBy(envelope.artifacts, 'id', 'artifact')
  for (const artifact of artifacts.values()) {
    assertExactKeys(artifact, ['id', 'path', 'sha256', 'mediaType'], [], `Artifact ${artifact.id}`)
    assert(SHA256_PATTERN.test(artifact.sha256), `Artifact ${artifact.id} has an invalid digest`)
    const bytes = await readContainedFile(artifactRoot, artifact.path)
    assert(sha256(bytes) === artifact.sha256, `Artifact ${artifact.id} changed`)
  }
  const tarballArtifact = artifacts.get('package-tarball')
  assert(tarballArtifact, 'Checkpoint is missing the package tarball artifact')
  assert(
    tarballArtifact.path === identity.tarballPath,
    'Checkpoint package tarball path differs from the build identity',
  )
  assert(
    tarballArtifact.sha256 === identity.tarballSha256,
    'Checkpoint package tarball digest differs from the build identity',
  )
  return artifacts
}

export async function validateCheckpoint(checkpoint, { artifactRoot, identity, plan }) {
  assertExactKeys(checkpoint, ['schema', 'build', 'plan', 'envelope'], [], 'Release checkpoint')
  assert(checkpoint.schema === CHECKPOINT_SCHEMA, 'Unsupported release checkpoint schema')
  assert(
    canonicalJson(checkpoint.build) === canonicalJson(checkpointBuild(identity)),
    'Release checkpoint build binding differs',
  )
  assert(
    canonicalJson(checkpoint.plan) === canonicalJson(plan),
    'Release checkpoint plan binding differs',
  )
  validateReleaseInputEnvelope(checkpoint.envelope)
  const artifacts = await validateArtifacts(checkpoint.envelope, artifactRoot, identity)
  const checks = uniqueBy(checkpoint.envelope.checks, 'id', 'check')
  const environments = uniqueBy(checkpoint.envelope.environments, 'id', 'environment')
  for (const environment of environments.values()) {
    assertExactKeys(environment, ['id', 'kind', 'details'], [], `Environment ${environment.id}`)
    assert(
      environment.details &&
        typeof environment.details === 'object' &&
        !Array.isArray(environment.details),
      `Environment ${environment.id} has no details`,
    )
  }
  for (const id of checks.keys())
    assert(plan.checkIds.includes(id), `Checkpoint has an unexpected check ${id}`)
  for (const [id, check] of checks) {
    const expected = releaseCheckEntry(id)
    assert(expected, `Checkpoint has an unknown check ${id}`)
    const requirementIds = requirementIdsForPlan(plan, id)
    validateCheckShape(check, {
      identity,
      requirementIds,
      expectedCategory: expected.category,
    })
    assert(
      check.environment && typeof check.environment === 'string',
      `Check ${id} has no environment`,
    )
    assert(environments.has(check.environment), `Check ${id} names an unknown environment`)
    for (const field of ['stdout', 'stderr']) {
      const artifact = artifacts.get(check[field].artifactId)
      assert(artifact, `Check ${id} names missing ${field} artifact`)
      assert(artifact.sha256 === check[field].sha256, `Check ${id} ${field} artifact differs`)
    }
  }
  validateReleaseContext({
    environments,
    liveResources: uniqueBy(checkpoint.envelope.liveResources, 'id', 'live resource'),
    cleanup: uniqueBy(checkpoint.envelope.cleanup, 'resourceId', 'cleanup record'),
    checks,
    packageJson: {
      name: identity.packageName ?? '@tangle-network/braid',
      version: identity.braidVersion,
    },
    dependencies: identity.dependencies,
    releaseWindow: {
      startedAt: checkpoint.envelope.startedAt,
      finishedAt: checkpoint.envelope.finishedAt,
    },
  })
  const expectedArtifactIds = new Set(['package-tarball', 'package-proof'])
  for (const check of checks.values()) {
    expectedArtifactIds.add(check.stdout.artifactId)
    expectedArtifactIds.add(check.stderr.artifactId)
    for (const artifactId of restoredCheckArtifacts(check, checkpoint.envelope.artifacts))
      expectedArtifactIds.add(artifactId)
  }
  for (const id of artifacts.keys())
    assert(expectedArtifactIds.has(id), `Checkpoint has an unexpected artifact ${id}`)
  for (const id of expectedArtifactIds)
    assert(artifacts.has(id), `Checkpoint is missing expected artifact ${id}`)
  const referencedEnvironmentIds = new Set([...checks.values()].map((check) => check.environment))
  for (const id of environments.keys())
    assert(referencedEnvironmentIds.has(id), `Checkpoint has an unreferenced environment ${id}`)
  const mappings = normalizeRequirementBindings(
    checkpoint.envelope.requirements,
    identity.requirementIds,
    plan.checkIds,
  )
  for (const [id, binding] of mappings) {
    const expected = plan.requirements[id]
    assert(expected, `Checkpoint is missing requirement plan ${id}`)
    assert(
      canonicalJson(binding.checks) === canonicalJson(expected.checks),
      `Checkpoint requirement ${id} checks differ`,
    )
    const expectedArtifacts = [
      'package-tarball',
      'package-proof',
      ...binding.checks.flatMap((checkId) => {
        const check = checks.get(checkId)
        return check
          ? [
              check.stdout.artifactId,
              check.stderr.artifactId,
              ...restoredCheckArtifacts(check, checkpoint.envelope.artifacts),
            ]
          : []
      }),
    ]
    assert(
      canonicalJson(binding.artifacts) === canonicalJson(expectedArtifacts),
      `Checkpoint requirement ${id} artifacts differ`,
    )
  }
  return { artifacts, checks }
}

function requirementIdsForPlan(plan, checkId) {
  return Object.entries(plan.requirements)
    .filter(([, binding]) => binding.checks.includes(checkId))
    .map(([id]) => id)
    .sort()
}

export { requirementIdsForPlan }
