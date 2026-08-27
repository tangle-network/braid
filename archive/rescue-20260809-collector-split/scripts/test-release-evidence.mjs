import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateLiveResources,
  validateRequirementMappings,
} from './release/verification-mappings.mjs'
import {
  exactRequirementCheckCategories,
  REQUIRED_CHECK_REQUIREMENTS,
  REQUIRED_CHECKS,
  releaseCheckEntry,
} from './release-check-catalog.mjs'
import {
  REQUIRED_PERFORMANCE_TARGETS,
  signCheck,
  strictIsoTimestamp,
  validateMeasurements,
  validatePerformanceMatrix,
  validatePerformanceMeasurements,
  validateReleaseInputEnvelope,
  verifyCheckReceipt,
} from './release-evidence.mjs'
import {
  containedArtifactPath,
  containedOutputPath,
  readRegularFileNoFollow,
  writeExclusiveAtomic,
} from './release-files.mjs'

function rejects(action, pattern) {
  try {
    action()
  } catch (error) {
    if (pattern.test(String(error))) return
    throw error
  }
  throw new Error(`Expected rejection matching ${pattern}`)
}

async function rejectsAsync(action, pattern) {
  try {
    await action()
  } catch (error) {
    if (pattern.test(String(error))) return
    throw error
  }
  throw new Error(`Expected async rejection matching ${pattern}`)
}

function ownerMappingFixture() {
  const requirements = new Set([...REQUIRED_CHECK_REQUIREMENTS.values(), 'AN-01'])
  const checks = new Map()
  for (const [id, entry] of REQUIRED_CHECKS) {
    checks.set(id, {
      id,
      category: entry.category,
      stdout: { artifactId: `${id}-stdout` },
      stderr: { artifactId: `${id}-stderr` },
    })
  }
  const mappings = new Map()
  for (const requirement of requirements) {
    const checkIds = [...REQUIRED_CHECK_REQUIREMENTS]
      .filter(([, owner]) => owner === requirement)
      .map(([id]) => id)
    if (exactRequirementCheckCategories(requirement)) {
      const entry = releaseCheckEntry(requirement)
      checks.set(requirement, {
        id: requirement,
        category: entry.category,
        stdout: { artifactId: `${requirement}-stdout` },
        stderr: { artifactId: `${requirement}-stderr` },
      })
      checkIds.unshift(requirement)
    }
    if (checkIds.length === 0) checkIds.push('unit')
    mappings.set(requirement, {
      checks: checkIds,
      artifacts: [`mapping-${requirement}`],
    })
  }
  const artifacts = new Map([['package-tarball', {}]])
  for (const check of checks.values()) {
    artifacts.set(check.stdout.artifactId, {})
    artifacts.set(check.stderr.artifactId, {})
  }
  for (const mapping of mappings.values()) artifacts.set(mapping.artifacts[0], {})
  return {
    requirements,
    mappings,
    checks,
    artifacts,
    tarballArtifactId: 'package-tarball',
  }
}

function validContext() {
  const releaseWindow = {
    startedAt: '2026-08-09T00:00:00.000Z',
    finishedAt: '2026-08-09T01:00:00.000Z',
  }
  const environment = {
    id: 'env-ci',
    kind: 'child-process',
    details: {
      schemaVersion: 1,
      cwd: '/release',
      argv: ['pnpm', 'test:live:bridge'],
      environment: {},
      boundary: {},
      machine: 'x86_64',
      os: 'linux',
      node: 'v24.13.0',
      region: 'ci-1',
      workspace: 'isolated-release',
      packageVersions: {
        '@tangle-network/braid': '0.1.0',
        'provider-sdk': '1.2.3',
      },
      resourceIds: ['bridge-1'],
      billableResourceIds: ['bridge-1'],
    },
  }
  const resource = {
    id: 'bridge-1',
    type: 'temporary-runner',
    environment: environment.id,
    billable: true,
  }
  return {
    evidence: {
      liveResources: [resource],
      cleanup: [
        {
          resourceId: resource.id,
          status: 'confirmed',
          completedAt: '2026-08-09T00:30:00.000Z',
        },
      ],
    },
    environments: new Map([[environment.id, environment]]),
    checks: new Map([
      [
        'live-bridge',
        {
          id: 'live-bridge',
          category: 'live',
          result: 'passed',
          environment: environment.id,
          resources: [resource.id],
        },
      ],
    ]),
    packageJson: { name: '@tangle-network/braid', version: '0.1.0' },
    dependencies: [{ name: 'provider-sdk', version: '1.2.3' }],
    releaseWindow,
  }
}

