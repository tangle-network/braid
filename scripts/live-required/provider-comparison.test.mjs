import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  assertComparisonAttempt,
  captureComparisonAttempt,
  collectProviderComparison,
  COMPARISON_PLAN_SCHEMA,
  comparisonDigest,
  observedMeasurement,
  providerComparisonReport,
  unavailableMeasurement,
} from './provider-comparison.mjs'
import { captureTangleComparison, prepareTangleComparison } from './tangle-comparison.mjs'

const digest = `sha256:${'a'.repeat(64)}`
const runFile = promisify(execFile)

function plan(samples = 2) {
  return {
    schema: COMPARISON_PLAN_SCHEMA,
    id: 'deterministic-comparison-test',
    createdAt: '2026-10-11T00:00:00.000Z',
    targetProvider: 'tangle',
    minimumSamples: 20,
    cohort: {
      cpu: 2,
      memoryMb: 4096,
      diskMb: 10240,
      region: 'us-west',
      model: 'test-model',
      modelProvider: 'test-provider',
      runner: 'pi',
      runnerVersion: '1.0.0',
      imageDigest: digest,
      taskDigest: digest,
      profileDigest: digest,
      binaryDigest: digest,
      concurrency: 1,
      startMode: 'cold',
      retentionMs: 3600000,
    },
    attempts: ['tangle', 'daytona', 'e2b'].flatMap((provider) => Array.from({ length: samples }, (_, index) => ({ id: `${provider}-${index}`, provider }))),
  }
}

// These fixtures test accounting and verdicts. They make no live integration claim.
function attempt(frozen, id, { status = 'passed', cost = 1, latency = 100, setup = 100, manual = 1, persistence = true } = {}) {
  const provider = frozen.attempts.find((cell) => cell.id === id).provider
  const proof = {
    origin: 'deterministic-test-fixture',
    status,
    actual: { ...frozen.cohort },
    costs: Object.fromEntries(['compute', 'storage', 'egress', 'model', 'other'].map((component) => [component, { status: 'settled', usd: component === 'compute' ? cost : 0, currency: 'USD', scope: 'owned-attempt', provider, attemptId: id, component, receiptId: `${id}-${component}` }])),
    timing: { createMs: latency, firstUsefulOutputMs: latency * 2 },
    persistence: { processRestart: persistence, context: persistence, trackedFiles: persistence, untrackedFiles: persistence },
    ease: { setupMs: setup, manualSteps: manual },
    cleanup: { exactOwnedResourcesRemoved: true },
  }
  const measurements = Object.fromEntries(Object.entries(proof).filter(([, value]) => value !== null && typeof value === 'object').map(([group, fields]) => [group, Object.fromEntries(Object.entries(fields).map(([field, value]) => [field, group === 'costs' ? observedMeasurement(value.usd, [group, field, 'usd']) : observedMeasurement(value, [group, field])]))]))
  return captureComparisonAttempt({ plan: frozen, id, proof, startedAt: '2026-10-11T00:00:01.000Z', completedAt: '2026-10-11T01:00:01.000Z', measurements })
}

test('comparison retains planned, failed, unavailable and unstarted denominators and charges', () => {
  const frozen = plan(3)
  const failed = attempt(frozen, 'tangle-1', { status: 'failed', cost: 5 })
  failed.measurements.costs.storage = unavailableMeasurement('invoice-pending')
  const report = providerComparisonReport(frozen, [attempt(frozen, 'tangle-0'), failed, attempt(frozen, 'daytona-0', { status: 'unavailable' })])
  const target = report.providers[0]
  assert.deepEqual(target.outcomes, { requested: 3, attempted: 2, passed: 1, failed: 1, unavailable: 0, notStarted: 1 })
  assert.equal(target.costs.totalUsd, null)
  assert.equal(target.costs.usdPerSuccessfulAttempt, null)
  assert.equal(target.costs.knownComponentUsd, 6)
  assert.equal(target.costs.components.compute.observedUsd, 6)
  assert.equal(target.costs.total.unavailable, 1)
  assert.equal(target.timing.createMs.observed, 2)
  assert.equal(target.timing.createMs.notStarted, 1)
  assert.equal(report.providers[2].outcomes.notStarted, 3)
  assert.equal(report.status, 'unproved')
})

