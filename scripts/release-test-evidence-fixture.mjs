import {
  ADMISSIBLE_CATEGORIES,
  EXACT_REQUIREMENT_CHECK_CATEGORIES,
  REQUIRED_CHECK_REQUIREMENTS,
  REQUIRED_CHECKS,
} from './release-catalog.mjs'
import { assert, signCheck } from './release-evidence.mjs'
import {
  REQUIREMENT_CASE_MEDIA_TYPE,
  requirementArtifactContent,
  requirementCaseIdentity,
} from './release-cases.mjs'
import {
  REQUIRED_PERFORMANCE_ENVIRONMENTS,
  REQUIRED_PERFORMANCE_TARGETS,
} from './release-performance.mjs'
import { sha256, sha512Integrity } from './release-specification.mjs'
import { addArtifact } from './release-test-visual-fixture.mjs'
import { join } from 'node:path'

const CHECK_STARTED_AT = '2026-08-03T00:00:01.000Z'
const CHECK_COMPLETED_AT = '2026-08-03T00:00:02.000Z'
const IMPLEMENTATION_PATH = 'scripts/release-test-evidence-fixture.mjs'
const FIXTURE_DEPENDENCY_INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString('base64')}`

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function commandForCategory(category) {
  return [...REQUIRED_CHECKS.values()].find((check) => check.category === category)?.command
}

function ownCategory(requirement) {
  const prefix = requirement.slice(0, requirement.indexOf('-'))
  const exact = EXACT_REQUIREMENT_CHECK_CATEGORIES.get(prefix)
  return exact ? [...exact][0] : [...ADMISSIBLE_CATEGORIES.get(prefix)][0]
}

function performanceMeasurement(name) {
  const target = REQUIRED_PERFORMANCE_TARGETS[name]
  const environment = REQUIRED_PERFORMANCE_ENVIRONMENTS[name]
  const value = target.value / 2
  const values = [value / 4, value / 3, value / 2, value * 0.75, value]
  return {
    kind: 'distribution',
    name,
    unit: target.unit,
    n: 2,
    minimum: values[0],
    median: values[1],
    p90: values[2],
    p95: values[3],
    p99: values[4],
    maximum: values[4],
    target: clone(target),
    environment: {
      machine: 'fixture-linux-x64',
      os: 'linux',
      node: process.version,
      terminal: 'xterm-256color',
      dimensions: '80x24',
      database: environment.database,
      eventCount: environment.eventCount,
    },
    state: environment.state,
    repetitions: 2,
  }
}

async function makeCheck(
  root,
  artifacts,
  privateKey,
  id,
  category,
  command,
  buildSha256,
  environment,
  resources,
  measurements,
  extra = {},
) {
  const stdoutId = `output-${id}-stdout`
  const stderrId = `output-${id}-stderr`
  await addArtifact(
    root,
    artifacts,
    stdoutId,
    `artifacts/verification/fixture/output/${id}-stdout.txt`,
    Buffer.from(`${id} stdout\n`),
    'text/plain',
  )
  await addArtifact(
    root,
    artifacts,
    stderrId,
    `artifacts/verification/fixture/output/${id}-stderr.txt`,
    Buffer.alloc(0),
    'text/plain',
  )
  return signCheck(
    {
      id,
      category,
      required: true,
      command,
      cwd: '.',
      environment,
      resources,
      startedAt: CHECK_STARTED_AT,
      completedAt: CHECK_COMPLETED_AT,
      durationMs: 1_000,
      attempt: 1,
      exitCode: 0,
      result: 'passed',
      buildSha256,
      measurements,
      stdout: {
        artifactId: stdoutId,
        sha256: artifacts.find((artifact) => artifact.id === stdoutId).sha256,
      },
      stderr: {
        artifactId: stderrId,
        sha256: artifacts.find((artifact) => artifact.id === stderrId).sha256,
      },
      failureDetails: null,
      ...extra,
    },
    privateKey,
  )
}

function caseProvenance(requirement, category, measurements, resourceId) {
  const prefix = requirement.slice(0, requirement.indexOf('-'))
  if (prefix === 'PERF') return { kind: 'performance', measurement: clone(measurements[0]) }
  if (prefix === 'UP')
    return {
      kind: 'upstream',
      package: 'fixture-dependency',
      version: '1.0.0',
      integrity: FIXTURE_DEPENDENCY_INTEGRITY,
      repository: 'https://example.invalid/fixture-dependency',
      commit: 'b'.repeat(40),
    }
  if (prefix === 'LIVE')
    return {
      kind: 'live',
      provider: 'fixture-provider',
      runner: 'fixture-runner',
      model: 'fixture-model',
      profileDigest: 'c'.repeat(64),
      environment: 'fixture-linux',
      resources: [resourceId],
      packageVersions: [{ name: 'fixture-dependency', version: '1.0.0', integrity: FIXTURE_DEPENDENCY_INTEGRITY }],
      serverVersions: [{ name: 'fixture-server', version: '1.0.0' }],
      identifiers: [{ name: 'run', value: `${requirement}-run` }],
      usage: [{ name: 'tokens', unit: 'count', value: 1 }],
      cost: { currency: 'USD', value: 0 },
      cleanup: [{ resourceId, status: 'confirmed' }],
    }
  if (prefix === 'EVAL')
    return {
      kind: 'eval',
      environment: 'fixture-linux',
      resources: [],
      model: 'fixture-judge-model',
      judge: {
        name: 'fixture-judge',
        version: '1.0.0',
        packageVersion: '0.139.2',
        rubricSha256: 'd'.repeat(64),
        promptSha256: 'e'.repeat(64),
        calibrationId: 'fixture-calibration',
      },
      source: { id: `${requirement}-source`, sha256: 'f'.repeat(64) },
      calibration: { id: 'fixture-calibration', pairs: 12, preferred: 12, trivialBaselineRejected: true },
      rawEvidence: {
        inputSha256: '1'.repeat(64),
        outputSha256: '2'.repeat(64),
        score: 1,
        cost: 0,
      },
    }
  assert(category !== 'performance', `Unexpected fixture category for ${requirement}`)
  return { kind: 'deterministic' }
}

async function makeRequirementCheck(
  root,
  artifacts,
  privateKey,
  requirement,
  category,
  command,
  buildSha256,
  environment,
  resources,
  measurements,
  implementation,
  resourceId,
) {
  const identity = requirementCaseIdentity(requirement.id, command)
  const assertions = [
    { name: `${requirement.id}:case-executed`, result: 'passed' },
    { name: `${requirement.id}:behavior-asserted`, result: 'passed' },
  ]
  const provenance = caseProvenance(requirement.id, category, measurements, resourceId)
  const caseResult = {
    schemaVersion: 1,
    mediaType: REQUIREMENT_CASE_MEDIA_TYPE,
    requirementId: requirement.id,
    requirementDigest: requirement.digest,
    checkId: requirement.id,
    suiteId: identity.suiteId,
    caseId: identity.caseId,
    command,
    buildSha256,
    environment,
    startedAt: CHECK_STARTED_AT,
    completedAt: CHECK_COMPLETED_AT,
    result: 'passed',
    implementation,
    assertions,
    provenance,
  }
  const artifactPath = `artifacts/verification/fixture/requirements/${requirement.id}.json`
  await addArtifact(
    root,
    artifacts,
    requirement.id,
    artifactPath,
    Buffer.from(requirementArtifactContent(caseResult)),
    REQUIREMENT_CASE_MEDIA_TYPE,
  )
  const artifact = artifacts.find((candidate) => candidate.id === requirement.id)
  return makeCheck(
    root,
    artifacts,
    privateKey,
    requirement.id,
    category,
    command,
    buildSha256,
    environment,
    resources,
    measurements,
    {
      requirementId: requirement.id,
      requirementDigest: requirement.digest,
      ...identity,
      broadCommand: command,
      implementation: clone(implementation),
      assertions,
      caseArtifact: { artifactId: requirement.id, sha256: artifact.sha256 },
      provenance,
    },
  )
}

export async function buildEvidence({
  root,
  privateKey,
  packageProof,
  artifacts,
  requirements,
  packageJson,
  startedAt,
  finishedAt,
  resourceId,
}) {
  const sortedRequirements = [...requirements.keys()].sort()
  const implementation = {
    sourcePath: IMPLEMENTATION_PATH,
    sourceSha256: await sha256(join(root, IMPLEMENTATION_PATH)),
  }
  const checks = []
  for (const [id, expected] of REQUIRED_CHECKS) {
    const measurements =
      id === 'performance'
        ? [{ kind: 'scalar', name: 'targets', unit: 'count', value: 10 }]
        : [{ kind: 'scalar', name: 'result', unit: 'count', value: 1 }]
    checks.push(
      await makeCheck(
        root,
        artifacts,
        privateKey,
        id,
        expected.category,
        expected.command,
        packageProof.sha256,
        'fixture-linux',
        expected.category === 'live' ? [resourceId] : [],
        measurements,
      ),
    )
  }
  for (const requirement of sortedRequirements) {
    const category = ownCategory(requirement)
    const measurements =
      category === 'performance'
        ? [performanceMeasurement(requirement)]
        : [{ kind: 'scalar', name: 'result', unit: 'count', value: 1 }]
    const definition = requirements.get(requirement)
    checks.push(
      await makeRequirementCheck(
        root,
        artifacts,
        privateKey,
        definition,
        category,
        commandForCategory(category),
        packageProof.sha256,
        'fixture-linux',
        category === 'live' ? [resourceId] : [],
        measurements,
        implementation,
        resourceId,
      ),
    )
  }
  const fixedAssignments = new Map(
    [...REQUIRED_CHECK_REQUIREMENTS].map(([id, requirement]) => [requirement, id]),
  )
  if (fixedAssignments.size !== REQUIRED_CHECKS.size)
    throw new Error('Fixture could not assign every stable check')
  const visualIds = artifacts
    .filter((artifact) => artifact.id.startsWith('visual-'))
    .map((artifact) => artifact.id)
  const mappings = {}
  for (const requirement of sortedRequirements) {
    const mappingChecks = [requirement]
    if (fixedAssignments.has(requirement)) mappingChecks.push(fixedAssignments.get(requirement))
    const mappingArtifacts = [requirement]
    const visualId = visualIds.shift()
    if (visualId) mappingArtifacts.push(visualId)
    const definition = requirements.get(requirement)
    mappings[requirement] = {
      definition: definition.definition,
      definitionDigest: definition.digest,
      checks: mappingChecks,
      artifacts: mappingArtifacts,
    }
  }
  const tarballPath = 'artifacts/verification/w6/fixture-package.tgz'
  return {
    schemaVersion: 1,
    braidVersion: packageJson.version,
    gitCommit: packageProof.gitCommit,
    packageIntegrity: await sha512Integrity(join(root, tarballPath)),
    startedAt,
    finishedAt,
    sourceState: {
      clean: true,
      commit: packageProof.gitCommit,
      treeSha256: packageProof.treeSha256,
      tarballSha256: packageProof.sha256,
      tarballArtifactId: 'package-tarball',
    },
    dependencies: [
      {
        name: 'fixture-dependency',
        version: '1.0.0',
        integrity: FIXTURE_DEPENDENCY_INTEGRITY,
      },
    ],
    environments: [
      {
        id: 'fixture-linux',
        kind: 'ci',
        details: {
          machine: 'fixture-linux-x64',
          os: 'linux',
          node: process.version,
          region: 'local',
          workspace: 'isolated-fixture',
          packageVersions: { [packageJson.name]: packageJson.version },
          resourceIds: [resourceId],
          billableResourceIds: [resourceId],
        },
      },
    ],
    checks,
    requirements: mappings,
    artifacts: [
      {
        id: 'package-tarball',
        path: tarballPath,
        sha256: packageProof.sha256,
        mediaType: 'application/gzip',
      },
      ...artifacts,
    ],
    liveResources: [
      {
        id: resourceId,
        type: 'temporary-repository',
        environment: 'fixture-linux',
        billable: true,
      },
    ],
    cleanup: [{ resourceId, status: 'confirmed', completedAt: finishedAt }],
    signatures: [],
  }
}
