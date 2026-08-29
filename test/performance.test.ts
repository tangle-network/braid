import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  ApplicationUiController,
  buildBraidViewModel,
} from '../src/adapters/tui/application-ui-controller.js'
import { uiSemanticState } from '../src/adapters/tui/ui-semantic-state.js'
import type { BraidApplication } from '../src/app/application.js'
import type { SupervisorRecord, WorkerRecord } from '../src/domain/entities.js'
import { createSupervisorId, createWorkerId } from '../src/domain/ids-values.js'
import { type BraidState, initialState } from '../src/domain/state.js'
import { sanitizeTerminalText } from '../src/views/shared/sanitize.js'
import { queryActivity } from '../src/views/shared/semantic-activity.js'
import { layoutFor } from '../src/views/tui/layout.js'

// @ts-expect-error The performance report helpers are JavaScript release entry points.
const statistics = await import('../scripts/performance/statistics.mjs')
// @ts-expect-error The performance probe is a JavaScript release entry point.
const applicationProbe = await import('../scripts/performance/application-probe.mjs')
// @ts-expect-error The performance lifecycle is a JavaScript release entry point.
const lifecycleModule = await import('../scripts/performance/lifecycle.mjs')
// @ts-expect-error The performance probe is a JavaScript release entry point.
const resizeProbe = await import('../scripts/performance/resize-probe.mjs')
// @ts-expect-error The performance reporting helpers are JavaScript release entry points.
const reporting = await import('../scripts/performance/reporting.mjs')
// @ts-expect-error The performance stage helper is a JavaScript release entry point.
const stageTimings = await import('../scripts/performance/stage-timings.mjs')
// @ts-expect-error The performance storage helpers are JavaScript release entry points.
const storageProbes = await import('../scripts/performance/storage-probes.mjs')
const {
  assertFullDuration,
  createPerformanceMeasurement,
  observation,
  releaseMeasurement,
  summarizeSamples,
} = statistics
const { evaluateRuntimeEventRate, visibleRuntimeEventSequences } = applicationProbe
const { createPerformanceLifecycle } = lifecycleModule
const { evaluateResizeStreamRate, scheduledProducerDelay } = resizeProbe
const { assertSmokeMeasurements } = reporting
const { summarizeStage } = stageTimings
const { prepareHeadlessProductionProcessFixture } = storageProbes

function distribution(samples: readonly number[]) {
  const ordered = [...samples].sort((left, right) => left - right)
  if (ordered.length === 0) throw new Error('performance distribution requires samples')
  const percentile = (fraction: number): number =>
    ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] ?? 0
  return {
    n: ordered.length,
    minimum: ordered[0] as number,
    median: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    p99: percentile(0.99),
    maximum: ordered.at(-1) as number,
  }
}

test('view transform performance records a complete distribution for 20 real repetitions', (t) => {
  const samples: number[] = []
  let total = 0
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const started = performance.now()
    for (let index = 0; index < 10_000; index += 1) {
      total += sanitizeTerminalText(`row ${index} 漢字 é 👩🏽‍💻\u001b[31m`).length
      layoutFor(40 + (index % 161), 12 + (index % 49))
    }
    samples.push(performance.now() - started)
  }
  const measured = distribution(samples)
  assert.ok(total > 0)
  assert.equal(measured.n, 20)
  assert.ok(measured.minimum <= measured.median)
  assert.ok(measured.median <= measured.p90)
  assert.ok(measured.p90 <= measured.p95)
  assert.ok(measured.p95 <= measured.p99)
  assert.ok(measured.p99 <= measured.maximum)
  assert.ok(measured.p95 < 250, `view transforms p95=${measured.p95.toFixed(1)}ms`)
  t.diagnostic(
    JSON.stringify({
      name: 'view-transform-batch',
      unit: 'ms',
      environment: { node: process.version, eventCount: 10_000 },
      ...measured,
    }),
  )
})

