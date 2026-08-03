import {
  ADMISSIBLE_CATEGORIES,
  CHECK_CATEGORIES,
  EXACT_REQUIREMENT_CHECK_CATEGORIES,
  REQUIRED_CHECKS,
  SHA256_PATTERN,
  SHA512_INTEGRITY_PATTERN,
} from './release-catalog.mjs'
import {
  assert,
  assertExactKeys,
  strictIsoTimestamp,
  validateMeasurements,
  validatePerformanceMatrix,
  validatePerformanceMeasurements,
  verifyCheckReceipt,
} from './release-evidence.mjs'
import { artifactPath, sha256, sha512Integrity, uniqueBy } from './release-specification.mjs'

export async function validateEvidence({
  evidence,
  requirements,
  packageProof,
  packageJson,
  repository,
  publicKey,
  releaseStartedAt,
  releaseFinishedAt,
}) {
  const dependencies = uniqueBy(evidence.dependencies, 'name', 'dependency')
  for (const dependency of dependencies.values()) {
    assertExactKeys(
      dependency,
      ['name', 'version', 'integrity'],
      [],
      `Dependency ${dependency.name}`,
    )
    assert(
      typeof dependency.version === 'string' && dependency.version.length > 0,
      `Dependency ${dependency.name} has no version`,
    )
    assert(
      SHA512_INTEGRITY_PATTERN.test(dependency.integrity),
      `Dependency ${dependency.name} has invalid integrity`,
    )
  }
  for (const [name, version] of Object.entries(packageJson.dependencies ?? {})) {
    const dependency = dependencies.get(name)
    assert(dependency, `Runtime dependency ${name} is absent from release evidence`)
    assert(dependency.version === version, `Runtime dependency ${name} version differs`)
  }

  const environments = uniqueBy(evidence.environments, 'id', 'environment')
  for (const environment of environments.values()) {
    assertExactKeys(environment, ['id', 'kind', 'details'], [], `Environment ${environment.id}`)
    assert(
      typeof environment.kind === 'string' && environment.kind.length > 0,
      `Environment ${environment.id} has no kind`,
    )
    assert(
      environment.details &&
        typeof environment.details === 'object' &&
        !Array.isArray(environment.details),
      `Environment ${environment.id} has no details`,
    )
  }

  const checks = uniqueBy(evidence.checks, 'id', 'check')
  const artifacts = uniqueBy(evidence.artifacts, 'id', 'artifact')
  const mappings = new Map(Object.entries(evidence.requirements))
  const allowedCheckIds = new Set([...REQUIRED_CHECKS.keys(), ...requirements])
  const allowedCommands = new Map(
    [...REQUIRED_CHECKS.values()].map((check) => [check.command, check.category]),
  )
  const performanceMeasurements = []

  for (const [id, expected] of REQUIRED_CHECKS) {
    const check = checks.get(id)
    assert(check, `Required check ${id} is missing`)
    assert(
      check.category === expected.category,
      `Required check ${id} has category ${check.category}`,
    )
    assert(check.command === expected.command, `Required check ${id} has command ${check.command}`)
  }
  for (const check of checks.values()) {
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
        'receipt',
      ],
      [],
      `Check ${check.id}`,
    )
    assert(allowedCheckIds.has(check.id), `Check ${check.id} is outside the closed check catalog`)
    assert(CHECK_CATEGORIES.has(check.category), `Check ${check.id} has invalid category`)
    assert(allowedCommands.has(check.command), `Check ${check.id} uses an unregistered command`)
    assert(
      allowedCommands.get(check.command) === check.category,
      `Check ${check.id} command category differs`,
    )
    assert(check.result === 'passed', `Check ${check.id} did not pass`)
    assert(check.result !== 'unavailable', `Required check ${check.id} is unavailable`)
    assert(check.required === true, `Check ${check.id} is not marked required`)
    assert(check.buildSha256 === packageProof.sha256, `Check ${check.id} used another build`)
    assert(typeof check.cwd === 'string' && check.cwd.length > 0, `Check ${check.id} has no cwd`)
    assert(
      environments.has(check.environment),
      `Check ${check.id} names unknown environment ${check.environment}`,
    )
    const startedAt = strictIsoTimestamp(check.startedAt, `Check ${check.id} start`)
    const completedAt = strictIsoTimestamp(check.completedAt, `Check ${check.id} completion`)
    assert(startedAt >= releaseStartedAt, `Check ${check.id} started before the release`)
    assert(completedAt <= releaseFinishedAt, `Check ${check.id} ended after the release`)
    assert(completedAt >= startedAt, `Check ${check.id} completed before it started`)
    assert(
      check.durationMs === completedAt - startedAt,
      `Check ${check.id} duration differs from its timestamps`,
    )
    assert(check.exitCode === 0, `Check ${check.id} has a nonzero exit code`)
    assert(Number.isInteger(check.attempt) && check.attempt > 0, `Check ${check.id} has no attempt`)
    if (check.category === 'performance') {
      validatePerformanceMeasurements(check.measurements, `Check ${check.id}`)
      performanceMeasurements.push(...check.measurements)
    } else validateMeasurements(check.measurements, `Check ${check.id}`)
    assert(
      check.measurements.every(
        (measurement) => measurement.kind !== 'unavailable' && measurement.kind !== 'uncaptured',
      ),
      `Required check ${check.id} contains unavailable measurements`,
    )
    assert(check.failureDetails === null, `Passed check ${check.id} has failure details`)
    for (const field of ['stdout', 'stderr']) {
      const output = check[field]
      assertExactKeys(output, ['artifactId', 'sha256'], [], `Check ${check.id} ${field}`)
      assert(SHA256_PATTERN.test(output.sha256), `Check ${check.id} has invalid ${field} SHA-256`)
      const artifact = artifacts.get(output.artifactId)
      assert(artifact, `Check ${check.id} names unknown ${field} artifact ${output.artifactId}`)
      assert(artifact.sha256 === output.sha256, `Check ${check.id} ${field} digest differs`)
    }
    verifyCheckReceipt(check, publicKey)
  }
  validatePerformanceMatrix(performanceMeasurements, 'Release performance matrix')

  for (const artifact of artifacts.values()) {
    assertExactKeys(artifact, ['id', 'path', 'sha256', 'mediaType'], [], `Artifact ${artifact.id}`)
    assert(SHA256_PATTERN.test(artifact.sha256), `Artifact ${artifact.id} has invalid SHA-256`)
    assert(
      typeof artifact.mediaType === 'string' && artifact.mediaType.length > 0,
      `Artifact ${artifact.id} has no media type`,
    )
    const path = await artifactPath(repository, artifact.path)
    assert((await sha256(path)) === artifact.sha256, `Artifact ${artifact.id} digest changed`)
  }
  const tarballArtifact = artifacts.get(evidence.sourceState.tarballArtifactId)
  assert(tarballArtifact, 'Source state names an unknown tarball artifact')
  assert(tarballArtifact.sha256 === packageProof.sha256, 'Tarball artifact digest differs')
  assert(
    (await sha512Integrity(await artifactPath(repository, tarballArtifact.path))) ===
      evidence.packageIntegrity,
    'Tarball artifact integrity differs',
  )

  for (const requirement of requirements) {
    const mapping = mappings.get(requirement)
    assert(mapping, `Requirement ${requirement} has no evidence mapping`)
    assertExactKeys(mapping, ['checks', 'artifacts'], [], `Requirement ${requirement}`)
    assert(
      Array.isArray(mapping.checks) && mapping.checks.length > 0,
      `${requirement} has no checks`,
    )
    assert(
      Array.isArray(mapping.artifacts) && mapping.artifacts.length > 0,
      `${requirement} has no artifacts`,
    )
    assert(new Set(mapping.checks).size === mapping.checks.length, `${requirement} repeats a check`)
    assert(
      new Set(mapping.artifacts).size === mapping.artifacts.length,
      `${requirement} repeats an artifact`,
    )
    for (const check of mapping.checks)
      assert(checks.has(check), `${requirement} names unknown check ${check}`)
    for (const artifact of mapping.artifacts)
      assert(artifacts.has(artifact), `${requirement} names unknown artifact ${artifact}`)
    const prefix = requirement.slice(0, requirement.indexOf('-'))
    const admissibleCategories = ADMISSIBLE_CATEGORIES.get(prefix)
    assert(admissibleCategories, `Requirement ${requirement} has no category policy`)
    assert(
      mapping.checks.some((id) => admissibleCategories.has(checks.get(id).category)),
      `${requirement} is linked only to inadmissible check categories`,
    )
    const exactCategories = EXACT_REQUIREMENT_CHECK_CATEGORIES.get(prefix)
    if (exactCategories) {
      const exactCheck = checks.get(requirement)
      assert(exactCheck, `Requirement ${requirement} requires its own check record`)
      assert(
        exactCategories.has(exactCheck.category),
        `Check ${requirement} has inadmissible category`,
      )
      assert(
        mapping.checks.includes(requirement),
        `${requirement} does not cite its own check record`,
      )
    }
  }
  for (const requirement of mappings.keys()) {
    assert(requirements.has(requirement), `Evidence maps unknown requirement ${requirement}`)
  }
  const referencedChecks = new Set(
    [...mappings.values()].flatMap((mapping) =>
      Array.isArray(mapping.checks) ? mapping.checks : [],
    ),
  )
  for (const id of checks.keys())
    assert(referencedChecks.has(id), `Check ${id} is not linked to a requirement`)
  const referencedArtifacts = new Set([
    evidence.sourceState.tarballArtifactId,
    ...[...checks.values()].flatMap((check) => [check.stdout.artifactId, check.stderr.artifactId]),
    ...[...mappings.values()].flatMap((mapping) =>
      Array.isArray(mapping.artifacts) ? mapping.artifacts : [],
    ),
  ])
  for (const id of artifacts.keys())
    assert(referencedArtifacts.has(id), `Artifact ${id} is unreferenced`)

  const liveResources = uniqueBy(evidence.liveResources, 'id', 'live resource')
  const cleanup = uniqueBy(evidence.cleanup, 'resourceId', 'cleanup record')
  for (const resource of liveResources.values()) {
    assertExactKeys(
      resource,
      ['id', 'type', 'environment', 'billable'],
      [],
      `Live resource ${resource.id}`,
    )
    assert(
      environments.has(resource.environment),
      `Live resource ${resource.id} names an unknown environment`,
    )
    assert(
      typeof resource.type === 'string' && resource.type.length > 0,
      `Live resource ${resource.id} has no type`,
    )
    assert(
      typeof resource.billable === 'boolean',
      `Live resource ${resource.id} has invalid billable state`,
    )
    const record = cleanup.get(resource.id)
    assert(record, `Live resource ${resource.id} has no cleanup record`)
    assertExactKeys(
      record,
      ['resourceId', 'status', 'completedAt'],
      ['reason'],
      `Cleanup ${resource.id}`,
    )
    assert(record.status === 'confirmed', `Live resource ${resource.id} cleanup is unresolved`)
    strictIsoTimestamp(record.completedAt, `Cleanup ${resource.id} completion`)
  }
  for (const resourceId of cleanup.keys()) {
    assert(liveResources.has(resourceId), `Cleanup names unknown live resource ${resourceId}`)
  }

  return { checks, artifacts, mappings, environments, liveResources, cleanup }
}
