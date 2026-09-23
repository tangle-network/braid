import { generateKeyPairSync } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  signCheck,
  strictIsoTimestamp,
  validateMeasurements,
  validateReleaseInputEnvelope,
  verifyCheckReceipt,
  verifyManifestSignature,
} from './release-evidence.mjs'
import {
  REQUIRED_PERFORMANCE_ENVIRONMENTS,
  REQUIRED_PERFORMANCE_TARGETS,
  validatePerformanceMatrix,
  validatePerformanceMeasurements,
} from './release-performance.mjs'
import { parseJson } from './release-json.mjs'
import { createReleaseFixture, disposeFixture } from './release-test-fixture.mjs'
import { runMutations } from './release-test-mutations.mjs'

function rejects(action, pattern) {
  try {
    action()
  } catch (error) {
    if (pattern.test(String(error))) return
    throw error
  }
  throw new Error(`Expected rejection matching ${pattern}`)
}

function performanceMeasurement(name) {
  const target = REQUIRED_PERFORMANCE_TARGETS[name]
  const requiredEnvironment = REQUIRED_PERFORMANCE_ENVIRONMENTS[name]
  const value = target.value / 2
  const values = [value / 4, value / 3, value / 2, value * 0.75, value]
  return {
    kind: 'distribution',
    name,
    unit: target.unit,
    n: 20,
    minimum: values[0],
    median: values[1],
    p90: values[2],
    p95: values[3],
    p99: values[4],
    maximum: values[4],
    target,
    environment: {
      machine: 'dedicated-linux-x64',
      os: 'linux',
      node: '22.19.0',
      terminal: 'xterm-256color',
      dimensions: '80x24',
      database: requiredEnvironment.database,
      eventCount: requiredEnvironment.eventCount,
    },
    state: requiredEnvironment.state,
    repetitions: 20,
  }
}

function runNarrowContractTests() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const check = signCheck(
    {
      id: 'unit',
      category: 'unit',
      required: true,
      command: 'pnpm test:unit',
      cwd: '.',
      environment: 'local-linux',
      resources: [],
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
            maximum: 'bad',
          },
        ],
        'check',
        true,
      ),
    /finite number/u,
  )

  const onePerformanceMeasurement = performanceMeasurement('PERF-01')
  validatePerformanceMeasurements([onePerformanceMeasurement], 'performance')
  validatePerformanceMatrix(
    Object.keys(REQUIRED_PERFORMANCE_TARGETS).map((name) => performanceMeasurement(name)),
    'performance matrix',
  )
  rejects(
    () =>
      validatePerformanceMeasurements(
        [{ ...onePerformanceMeasurement, n: 1, repetitions: 1 }],
        'performance',
      ),
    /invalid n/u,
  )
  rejects(
    () =>
      validatePerformanceMeasurements(
        [
          {
            ...onePerformanceMeasurement,
            target: { ...onePerformanceMeasurement.target, value: 1 },
          },
        ],
        'performance',
      ),
    /target differs/u,
  )
  rejects(
    () =>
      validatePerformanceMeasurements(
        [{ ...onePerformanceMeasurement, kind: 'unavailable', reason: 'not implemented' }],
        'performance',
      ),
    /requires distributions/u,
  )

  const envelope = {
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
  validateReleaseInputEnvelope(envelope)
  rejects(
    () => validateReleaseInputEnvelope({ ...envelope, requirements: [] }),
    /Requirement mappings/u,
  )
  const nonIsolated = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BRAID_RELEASE_CHECKOUT: process.cwd(),
      BRAID_RELEASE_ISOLATED_CHECKOUT: '0',
    },
    encoding: 'utf8',
  })
  if (
    nonIsolated.status === 0 ||
    !/requires BRAID_RELEASE_ISOLATED_CHECKOUT=1/iu.test(
      `${nonIsolated.stdout}${nonIsolated.stderr}`,
    )
  )
    throw new Error('verify-release accepted a non-isolated checkout')
}

async function runIntegration() {
  const fixture = await createReleaseFixture(process.cwd())
  try {
    const result = spawnSync(process.execPath, ['scripts/verify-release.mjs'], {
      cwd: fixture.root,
      env: {
        ...process.env,
        BRAID_RELEASE_ISOLATED_CHECKOUT: '1',
        BRAID_RELEASE_SIGNING_KEY_PATH: fixture.keyPath,
      },
      encoding: 'utf8',
      timeout: 120000,
    })
    if (result.status !== 0) throw new Error('Valid isolated release fixture was rejected')
    const manifest = parseJson(
      (await readFile(join(fixture.root, 'artifacts/verification/0.1.0/manifest.json'))).toString(
        'utf8',
      ),
      'Generated release manifest',
    )
    const report = (
      await readFile(join(fixture.root, 'artifacts/verification/0.1.0/report.md'))
    ).toString('utf8')
    verifyManifestSignature(manifest, fixture.publicKey)
    if (Object.keys(manifest.requirements).length !== 154)
      throw new Error('Generated manifest does not contain 154 requirements')
    if (manifest.checks.length !== 171)
      throw new Error('Generated manifest does not contain all signed checks')
    if (manifest.artifacts.length !== 545)
      throw new Error('Generated release manifest does not contain all fixture artifacts')
    if (
      !report.includes('Checks: 171/171 passed.') ||
      !report.includes('Requirements: 154/154 linked.')
    )
      throw new Error('Generated release report is incomplete')
    const mutations = await runMutations(fixture, manifest)
    process.stdout.write(
      `Release evidence integration passed: valid=1, mutations=${mutations.attempts}, rejected=${mutations.rejected}, failed=${mutations.failed}, skipped=${mutations.skipped}, requirements=154, prefixes=15.\n`,
    )
  } finally {
    await disposeFixture(fixture)
  }
}

runNarrowContractTests()
await runIntegration()
process.stdout.write('Release evidence contract self-test passed.\n')