validateRequirementMappings(ownerMappingFixture())
const reassignedCheck = ownerMappingFixture()
reassignedCheck.mappings.get('AR-03').checks = ['rpc']
rejects(
  () => validateRequirementMappings(reassignedCheck),
  /Fixed check unit is not assigned to AR-03/u,
)

validateLiveResources(validContext())
const missingPackageVersion = validContext()
delete missingPackageVersion.environments.get('env-ci').details.packageVersions[
  '@tangle-network/braid'
]
rejects(() => validateLiveResources(missingPackageVersion), /package version differs/u)
const omittedResource = validContext()
omittedResource.environments.get('env-ci').details.resourceIds = []
omittedResource.environments.get('env-ci').details.billableResourceIds = []
rejects(() => validateLiveResources(omittedResource), /omitted from its environment inventory/u)
const missingBillableInventory = validContext()
missingBillableInventory.environments.get('env-ci').details.billableResourceIds = []
rejects(
  () => validateLiveResources(missingBillableInventory),
  /Billable resource bridge-1 is not declared/u,
)
const unconfirmedCleanup = validContext()
unconfirmedCleanup.evidence.cleanup[0].status = 'pending'
rejects(() => validateLiveResources(unconfirmedCleanup), /cleanup is unresolved/u)
const staleCleanup = validContext()
staleCleanup.evidence.cleanup[0].completedAt = '2026-08-08T23:59:59.999Z'
rejects(() => validateLiveResources(staleCleanup), /outside the release/u)
const missingCheckResource = validContext()
missingCheckResource.checks.get('live-bridge').resources = []
rejects(() => validateLiveResources(missingCheckResource), /has no resources/u)

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const check = signCheck(
  {
    id: 'unit',
    category: 'unit',
    required: true,
    command: 'pnpm test:unit',
    cwd: '.',
    environment: 'local-linux',
    startedAt: '2026-08-02T07:00:00.000Z',
    completedAt: '2026-08-02T07:00:01.000Z',
    durationMs: 1000,
    attempt: 1,
    exitCode: 0,
    result: 'passed',
    buildSha256: 'a'.repeat(64),
    measurements: [{ kind: 'scalar', name: 'tests', unit: 'count', value: 61 }],
    stdout: { artifactId: 'unit-stdout', sha256: 'b'.repeat(64) },
    stderr: { artifactId: 'unit-stderr', sha256: 'c'.repeat(64) },
    failureDetails: null,
  },
  privateKey,
)
verifyCheckReceipt(check, publicKey)
rejects(() => verifyCheckReceipt({ ...check, exitCode: 1 }, publicKey), /payload changed/u)
strictIsoTimestamp(check.startedAt, 'start')
rejects(() => strictIsoTimestamp(0, 'start'), /canonical UTC/u)
rejects(() => strictIsoTimestamp('2026-08-02', 'start'), /canonical UTC/u)
validateMeasurements(check.measurements, 'check')
rejects(
  () =>
    validateMeasurements(
      [
        {
          kind: 'distribution',
          name: 'latency',
          unit: 'ms',
          n: 2,
          minimum: 1,
          median: 2,
          p90: 3,
          p95: 4,
          p99: 5,
          maximum: 'fabricated',
        },
      ],
      'check',
      true,
    ),
  /finite number/u,
)
const performanceMeasurement = {
  kind: 'distribution',
  name: 'PERF-01',
  unit: 'ms',
  n: 20,
  minimum: 10,
  median: 20,
  p90: 30,
  p95: 40,
  p99: 45,
  maximum: 50,
  target: REQUIRED_PERFORMANCE_TARGETS['PERF-01'],
  environment: {
    machine: 'dedicated-linux-x64',
    os: 'linux',
    node: '22.19.0',
    terminal: 'xterm-256color',
    dimensions: '80x24',
    database: 'warm-empty',
    eventCount: 0,
  },
  state: 'warm',
  repetitions: 20,
}
validatePerformanceMeasurements([performanceMeasurement], 'performance')
validatePerformanceMatrix(
  Array.from({ length: 10 }, (_, index) => {
    const name = `PERF-${String(index + 1).padStart(2, '0')}`
    return {
      ...performanceMeasurement,
      name,
      target: REQUIRED_PERFORMANCE_TARGETS[name],
      ...(name === 'PERF-08'
        ? {
            unit: '% cpu',
            minimum: 0.1,
            median: 0.5,
            p90: 0.7,
            p95: 0.8,
            p99: 0.9,
            maximum: 1,
          }
        : {}),
    }
  }),
  'performance matrix',
)
rejects(
  () =>
    validatePerformanceMeasurements(
      [{ ...performanceMeasurement, n: 1, repetitions: 1 }],
      'performance',
    ),
  /n=1/u,
)
rejects(
  () =>
    validatePerformanceMeasurements(
      [{ ...performanceMeasurement, target: { ...performanceMeasurement.target, value: 1 } }],
      'performance',
    ),
  /target differs from the required target/u,
)
rejects(
  () =>
    validatePerformanceMeasurements(
      [{ ...performanceMeasurement, kind: 'unavailable', reason: 'not implemented' }],
      'performance',
    ),
  /requires distributions/u,
)
const docsShapedEvidence = {
  schemaVersion: 1,
  braidVersion: '0.1.0',
  gitCommit: 'd'.repeat(40),
  packageIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
  startedAt: '2026-08-02T07:00:00.000Z',
  finishedAt: '2026-08-02T07:00:01.000Z',
  sourceState: {
    clean: true,
    commit: 'd'.repeat(40),
    treeSha256: 'f'.repeat(40),
    tarballSha256: 'e'.repeat(64),
    tarballArtifactId: 'package-tarball',
  },
  dependencies: [],
  environments: [],
  checks: [],
  requirements: {},
  artifacts: [],
  liveResources: [],
  cleanup: [],
  signatures: [],
}
validateReleaseInputEnvelope(docsShapedEvidence)
rejects(
  () => validateReleaseInputEnvelope({ ...docsShapedEvidence, requirements: [] }),
  /Requirement mappings/u,
)