test('partial cohort and unknown allocation remain explicit incomparable cells', () => {
  const frozen = plan()
  const unknown = attempt(frozen, 'tangle-0')
  unknown.measurements.actual.cpu = unavailableMeasurement()
  const unequal = attempt(frozen, 'tangle-1')
  unequal.proof.actual.region = 'eu-west'
  unequal.proofDigest = comparisonDigest(unequal.proof)
  unequal.measurements.actual.region.value = 'eu-west'
  const report = providerComparisonReport(frozen, [unknown, unequal])
  assert.deepEqual(report.providers[0].cells[0].unknown, ['cpu'])
  assert.deepEqual(report.providers[0].cells[1].mismatches, ['region'])
  assert.equal(report.comparisons[0].limits.includes('unverified-or-unequal-cohort'), true)
  assert.equal(report.status, 'unproved')
})

test('estimates, shared billing totals and a default zero cannot establish paid cost', () => {
  const frozen = plan()
  for (const patch of [{ status: 'estimated' }, { scope: 'account-wide' }, { component: 'model' }, { attemptId: 'other' }, { provider: 'other' }]) {
    const value = attempt(frozen, 'tangle-0', { cost: 0 })
    Object.assign(value.proof.costs.compute, patch)
    value.proofDigest = comparisonDigest(value.proof)
    assert.throws(() => assertComparisonAttempt(frozen, value), /settled provider charge receipt/)
  }
  const zero = attempt(frozen, 'tangle-0', { cost: 0 })
  assert.equal(assertComparisonAttempt(frozen, zero).measurements.costs.compute.value, 0)
})

test('restart collection is idempotent and rejects conflicting or retroactive evidence', () => {
  const frozen = plan()
  const value = attempt(frozen, 'tangle-0')
  assert.equal(providerComparisonReport(frozen, [value, structuredClone(value)]).attempted, 1)
  const conflict = attempt(frozen, 'tangle-0', { cost: 2 })
  assert.throws(() => providerComparisonReport(frozen, [value, conflict]), /Conflicting duplicate/)
  const mutated = structuredClone(value)
  mutated.proof.actual.cpu = 99
  assert.throws(() => assertComparisonAttempt(frozen, mutated), /immutable proof/)
  const invented = structuredClone(value)
  invented.measurements.timing.createMs.value = 1
  assert.throws(() => assertComparisonAttempt(frozen, invented), /proof source/)
  const retroactive = structuredClone(value)
  retroactive.startedAt = '2026-10-10T00:00:00Z'
  assert.throws(() => assertComparisonAttempt(frozen, retroactive), /precede execution/)
  const differentPlan = structuredClone(frozen)
  differentPlan.cohort.cpu = 4
  assert.throws(() => assertComparisonAttempt(differentPlan, value), /plan digest changed/)
})

test('leadership requires every declared competitor and every dimension to be ahead', () => {
  const frozen = plan(20)
  const attempts = frozen.attempts.map((cell) => attempt(frozen, cell.id, cell.provider === 'tangle' ? { cost: 1, latency: 10, setup: 10, manual: 0 } : { cost: 2, latency: 20, setup: 20, manual: 1, persistence: false }))
  const report = providerComparisonReport(frozen, attempts)
  assert.equal(report.status, 'passed')
  assert.equal(report.comparisons.length, 2)
  assert.deepEqual(report.comparisons[0].dimensions, { cost: 'ahead', latency: 'ahead', persistence: 'ahead', ease: 'ahead' })
  assert.equal(report.providers[0].timing.createMs.p95, 10)
  attempts.find((record) => record.provider === 'e2b').measurements.costs.model = unavailableMeasurement()
  assert.equal(providerComparisonReport(frozen, attempts).status, 'unproved')
  const ties = frozen.attempts.map((cell) => attempt(frozen, cell.id))
  assert.equal(providerComparisonReport(frozen, ties).comparisons[0].dimensions.persistence, 'tied')
  assert.equal(providerComparisonReport(frozen, ties).status, 'unproved')
})

