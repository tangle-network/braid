import { REQUIRED_PERFORMANCE_TARGETS } from '../release-evidence.mjs'

const PERCENTILES = Object.freeze(['minimum', 'median', 'p90', 'p95', 'p99', 'maximum'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function finite(value, label) {
  assert(typeof value === 'number' && Number.isFinite(value), `${label} must be finite`)
  return value
}

function percentile(ordered, fraction) {
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)
  return ordered[index]
}

export function summarizeSamples(samples, label = 'samples', { allowSingle = false } = {}) {
  assert(
    Array.isArray(samples) && samples.length >= (allowSingle ? 1 : 2),
    `${label} requires at least ${allowSingle ? 'one' : 'two'} samples`,
  )
  const ordered = samples
    .map((value, index) => finite(value, `${label}[${index}]`))
    .sort((a, b) => a - b)
  const distribution = {
    n: ordered.length,
    minimum: ordered[0],
    median: percentile(ordered, 0.5),
    p90: percentile(ordered, 0.9),
    p95: percentile(ordered, 0.95),
    p99: percentile(ordered, 0.99),
    maximum: ordered.at(-1),
  }
  for (const field of PERCENTILES) finite(distribution[field], `${label}.${field}`)
  return Object.freeze(distribution)
}

function passesTarget(distribution, target) {
  const observed = distribution[target.percentile]
  switch (target.operator) {
    case '<':
      return observed < target.value
    case '<=':
      return observed <= target.value
    case '>':
      return observed > target.value
    case '>=':
      return observed >= target.value
    default:
      throw new Error(`Unsupported performance target operator: ${target.operator}`)
  }
}

function freezeCopy(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/**
 * Creates the raw performance record and its exact release-verifier projection.
 * The raw record deliberately retains every sample and invariant; the release
 * projection is kept compatible with scripts/release-evidence.mjs.
 */
export function createPerformanceMeasurement(input) {
  const target = REQUIRED_PERFORMANCE_TARGETS[input.name]
  if (!target) throw new Error(`Unknown performance requirement ${input.name}`)
  const distribution = summarizeSamples(input.samples, `${input.name} samples`, {
    allowSingle: input.allowSingleSample === true,
  })
  const targetPassed = passesTarget(distribution, target)
  const qualityPassed = input.qualityPassed !== false
  const failureReasons = [...(input.failureReasons ?? [])]
  if (!targetPassed) {
    const observed = distribution[target.percentile]
    failureReasons.push(
      `${target.metric} ${target.percentile}=${observed} ${target.operator} ${target.value} target was missed`,
    )
  }
  if (!qualityPassed && failureReasons.length === 0)
    failureReasons.push('measurement quality invariants did not pass')
  const rawSamples = input.rawSamples ?? input.samples
  assert(Array.isArray(rawSamples) && rawSamples.length > 0, `${input.name} has no raw samples`)
  assert(input.repetitions === distribution.n, `${input.name} repetitions must equal n`)
  assert(input.state === 'warm' || input.state === 'cold', `${input.name} has invalid state`)
  assert(
    input.environment && typeof input.environment === 'object',
    `${input.name} has no environment`,
  )
  assert(
    typeof input.command === 'string' && input.command.length > 0,
    `${input.name} has no command`,
  )
  return Object.freeze({
    kind: 'distribution',
    name: input.name,
    unit: input.unit,
    ...distribution,
    target: structuredClone(target),
    environment: structuredClone(input.environment),
    state: input.state,
    repetitions: input.repetitions,
    rawSamples: freezeCopy(rawSamples),
    command: input.command,
    passed: targetPassed && qualityPassed,
    observations: freezeCopy(input.observations ?? {}),
    details: freezeCopy(input.details ?? {}),
    failureReasons: freezeCopy(failureReasons),
    provenance: freezeCopy(input.provenance ?? {}),
  })
}

export function releaseMeasurement(measurement) {
  return Object.freeze({
    kind: measurement.kind,
    name: measurement.name,
    unit: measurement.unit,
    n: measurement.n,
    minimum: measurement.minimum,
    median: measurement.median,
    p90: measurement.p90,
    p95: measurement.p95,
    p99: measurement.p99,
    maximum: measurement.maximum,
    target: structuredClone(measurement.target),
    environment: structuredClone(measurement.environment),
    state: measurement.state,
    repetitions: measurement.repetitions,
  })
}

export function assertPerformancePass(measurement) {
  assert(measurement.passed === true, `${measurement.name} missed its target`)
  return measurement
}

export function observation(value, reason) {
  assert(
    value === null || (typeof value === 'number' && Number.isFinite(value)),
    'observation value must be numeric or null',
  )
  assert(typeof reason === 'string' && reason.length > 0, 'observation reason is required')
  return Object.freeze({ value, reason })
}

export function assertFullDuration(durationMs, requiredMs = 60_000) {
  finite(durationMs, 'durationMs')
  finite(requiredMs, 'requiredMs')
  assert(
    durationMs >= requiredMs,
    `Measured duration ${durationMs}ms is shorter than ${requiredMs}ms`,
  )
  return durationMs
}

export function mergeObservations(...groups) {
  return Object.freeze(Object.assign({}, ...groups))
}