const hostileRoot = await mkdtemp(join(tmpdir(), 'braid-release-evidence-'))
try {
  await writeFile(join(hostileRoot, 'safe.txt'), 'safe')
  if ((await readRegularFileNoFollow(join(hostileRoot, 'safe.txt'))).toString() !== 'safe')
    throw new Error('Safe release read changed its content')
  await rejectsAsync(
    () => containedArtifactPath(hostileRoot, '../outside.txt'),
    /leaves (?:repository|release root)/u,
  )
  await symlink(join(hostileRoot, 'safe.txt'), join(hostileRoot, 'link.txt'))
  await rejectsAsync(() => containedArtifactPath(hostileRoot, 'link.txt'), /symlink/iu)
  await rejectsAsync(
    () => containedOutputPath(hostileRoot, '../outside'),
    /leaves (?:repository|release root)/iu,
  )
  await rejectsAsync(() => readRegularFileNoFollow(join(hostileRoot, 'link.txt')), /non-symlink/iu)
  const target = join(hostileRoot, 'target.txt')
  await writeFile(target, 'original')
  await rejectsAsync(() => writeExclusiveAtomic(target, 'overwrite'), /EEXIST|exist/u)
  if ((await readFile(target)).toString() !== 'original')
    throw new Error('Release output was overwritten')
  const outputLink = join(hostileRoot, 'output-link.txt')
  await symlink(target, outputLink)
  await rejectsAsync(() => writeExclusiveAtomic(outputLink, 'overwrite'), /EEXIST|exist/u)
  if ((await readFile(target)).toString() !== 'original')
    throw new Error('Symlink release output was overwritten')
} finally {
  await rm(hostileRoot, { recursive: true, force: true })
}
let verifierOutput = ''
try {
  execFileSync(process.execPath, ['scripts/verify-release.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BRAID_RELEASE_CHECKOUT: process.cwd(),
      BRAID_RELEASE_ARTIFACT_ROOT: hostileRoot,
      BRAID_RELEASE_ISOLATED_CHECKOUT: '0',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
} catch (error) {
  verifierOutput = String(error)
}
if (!/untracked|isolated|clean/iu.test(verifierOutput))
  throw new Error('verify-release did not reject the current non-clean checkout')
process.stdout.write('Release evidence contract self-test passed.\n')
