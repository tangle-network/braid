import { canonicalJson } from './release-json.mjs'
import { assert, assertExactKeys, finiteNumber } from './release-evidence.mjs'

const PERFORMANCE_PERCENTILES = new Set(['minimum', 'median', 'p90', 'p95', 'p99', 'maximum'])

export const REQUIRED_PERFORMANCE_IDS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => `PERF-${String(index + 1).padStart(2, '0')}`),
)

export const REQUIRED_PERFORMANCE_TARGETS = Object.freeze({
  'PERF-01': Object.freeze({
    metric: 'process-start-to-first-visible-frame',
    percentile: 'p95',
    operator: '<=',
    value: 250,
    unit: 'ms',
    workload: 'warm-database-20-runs',
  }),
  'PERF-02': Object.freeze({
    metric: 'process-start-to-first-visible-frame',
    percentile: 'p95',
    operator: '<=',
    value: 1_000,
    unit: 'ms',
    workload: 'cold-100000-event-database-20-runs',
  }),
  'PERF-03': Object.freeze({
    metric: 'idle-key-to-updated-frame',
    percentile: 'p95',
    operator: '<=',
    value: 50,
    unit: 'ms',
    workload: 'idle-1000-keys',
  }),
  'PERF-04': Object.freeze({
    metric: 'runtime-event-to-updated-frame',
    percentile: 'p95',
    operator: '<=',
    value: 50,
    unit: 'ms',
    workload: '100-events-per-second-10000-events-zero-loss',
  }),
  'PERF-05': Object.freeze({
    metric: 'replay-reduce-10000-events',
    percentile: 'p95',
    operator: '<=',
    value: 2_000,
    unit: 'ms',
    workload: 'replay-reduce-10000-events',
  }),
  'PERF-06': Object.freeze({
    metric: 'open-100000-event-conversation',
    percentile: 'p95',
    operator: '<=',
    value: 2_000,
    unit: 'ms',
    workload: 'open-100000-event-conversation',
  }),
  'PERF-07': Object.freeze({
    metric: 'resize-during-stream-frame',
    percentile: 'p95',
    operator: '<=',
    value: 100,
    unit: 'ms',
    workload: '100-events-per-second-1000-resizes-zero-invalid-cells',
  }),
  'PERF-08': Object.freeze({
    metric: 'idle-cpu',
    percentile: 'median',
    operator: '<=',
    value: 1,
    unit: '% cpu',
    workload: 'idle-60-seconds',
  }),
  'PERF-09': Object.freeze({
    metric: 'resident-memory-10000-event-conversation',
    percentile: 'p95',
    operator: '<=',
    value: 150,
    unit: 'MiB',
    workload: 'resident-memory-10000-event-conversation',
  }),
  'PERF-10': Object.freeze({
    metric: 'database-growth-10000-events',
    percentile: 'maximum',
    operator: '<=',
    value: 50,
    unit: 'MiB',
    workload: 'database-growth-10000-events',
  }),
})

export const REQUIRED_PERFORMANCE_ENVIRONMENTS = Object.freeze({
  'PERF-01': Object.freeze({ state: 'warm', database: 'warm', eventCount: 0 }),
  'PERF-02': Object.freeze({ state: 'cold', database: 'cold-100000-events', eventCount: 100_000 }),
  'PERF-03': Object.freeze({ state: 'warm', database: 'idle', eventCount: 1_000 }),
  'PERF-04': Object.freeze({ state: 'warm', database: 'stream', eventCount: 10_000 }),
  'PERF-05': Object.freeze({ state: 'warm', database: 'replay', eventCount: 10_000 }),
  'PERF-06': Object.freeze({ state: 'warm', database: 'conversation', eventCount: 100_000 }),
  'PERF-07': Object.freeze({ state: 'warm', database: 'stream-resize', eventCount: 1_000 }),
  'PERF-08': Object.freeze({ state: 'warm', database: 'idle', eventCount: 60 }),
  'PERF-09': Object.freeze({ state: 'warm', database: 'conversation', eventCount: 10_000 }),
  'PERF-10': Object.freeze({ state: 'warm', database: 'growth', eventCount: 10_000 }),
})

function validatePerformanceTarget(name, target, label) {
  assertExactKeys(
    target,
    ['metric', 'percentile', 'operator', 'value', 'unit', 'workload'],
    [],
    `${label} target`,
  )
  assert(
    typeof target.metric === 'string' && target.metric.length > 0,
    `${label} target has no metric`,
  )
  assert(PERFORMANCE_PERCENTILES.has(target.percentile), `${label} target has no valid percentile`)
  assert(['<', '<=', '>', '>='].includes(target.operator), `${label} target has no valid operator`)
  finiteNumber(target.value, `${label} target value`)
  assert(typeof target.unit === 'string' && target.unit.length > 0, `${label} target has no unit`)
  assert(
    typeof target.workload === 'string' && target.workload.length > 0,
    `${label} target has no workload`,
  )
  const required = REQUIRED_PERFORMANCE_TARGETS[name]
  assert(required, `${label} has no required target definition`)
  assert(
    canonicalJson(target) === canonicalJson(required),
    `${label} target differs from the required target`,
  )
}

