import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  signCheck,
  strictIsoTimestamp,
  validateMeasurements,
  validatePerformanceMatrix,
  validatePerformanceMeasurements,
  REQUIRED_PERFORMANCE_TARGETS,
  validateReleaseInputEnvelope,
  verifyCheckReceipt,
} from './release-evidence.mjs'
import {
  containedArtifactPath,
  containedOutputPath,
  readRegularFileNoFollow,
  writeExclusiveAtomic,
} from './release-files.mjs'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      BRAID_RELEASE_ISOLATED_CHECKOUT: '1',
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
