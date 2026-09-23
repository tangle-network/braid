import {
  ADMISSIBLE_CATEGORIES,
  CHECK_CATEGORIES,
  EXACT_REQUIREMENT_CHECK_CATEGORIES,
  REQUIRED_CHECK_REQUIREMENTS,
  REQUIRED_CHECKS,
  SHA256_PATTERN,
  SHA512_INTEGRITY_PATTERN,
} from './release-catalog.mjs'
import { readDependencyIntegrity } from './release-dependencies.mjs'
import {
  REQUIREMENT_CASE_CHECK_FIELDS,
  REQUIREMENT_CASE_MEDIA_TYPE,
  validateRequirementCase,
} from './release-cases.mjs'
import {
  validateCheckResources,
  validateCleanup,
  validateEnvironment,
  validateResource,
} from './release-validation-context.mjs'
import {
  assert,
  assertExactKeys,
  safeIdentifier,
  safeText,
  strictIsoTimestamp,
  validateMeasurements,
  verifyCheckReceipt,
} from './release-evidence.mjs'
import { assertSafeJsonValue, canonicalJson, parseJson } from './release-json.mjs'
import { createGitContext } from './release-git.mjs'
import { readRegularFileNoFollow } from './release-files.mjs'
import {
  validatePerformanceMatrix,
  validatePerformanceMeasurements,
} from './release-performance.mjs'
import { artifactPath, sha256, sha512Integrity, uniqueBy } from './release-specification.mjs'

function validateCheckMeasurements(check, performanceMeasurements) {
  if (check.category === 'performance' && check.id === 'performance') {
    validateMeasurements(check.measurements, `Check ${check.id}`)
    assert(check.measurements.length === 1, 'Performance summary has extra measurements')
    const summary = check.measurements[0]
    assert(
      summary.kind === 'scalar' &&
        summary.name === 'targets' &&
        summary.unit === 'count' &&
        summary.value === 10,
      'Performance summary does not prove all ten targets',
    )
  } else if (check.category === 'performance') {
    validatePerformanceMeasurements(check.measurements, `Check ${check.id}`)
    performanceMeasurements.push(...check.measurements)
  } else validateMeasurements(check.measurements, `Check ${check.id}`)
  assert(
    check.measurements.every(
      (measurement) => measurement.kind !== 'unavailable' && measurement.kind !== 'uncaptured',
    ),
    `Required check ${check.id} contains unavailable measurements`,
  )
}