function validatePerformanceEnvironment(environment, name, label) {
  assertExactKeys(
    environment,
    ['machine', 'os', 'node', 'terminal', 'dimensions', 'database', 'eventCount'],
    [],
    `${label} environment`,
  )
  for (const field of ['machine', 'os', 'node', 'terminal', 'dimensions', 'database'])
    assert(
      typeof environment[field] === 'string' &&
        environment[field].length > 0 &&
        environment[field].length <= 200,
      `${label} environment has no safe ${field}`,
    )
  assert(
    Number.isInteger(environment.eventCount) && environment.eventCount >= 0,
    `${label} environment has no event count`,
  )
  const required = REQUIRED_PERFORMANCE_ENVIRONMENTS[name]
  assert(required, `${label} has no required environment definition`)
  assert(environment.database === required.database, `${label} database workload differs`)
  assert(environment.eventCount === required.eventCount, `${label} event count differs`)
}

export function validatePerformanceMeasurements(measurements, label) {
  assert(Array.isArray(measurements) && measurements.length > 0, `${label} has no measurements`)
  for (const measurement of measurements) {
    assert(measurement && typeof measurement === 'object', `${label} has an invalid measurement`)
    assert(measurement.kind === 'distribution', `${label} requires distributions only`)
    assertExactKeys(
      measurement,
      [
        'kind',
        'name',
        'unit',
        'n',
        'minimum',
        'median',
        'p90',
        'p95',
        'p99',
        'maximum',
        'target',
        'environment',
        'state',
        'repetitions',
      ],
      [],
      `${label} measurement ${measurement.name ?? '<unknown>'}`,
    )
    assert(/^PERF-\d{2}$/u.test(measurement.name), `${label} has an unbound performance name`)
    assert(
      typeof measurement.unit === 'string' && measurement.unit.length > 0,
      `${label} measurement ${measurement.name} has no unit`,
    )
    assert(
      Number.isInteger(measurement.n) && measurement.n >= 2,
      `${label} measurement ${measurement.name} has invalid n`,
    )
    for (const field of ['minimum', 'median', 'p90', 'p95', 'p99', 'maximum'])
      finiteNumber(measurement[field], `${label} measurement ${measurement.name}.${field}`)
    assert(
      measurement.minimum <= measurement.median &&
        measurement.median <= measurement.p90 &&
        measurement.p90 <= measurement.p95 &&
        measurement.p95 <= measurement.p99 &&
        measurement.p99 <= measurement.maximum,
      `${label} measurement ${measurement.name} distribution is not ordered`,
    )
    assert(
      Number.isInteger(measurement.repetitions) && measurement.repetitions >= 2,
      `${label} measurement ${measurement.name} has invalid repetitions`,
    )
    assert(
      measurement.n === measurement.repetitions,
      `${label} measurement ${measurement.name} n differs from repetitions`,
    )
    assert(
      measurement.state === 'warm' || measurement.state === 'cold',
      `${label} measurement ${measurement.name} has no warm/cold state`,
    )
    validatePerformanceTarget(
      measurement.name,
      measurement.target,
      `${label} measurement ${measurement.name}`,
    )
    assert(
      measurement.unit === measurement.target.unit,
      `${label} measurement ${measurement.name} unit differs`,
    )
    const requiredEnvironment = REQUIRED_PERFORMANCE_ENVIRONMENTS[measurement.name]
    assert(
      measurement.state === requiredEnvironment.state,
      `${label} measurement ${measurement.name} state differs`,
    )
    validatePerformanceEnvironment(
      measurement.environment,
      measurement.name,
      `${label} measurement ${measurement.name}`,
    )
    const observed = measurement[measurement.target.percentile]
    const target = measurement.target.value
    const passes =
      measurement.target.operator === '<'
        ? observed < target
        : measurement.target.operator === '<='
          ? observed <= target
          : measurement.target.operator === '>'
            ? observed > target
            : observed >= target
    assert(passes, `${label} measurement ${measurement.name} is outside its target`)
  }
}

export function validatePerformanceMatrix(measurements, label) {
  validatePerformanceMeasurements(measurements, label)
  const names = new Set(measurements.map((measurement) => measurement.name))
  assert(
    measurements.length === REQUIRED_PERFORMANCE_IDS.length &&
      names.size === REQUIRED_PERFORMANCE_IDS.length,
    `${label} must contain PERF-01 through PERF-10`,
  )
  for (const name of REQUIRED_PERFORMANCE_IDS)
    assert(names.has(name), `${label} is missing ${name}`)
}