test('runtime activity projection stays bounded at 10k and 100k saved workers', (t) => {
  for (const count of [10_000, 100_000]) {
    const state = runtimeWorkerState(count)
    buildBraidViewModel({ ...state, revision: -1 })
    const changedRevision: number[] = []
    for (let repetition = 0; repetition < 10; repetition += 1) {
      const started = performance.now()
      const view = buildBraidViewModel({ ...state, revision: repetition })
      changedRevision.push(performance.now() - started)
      assert.equal(view.activity.length, 500)
      assert.equal(view.graph.length, 2_049)
      assert.equal(view.hiddenGraphNodeCount, count - 2_048)
    }

    const stableState = { ...state, revision: 11 }
    const stableView = buildBraidViewModel(stableState)
    const unchangedRevision: number[] = []
    for (let repetition = 0; repetition < 20; repetition += 1) {
      const started = performance.now()
      assert.equal(buildBraidViewModel(stableState), stableView)
      unchangedRevision.push(performance.now() - started)
    }

    const changed = distribution(changedRevision)
    const unchanged = distribution(unchangedRevision)
    assert.ok(
      changed.p90 < (count === 10_000 ? 250 : 450),
      `${count} worker changed-revision p90=${changed.p90.toFixed(1)}ms`,
    )
    assert.ok(
      unchanged.p90 < 5,
      `${count} worker stable-revision p90=${unchanged.p90.toFixed(1)}ms`,
    )
    t.diagnostic(
      JSON.stringify({
        name: 'runtime-activity-projection',
        unit: 'ms',
        environment: { node: process.version, savedWorkers: count },
        changedRevision: changed,
        unchangedRevision: unchanged,
      }),
    )
  }
})

test('controller renders reuse one state clone and semantic projection per revision', (t) => {
  const source = runtimeWorkerState(10_000)
  let revision = source.revision
  let stateCalls = 0
  let storageFailure: string | undefined
  let cleanupUncertain: string | undefined
  const app = {
    revision: () => revision,
    state: () => {
      stateCalls += 1
      return structuredClone({ ...source, revision })
    },
    canCancel: () => false,
    storageFailure: () => storageFailure,
    cleanupUncertain: () => cleanupUncertain,
    canRespondToInteractions: () => false,
  } as unknown as BraidApplication
  const controller = new ApplicationUiController(app)
  const initial = controller.view()
  const samples: number[] = []
  for (let repetition = 0; repetition < 20; repetition += 1) {
    const started = performance.now()
    assert.equal(controller.view(), initial)
    samples.push(performance.now() - started)
  }
  assert.equal(stateCalls, 1)
  const stable = distribution(samples)
  assert.ok(stable.p90 < 10, `stable controller view p90=${stable.p90.toFixed(1)}ms`)
  t.diagnostic(
    JSON.stringify({
      name: 'controller-view-cache',
      unit: 'ms',
      environment: { node: process.version, savedWorkers: 10_000 },
      viewIdentityReused: true,
      stateCalls,
      ...stable,
    }),
  )

  storageFailure = 'storage unavailable'
  const failed = controller.view()
  assert.notEqual(failed, initial)
  assert.equal(failed.storageFailure, storageFailure)
  assert.equal(stateCalls, 1)

  storageFailure = undefined
  cleanupUncertain = 'cleanup confirmation unavailable'
  const cleanup = controller.view()
  assert.notEqual(cleanup, failed)
  assert.equal(cleanup.cleanupUncertain, cleanupUncertain)
  assert.equal(stateCalls, 1)

  revision += 1
  const changed = controller.view()
  assert.notEqual(changed, cleanup)
  assert.equal(changed.revision, revision)
  assert.equal(stateCalls, 2)
})

test('activity caps keep the newest unsorted worker while headless history stays complete', () => {
  const source = runtimeWorkerState(2_049)
  const newest = source.workers[0]
  assert(newest)
  const state = {
    ...source,
    workers: source.workers.map((worker, index) => ({
      ...worker,
      updatedAt: index === 0 ? '2026-08-09T00:00:01.000Z' : worker.updatedAt,
    })),
  }
  const view = buildBraidViewModel(state)
  assert.equal(view.hiddenGraphNodeCount, 1)
  assert.equal(
    view.graph.some((node) => node.id === newest.id),
    true,
  )
  assert.equal(queryActivity(state).activity.length, 2_050)
})