export async function validateEvidence({
  evidence,
  requirements,
  packageProof,
  packageJson,
  repository,
  publicKey,
  gitContext,
  releaseStartedAt,
  releaseFinishedAt,
}) {
  assertSafeJsonValue(evidence, 'Release evidence')
  assert(requirements instanceof Map, 'Requirement definitions are not retained')
  const sourceGitContext = gitContext ?? createGitContext(repository)
  assert(packageJson.name === '@tangle-network/braid', 'Package name differs')
  assert(
    packageJson.version === evidence.braidVersion,
    'Release evidence version differs from package',
  )

  const expectedDependencies = await readDependencyIntegrity(repository, packageJson)
  const dependencies = uniqueBy(evidence.dependencies, 'name', 'dependency')
  assert(
    dependencies.size === expectedDependencies.size,
    'Release dependency set differs from lockfile',
  )
  for (const [name, expected] of expectedDependencies) {
    const dependency = dependencies.get(name)
    assert(dependency, `Runtime dependency ${name} is absent from release evidence`)
    assertExactKeys(dependency, ['name', 'version', 'integrity'], [], `Dependency ${name}`)
    assert(dependency.version === expected.version, `Runtime dependency ${name} version differs`)
    assert(
      dependency.integrity === expected.integrity,
      `Runtime dependency ${name} integrity differs`,
    )
    assert(
      SHA512_INTEGRITY_PATTERN.test(dependency.integrity),
      `Dependency ${name} has invalid integrity`,
    )
  }

  const environments = uniqueBy(evidence.environments, 'id', 'environment')
  for (const environment of environments.values()) validateEnvironment(environment, packageJson)
  const liveResources = uniqueBy(evidence.liveResources, 'id', 'live resource')
  const cleanup = uniqueBy(evidence.cleanup, 'resourceId', 'cleanup record')
  for (const resource of liveResources.values()) validateResource(resource, environments)
  for (const environment of environments.values()) {
    const declared = new Set(environment.details.resourceIds)
    for (const resourceId of declared) {
      const resource = liveResources.get(resourceId)
      assert(resource, `Environment ${environment.id} names unknown resource ${resourceId}`)
      assert(resource.environment === environment.id, `Resource ${resourceId} crosses environments`)
      if (resource.billable)
        assert(
          environment.details.billableResourceIds.includes(resourceId),
          `Billable resource ${resourceId} is not declared`,
        )
    }
    for (const resourceId of environment.details.billableResourceIds) {
      const resource = liveResources.get(resourceId)
      assert(
        resource?.billable === true,
        `Environment ${environment.id} has a non-billable resource in its billable list`,
      )
    }
  }
  for (const resource of liveResources.values()) {
    const environment = environments.get(resource.environment)
    assert(
      environment.details.resourceIds.includes(resource.id),
      `Live resource ${resource.id} is omitted from its environment inventory`,
    )
  }
  for (const resource of liveResources.values())
    validateCleanup(resource, cleanup, releaseStartedAt, releaseFinishedAt)
  for (const resourceId of cleanup.keys())
    assert(liveResources.has(resourceId), `Cleanup names unknown live resource ${resourceId}`)

  const checks = uniqueBy(evidence.checks, 'id', 'check')
  const artifacts = uniqueBy(evidence.artifacts, 'id', 'artifact')
  const mappings = new Map(Object.entries(evidence.requirements))
  const allowedCheckIds = new Set([...REQUIRED_CHECKS.keys(), ...requirements.keys()])
  const allowedCommands = new Map(
    [...REQUIRED_CHECKS.values()].map((check) => [check.command, check.category]),
  )
  const performanceMeasurements = []

  for (const [checkId, requirement] of REQUIRED_CHECK_REQUIREMENTS) {
    const mapping = mappings.get(requirement)
    assert(
      mapping?.checks?.includes(checkId),
      `Fixed check ${checkId} is not assigned to ${requirement}`,
    )
  }

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
    const requirement = requirements.get(check.id)
    const checkFields = [
      'id',
      'category',
      'required',
      'command',
      'cwd',
      'environment',
      'resources',
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
    ]
    if (requirement) checkFields.push(...REQUIREMENT_CASE_CHECK_FIELDS)
    assertExactKeys(
      check,
      checkFields,
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
    assert(check.required === true, `Check ${check.id} is not marked required`)
    assert(check.buildSha256 === packageProof.sha256, `Check ${check.id} used another build`)
    safeText(check.cwd, `Check ${check.id} cwd`)
    assert(
      environments.has(check.environment),
      `Check ${check.id} names unknown environment ${check.environment}`,
    )
    const environment = environments.get(check.environment)
    validateCheckResources(check, environment, liveResources)
    const startedAt = strictIsoTimestamp(check.startedAt, `Check ${check.id} start`)
    const completedAt = strictIsoTimestamp(check.completedAt, `Check ${check.id} completion`)
    assert(startedAt >= releaseStartedAt, `Check ${check.id} started before the release`)
    assert(completedAt <= releaseFinishedAt, `Check ${check.id} ended after the release`)
    assert(completedAt >= startedAt, `Check ${check.id} completed before it started`)
    assert(
      Number.isInteger(check.durationMs) && check.durationMs === completedAt - startedAt,
      `Check ${check.id} duration differs from its timestamps`,
    )
    assert(check.exitCode === 0, `Check ${check.id} has a nonzero exit code`)
    assert(
      Number.isInteger(check.attempt) && check.attempt > 0 && check.attempt <= 1000,
      `Check ${check.id} has no bounded attempt`,
    )
    validateCheckMeasurements(check, performanceMeasurements)
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

  const artifactUses = new Map()
  const requirementCases = new Map()
  const requirementCaseSemantics = new Set()
  const useArtifact = (id, reason) => {
    assert(artifacts.has(id), `${reason} names unknown artifact ${id}`)
    artifactUses.set(id, (artifactUses.get(id) ?? 0) + 1)
  }
  useArtifact(evidence.sourceState.tarballArtifactId, 'Source state')
  for (const check of checks.values()) {
    useArtifact(check.stdout.artifactId, `Check ${check.id} stdout`)
    useArtifact(check.stderr.artifactId, `Check ${check.id} stderr`)
  }
  for (const artifact of artifacts.values()) {
    assertExactKeys(artifact, ['id', 'path', 'sha256', 'mediaType'], [], `Artifact ${artifact.id}`)
    safeIdentifier(artifact.id, 'Artifact id')
    assert(SHA256_PATTERN.test(artifact.sha256), `Artifact ${artifact.id} has invalid SHA-256`)
    safeText(artifact.mediaType, `Artifact ${artifact.id} media type`)
    const path = await artifactPath(repository, artifact.path)
    assert((await sha256(path)) === artifact.sha256, `Artifact ${artifact.id} digest changed`)
    if (requirements.has(artifact.id)) {
      assert(
        artifact.mediaType === REQUIREMENT_CASE_MEDIA_TYPE,
        `Requirement ${artifact.id} has no pinned case media type`,
      )
      assert(
        artifact.path.startsWith('artifacts/verification/'),
        `Requirement ${artifact.id} case artifact is outside the release artifact root`,
      )
      const caseResult = parseJson(
        (await readRegularFileNoFollow(path, 2 * 1024 * 1024)).toString('utf8'),
        `Requirement ${artifact.id} case artifact`,
        2 * 1024 * 1024,
      )
      const semantic = canonicalJson(caseResult)
      assert(
        !requirementCaseSemantics.has(semantic),
        `Requirement ${artifact.id} case artifact repeats semantic content`,
      )
      requirementCaseSemantics.add(semantic)
      requirementCases.set(artifact.id, caseResult)
    }
  }
  const tarballArtifact = artifacts.get(evidence.sourceState.tarballArtifactId)
  assert(tarballArtifact, 'Source state names an unknown tarball artifact')
  assert(
    packageProof.tarball === tarballArtifact.path.split('/').at(-1),
    'Package proof tarball name differs',
  )
  assert(tarballArtifact.sha256 === packageProof.sha256, 'Tarball artifact digest differs')
  assert(
    (await sha512Integrity(await artifactPath(repository, tarballArtifact.path))) ===
      evidence.packageIntegrity,
    'Tarball artifact integrity differs',
  )

  const checkUses = new Map()
  const mappingArtifactUses = new Map()
  for (const requirement of requirements.keys()) {
    const definition = requirements.get(requirement)
    const mapping = mappings.get(requirement)
    assert(mapping, `Requirement ${requirement} has no evidence mapping`)
    assertExactKeys(
      mapping,
      ['definition', 'definitionDigest', 'checks', 'artifacts'],
      [],
      `Requirement ${requirement}`,
    )
    assert(mapping.definition === definition.definition, `${requirement} definition differs`)
    assert(mapping.definitionDigest === definition.digest, `${requirement} definition digest differs`)
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
    assert(
      mapping.checks.includes(requirement),
      `${requirement} does not cite its own check record`,
    )
    assert(mapping.artifacts.includes(requirement), `${requirement} does not cite its own artifact`)
    const ownCheck = checks.get(requirement)
    assert(ownCheck, `${requirement} requires its own check record`)
    const ownArtifact = artifacts.get(requirement)
    const caseResult = requirementCases.get(requirement)
    assert(ownArtifact, `${requirement} requires its own artifact`)
    assert(caseResult, `${requirement} has no parsed case result`)
    await validateRequirementCase({
      requirement: definition,
      check: ownCheck,
      artifact: ownArtifact,
      caseResult,
      repository,
      packageProof,
      gitContext: sourceGitContext,
    })
    const prefix = requirement.slice(0, requirement.indexOf('-'))
    const admissibleCategories = ADMISSIBLE_CATEGORIES.get(prefix)
    assert(admissibleCategories, `Requirement ${requirement} has no category policy`)
    assert(
      admissibleCategories.has(ownCheck.category),
      `${requirement} own check has an inadmissible category`,
    )
    const exactCategories = EXACT_REQUIREMENT_CHECK_CATEGORIES.get(prefix)
    if (exactCategories)
      assert(
        exactCategories.has(ownCheck.category),
        `Check ${requirement} has inadmissible category`,
      )
    for (const id of mapping.checks) {
      assert(checks.has(id), `${requirement} names unknown check ${id}`)
      assert(
        admissibleCategories.has(checks.get(id).category),
        `${requirement} cites an inadmissible check category`,
      )
      checkUses.set(id, (checkUses.get(id) ?? 0) + 1)
    }
    for (const id of mapping.artifacts) {
      assert(artifacts.has(id), `${requirement} names unknown artifact ${id}`)
      mappingArtifactUses.set(id, (mappingArtifactUses.get(id) ?? 0) + 1)
      useArtifact(id, `Requirement ${requirement}`)
    }
  }
  for (const requirement of mappings.keys())
    assert(requirements.has(requirement), `Evidence maps unknown requirement ${requirement}`)
  assert(mappings.size === requirements.size, 'Evidence requirement mapping set differs')
  for (const id of checks.keys())
    assert(checkUses.get(id) === 1, `Check ${id} is reused or unreferenced`)
  for (const id of artifacts.keys())
    assert(artifactUses.get(id) === 1, `Artifact ${id} is reused or unreferenced`)
  for (const requirement of requirements.keys())
    assert(
      mappingArtifactUses.get(requirement) === 1,
      `Requirement ${requirement} has no unique artifact proof`,
    )

  return { checks, artifacts, mappings, environments, liveResources, cleanup }
}