test('small samples are reported with their p95 and cannot pass the declared minimum', () => {
  const frozen = plan(2)
  const records = frozen.attempts.map((cell) => attempt(frozen, cell.id, { latency: cell.id.endsWith('0') ? 10 : 100 }))
  const report = providerComparisonReport(frozen, records)
  assert.equal(report.providers[0].timing.createMs.p50, 10)
  assert.equal(report.providers[0].timing.createMs.p95, 100)
  assert.equal(report.comparisons[0].limits.includes('below-declared-minimum-samples'), true)
  assert.equal(report.status, 'unproved')
})

test('Tangle producer freezes its plan before calls and cannot relabel transcript continuity or model cost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-comparison-'))
  try {
    const frozen = plan()
    const planPath = join(directory, 'plan.json')
    const recordsPath = join(directory, 'records.json')
    await writeFile(planPath, JSON.stringify(frozen))
    const environment = { BRAID_LIVE_PROVIDER_PLAN: planPath, BRAID_LIVE_PROVIDER_RECORDS: recordsPath }
    await assert.rejects(prepareTangleComparison(environment, 3, 1), /predeclared comparison plan/)
    const comparison = await prepareTangleComparison(environment, 2, 1)
    const retained = JSON.parse(await readFile(recordsPath, 'utf8'))
    assert.equal(retained.planDigest, comparisonDigest(frozen))
    assert.deepEqual(retained.comparableAttempts, [])
    const captures = captureTangleComparison(comparison, [{ index: 0, startedAt: '2026-10-11T00:00:01Z', completedAt: '2026-10-11T00:00:02Z', proof: { status: 'failed', config: { model: 'test-model', runner: 'pi' }, cleanup: { exactResource: false }, spend: { totals: { cost: { usd: 0 } } }, workspaceVerification: { continuity: { matched: true } } } }])
    assert.equal(captures[0].measurements.costs.compute.status, 'unavailable')
    assert.equal(captures[0].measurements.costs.model.status, 'unavailable')
    assert.equal(captures[0].measurements.persistence.context.status, 'unavailable')
    assert.equal(captures[0].measurements.persistence.processRestart.status, 'unavailable')
    assert.equal(captures[0].measurements.persistence.untrackedFiles.status, 'unavailable')
    assert.equal(captures[0].measurements.actual.model.value, 'test-model')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('existing live-tangle comparison command emits a retained report without a release pass marker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'braid-comparison-cli-'))
  try {
    const frozen = plan()
    const planPath = join(directory, 'plan.json')
    const attemptPath = join(directory, 'attempt.json')
    const outputPath = join(directory, 'report.json')
    await writeFile(planPath, JSON.stringify(frozen))
    await writeFile(attemptPath, JSON.stringify(attempt(frozen, 'tangle-0')))
    const report = await collectProviderComparison({ planPath, attemptPaths: [attemptPath], outputPath })
    assert.equal(report.attempted, 1)
    await assert.rejects(runFile(process.execPath, ['scripts/live-required.mjs', 'live-tangle', '--comparison', planPath, '--attempt', attemptPath, '--output', outputPath]), (error) => {
      assert.equal(error.code, 2)
      assert.equal(error.stdout.includes('BRAID_RELEASE_RESULT_JSON'), false)
      assert.equal(JSON.parse(error.stdout).requested, 6)
      return true
    })
    assert.equal(JSON.parse(await readFile(outputPath, 'utf8')).status, 'unproved')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