test('bounded activity matches the exact tail of a scrambled worker history', () => {
  const source = runtimeWorkerState(3_000)
  const state = {
    ...source,
    workers: source.workers.map((worker, index) => ({
      ...worker,
      updatedAt: new Date(Date.UTC(2026, 7, 9, 0, 0, (index * 7_919) % 1_000)).toISOString(),
    })),
  }
  const expected = queryActivity(state)
    .activity.slice(-500)
    .map(({ id }) => id)
  const actual = queryActivity(state, { limit: 500 }).activity.map(({ id }) => id)
  assert.deepEqual(actual, expected)
})

test('bounded terminal graphs retain active work and its ancestry before old history', () => {
  const source = runtimeWorkerState(3_000)
  const workers: WorkerRecord[] = source.workers.map((worker, index) => ({
    ...worker,
    updatedAt: new Date(Date.parse(worker.updatedAt) + index * 1_000).toISOString(),
  }))
  const active = workers[0]
  const parent = workers[1]
  const newest = workers.at(-1)
  const oldCompleted = workers[2]
  assert(active && parent && newest && oldCompleted)
  workers[0] = {
    ...active,
    status: 'running',
    parentWorkerId: parent.id,
  }

  const bounded = uiSemanticState({ ...source, workers })
  const selected = new Set(bounded.state.workers.map((worker) => worker.id))
  assert.equal(selected.has(active.id), true)
  assert.equal(selected.has(parent.id), true)
  assert.equal(selected.has(newest.id), true)
  assert.equal(selected.has(oldCompleted.id), false)
  assert.equal(bounded.state.workers.length, 2_049)
  assert.equal(bounded.hiddenNodeCount, 951)
  assert.deepEqual(
    bounded.state.workers.map((worker) => worker.id),
    workers.filter((worker) => selected.has(worker.id)).map((worker) => worker.id),
  )
})

function runtimeWorkerState(count: number): BraidState {
  const at = '2026-08-09T00:00:00.000Z'
  const supervisorId = createSupervisorId('supervisor-performance')
  const supervisor: SupervisorRecord = {
    id: supervisorId,
    runtimeId: 'runtime-supervisor-performance',
    runtimeRoot: '/workspace',
    status: 'completed',
    title: 'performance supervisor',
    createdAt: at,
    updatedAt: at,
  }
  const workers: WorkerRecord[] = Array.from({ length: count }, (_, index) => ({
    id: createWorkerId(`worker-performance-${index}`),
    runtimeId: `runtime-worker-performance-${index}`,
    supervisorId,
    status: 'completed',
    title: `worker ${index}`,
    createdAt: at,
    updatedAt: at,
  }))
  return {
    ...initialState({ name: 'performance' } as Readonly<AgentProfile>),
    workspace: '/workspace',
    supervisors: [supervisor],
    workers,
  }
}

test('performance statistics preserve the required percentile definition and release shape', () => {
  const distribution = summarizeSamples(
    Array.from({ length: 20 }, (_, index) => index + 1),
    'fixture',
  )
  assert.deepEqual(distribution, {
    n: 20,
    minimum: 1,
    median: 10,
    p90: 18,
    p95: 19,
    p99: 20,
    maximum: 20,
  })
  const measurement = createPerformanceMeasurement({
    name: 'PERF-08',
    samples: [0.2, 0.4, 0.6, 0.8],
    unit: '% of one core',
    state: 'warm',
    repetitions: 4,
    command: 'pnpm run test:performance',
    environment: {
      machine: 'unit-test machine',
      os: 'linux test',
      node: process.version,
      terminal: 'fixture terminal',
      dimensions: '80x24',
      database: 'fixture database',
      eventCount: 0,
    },
    observations: {
      missingEvents: observation(0, 'No events are expected in this idle sample'),
      providerArtifacts: observation(null, 'No provider artifact measurement applies'),
    },
  })
  assert.equal(measurement.passed, true)
  assert.deepEqual(Object.keys(releaseMeasurement(measurement)).sort(), [
    'environment',
    'kind',
    'maximum',
    'median',
    'minimum',
    'n',
    'name',
    'p90',
    'p95',
    'p99',
    'repetitions',
    'state',
    'target',
    'unit',
  ])
})

test('stage timing summaries retain every percentile, total, and mean', () => {
  assert.deepEqual(summarizeStage([4, 1, 3, 2]), {
    n: 4,
    total: 10,
    mean: 2.5,
    minimum: 1,
    median: 2,
    p90: 4,
    p95: 4,
    p99: 4,
    maximum: 4,
  })
})

test('idle CPU proof rejects a short run before it can be reported as complete', () => {
  assert.doesNotThrow(() => assertFullDuration(60_000))
  assert.throws(() => assertFullDuration(59_999), /shorter than 60000ms/u)
})

test('runtime throughput calibration rejects a slow producer plus final render frame', () => {
  const slow = evaluateRuntimeEventRate({ count: 100, elapsedMs: 1_001 })
  assert.ok(slow.achievedEventsPerSecond < 100)
  assert.equal(slow.passed, false)

  const fast = evaluateRuntimeEventRate({ count: 100, elapsedMs: 999 })
  assert.equal(fast.passed, true)
})

test('runtime frame accounting never infers markers skipped by a combined frame', () => {
  assert.deepEqual(
    [...visibleRuntimeEventSequences(['perf-event-00001 x perf-event-00005'])],
    [1, 5],
  )
})

test('PERF-07 rejects an intentionally slow 90 events/s producer and render interval', () => {
  const slow = evaluateResizeStreamRate({
    produced: 900,
    accepted: 900,
    streamElapsedMs: 10_000,
  })
  assert.equal(slow.offeredEventsPerSecond, 90)
  assert.equal(slow.acceptedEventsPerSecond, 90)
  assert.equal(slow.observedEventsPerSecond, 90)
  assert.equal(slow.passed, false)
})

test('PERF-07 producer cadence corrects processing drift without hiding backpressure', () => {
  assert.equal(
    scheduledProducerDelay({
      cadenceStartedAt: 100,
      sequence: 2,
      intervalMs: 8,
      now: 103,
    }),
    5,
  )
  assert.equal(
    scheduledProducerDelay({
      cadenceStartedAt: 100,
      sequence: 2,
      intervalMs: 8,
      now: 110,
    }),
    0,
  )
})

test('smoke validation rejects failed rows without concrete reasons', () => {
  const failed = {
    kind: 'distribution',
    name: 'PERF-06',
    n: 1,
    rawSamples: [3_000],
    passed: false,
    failureReasons: [],
  }
  assert.throws(
    () => assertSmokeMeasurements([failed], ['PERF-06']),
    /failed without a concrete failure reason/u,
  )
  assert.throws(
    () =>
      assertSmokeMeasurements(
        [{ ...failed, failureReasons: ['p95 target was missed'] }],
        ['PERF-06'],
      ),
    /failed its smoke target/u,
  )
})

test('performance interruption aborts new work and awaits cleanup exactly once', async () => {
  const lifecycle = createPerformanceLifecycle()
  const cleanupCounts = { initial: 0, late: 0 }
  lifecycle.addCleanup(async () => {
    cleanupCounts.initial += 1
  })
  lifecycle.abort('test interruption')
  lifecycle.addCleanup(async () => {
    cleanupCounts.late += 1
  })
  assert.throws(() => lifecycle.throwIfAborted(), /Performance run aborted: test interruption/u)
  await Promise.all([lifecycle.close(), lifecycle.close()])
  assert.deepEqual(cleanupCounts, { initial: 1, late: 1 })
})

test('headless production process fixtures are seeded before launch', async () => {
  const calls: string[] = []
  const fixture = {
    eventCount: 10_000,
    async seed() {
      calls.push('seed')
    },
  }
  const prepared = await prepareHeadlessProductionProcessFixture(fixture)
  calls.push('launch')
  assert.deepEqual(calls, ['seed', 'launch'])
  assert.equal(prepared.eventCount, 10_000)
  assert.equal(prepared.processMode, 'isolated-production-pty')
  assert.equal(prepared.database, '10000-event-encrypted-sqlite-headless-production')
})
