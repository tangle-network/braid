import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { safeJson } from './contracts.mjs'
import {
  assertComparisonAnalysis,
  readInfrastructureEvidence,
} from './provider-infrastructure-evidence.mjs'

export const COMPARISON_PLAN_SCHEMA = 'braid.provider-comparison.plan.v1'
export const COMPARISON_ATTEMPT_SCHEMA = 'braid.provider-comparison.attempt.v1'
export const COMPARISON_REPORT_SCHEMA = 'braid.provider-comparison.report.v1'
export const COHORT_FIELDS = Object.freeze([
  'cpu',
  'memoryMb',
  'diskMb',
  'region',
  'model',
  'modelProvider',
  'runner',
  'runnerVersion',
  'imageDigest',
  'taskDigest',
  'profileDigest',
  'binaryDigest',
  'concurrency',
  'startMode',
  'retentionMs',
])
const COST_FIELDS = ['compute', 'storage', 'egress', 'model', 'other']
const TIMING_FIELDS = ['createMs', 'firstUsefulOutputMs']
const PERSISTENCE_FIELDS = ['processRestart', 'context', 'trackedFiles', 'untrackedFiles']
const EASE_FIELDS = ['setupMs', 'manualSteps']
const GROUPS = {
  actual: COHORT_FIELDS,
  costs: COST_FIELDS,
  timing: TIMING_FIELDS,
  persistence: PERSISTENCE_FIELDS,
  ease: EASE_FIELDS,
  cleanup: ['exactOwnedResourcesRemoved'],
  allocation: ['environmentId'],
}
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
}

function exactKeys(value, keys, label) {
  object(value, label)
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`${label} contains an unsupported field`)
  }
  for (const key of keys)
    if (!Object.hasOwn(value, key)) throw new Error(`${label}.${key} is required`)
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive integer at most ${maximum}`)
  }
}

function nonnegative(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite nonnegative number`)
  }
}

function sumUsd(values) {
  const nanos = values.reduce((sum, value) => sum + Math.round(value * 1e9), 0)
  if (!Number.isSafeInteger(nanos))
    throw new Error('Observed charge total exceeds safe fixed-point accounting')
  return nanos / 1e9
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a timestamp`)
  }
  return Date.parse(value)
}

function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value))
    throw new Error(`${label} must be a bounded identifier`)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  }
  return value
}

export function comparisonDigest(value) {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`
}

export function assertComparisonPlan(plan) {
  exactKeys(
    plan,
    [
      'schema',
      'id',
      'createdAt',
      'targetProvider',
      'minimumSamples',
      'cohort',
      'attempts',
      'analysis',
    ],
    'plan',
  )
  if (plan.schema !== COMPARISON_PLAN_SCHEMA) throw new Error('Unsupported comparison plan schema')
  identifier(plan.id, 'plan.id')
  identifier(plan.targetProvider, 'plan.targetProvider')
  timestamp(plan.createdAt, 'plan.createdAt')
  positiveInteger(plan.minimumSamples, 'plan.minimumSamples', 1000)
  assertComparisonAnalysis(plan.analysis)
  exactKeys(plan.cohort, COHORT_FIELDS, 'plan.cohort')
  for (const field of ['cpu', 'memoryMb', 'diskMb', 'concurrency', 'retentionMs']) {
    positiveInteger(plan.cohort[field], `plan.cohort.${field}`)
  }
  if (!['cold', 'warm'].includes(plan.cohort.startMode))
    throw new Error('plan.cohort.startMode must be cold or warm')
  for (const field of ['region', 'model', 'modelProvider', 'runner', 'runnerVersion']) {
    if (
      typeof plan.cohort[field] !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(plan.cohort[field])
    ) {
      throw new Error(`plan.cohort.${field} must be a bounded configuration value`)
    }
  }
  for (const field of ['imageDigest', 'taskDigest', 'profileDigest', 'binaryDigest']) {
    if (!DIGEST.test(plan.cohort[field]))
      throw new Error(`plan.cohort.${field} must be a SHA-256 digest`)
  }
  if (!Array.isArray(plan.attempts) || plan.attempts.length < 2 || plan.attempts.length > 3000) {
    throw new Error('plan.attempts must contain 2 through 3000 declared cells')
  }
  const ids = new Set()
  const providers = new Set()
  const units = new Set()
  for (const attempt of plan.attempts) {
    exactKeys(attempt, ['id', 'provider', 'unitId'], 'plan.attempt')
    identifier(attempt.id, 'plan.attempt.id')
    identifier(attempt.provider, 'plan.attempt.provider')
    identifier(attempt.unitId, 'plan.attempt.unitId')
    const unit = `${attempt.provider}:${attempt.unitId}`
    if (units.has(unit))
      throw new Error('Repeated measurements of one allocation window are not independent units')
    units.add(unit)
    if (ids.has(attempt.id)) throw new Error('Comparison plan has duplicate attempt IDs')
    ids.add(attempt.id)
    providers.add(attempt.provider)
  }
  if (!providers.has(plan.targetProvider) || providers.size < 2) {
    throw new Error('Comparison plan requires its target and at least one competitor')
  }
  const targetUnits = plan.attempts
    .filter((cell) => cell.provider === plan.targetProvider)
    .map((cell) => cell.unitId)
  if (
    [...providers].some(
      (provider) =>
        targetUnits.some((unitId) => !units.has(`${provider}:${unitId}`)) ||
        plan.attempts.filter((cell) => cell.provider === provider).length !== targetUnits.length,
    )
  )
    throw new Error('Every provider must declare the same independent allocation windows')
  return plan
}

export async function readComparisonPlan(path) {
  return assertComparisonPlan(JSON.parse(await readFile(resolve(path), 'utf8')))
}

export function unavailableMeasurement(reason = 'provider-did-not-report') {
  identifier(reason, 'measurement.reason')
  return { status: 'unavailable', reason }
}

export function observedMeasurement(value, source) {
  return { status: 'observed', value, source }
}

function proofValue(proof, source) {
  if (!Array.isArray(source) || source.length === 0 || source.length > 16) {
    throw new Error('Observed measurement requires a bounded proof source path')
  }
  let value = proof
  for (const key of source) {
    if (
      (typeof key !== 'string' && !Number.isSafeInteger(key)) ||
      key === '__proto__' ||
      key === 'constructor'
    ) {
      throw new Error('Measurement source path is invalid')
    }
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new Error('Observed measurement source is missing from proof')
    }
    value = value[key]
  }
  return value
}

function assertMeasurement(measurement, proof, group, field, attempt) {
  object(measurement, `${group}.${field}`)
  if (measurement.status === 'unavailable') {
    exactKeys(measurement, ['status', 'reason'], `${group}.${field}`)
    identifier(measurement.reason, `${group}.${field}.reason`)
    return
  }
  exactKeys(measurement, ['status', 'value', 'source'], `${group}.${field}`)
  if (measurement.status !== 'observed')
    throw new Error('Measurement status must be observed or unavailable')
  if (JSON.stringify(proofValue(proof, measurement.source)) !== JSON.stringify(measurement.value)) {
    throw new Error(`${group}.${field} does not match its proof source`)
  }
  if (['persistence', 'cleanup'].includes(group)) {
    if (typeof measurement.value !== 'boolean') throw new Error(`${group}.${field} must be boolean`)
  } else if (group === 'allocation') {
    if (typeof measurement.value !== 'string' || measurement.value.length === 0)
      throw new Error('Allocation identity must be a nonempty provider observation')
  } else if (group !== 'actual') {
    nonnegative(measurement.value, `${group}.${field}`)
    if (field === 'manualSteps' && !Number.isSafeInteger(measurement.value))
      throw new Error('manualSteps must be an integer')
    if (group === 'costs') {
      const receipt = proofValue(proof, measurement.source.slice(0, -1))
      if (
        measurement.source.at(-1) !== 'usd' ||
        receipt.status !== 'settled' ||
        receipt.currency !== 'USD' ||
        receipt.scope !== 'owned-attempt' ||
        receipt.component !== field ||
        receipt.attemptId !== attempt.id ||
        receipt.provider !== attempt.provider ||
        typeof receipt.receiptId !== 'string' ||
        !ID.test(receipt.receiptId)
      ) {
        throw new Error(
          'Observed cost requires an exact settled provider charge receipt; estimates and account totals are inadmissible',
        )
      }
    }
  } else if (typeof measurement.value !== 'string' && typeof measurement.value !== 'number') {
    throw new Error(`actual.${field} must be scalar`)
  }
}

export function assertComparisonAttempt(plan, attempt) {
  assertComparisonPlan(plan)
  exactKeys(
    attempt,
    [
      'schema',
      'id',
      'provider',
      'planDigest',
      'startedAt',
      'completedAt',
      'status',
      'proofDigest',
      'proof',
      'measurements',
    ],
    'attempt',
  )
  if (attempt.schema !== COMPARISON_ATTEMPT_SCHEMA)
    throw new Error('Unsupported comparison attempt schema')
  const cell = plan.attempts.find((entry) => entry.id === attempt.id)
  if (cell === undefined || cell.provider !== attempt.provider)
    throw new Error('Attempt is not a declared comparison cell')
  if (attempt.planDigest !== comparisonDigest(plan))
    throw new Error('Attempt comparison plan digest changed')
  const started = timestamp(attempt.startedAt, 'attempt.startedAt')
  const completed =
    attempt.status === 'incomplete' && attempt.completedAt === null
      ? null
      : timestamp(attempt.completedAt, 'attempt.completedAt')
  if (
    started < timestamp(plan.createdAt, 'plan.createdAt') ||
    (completed !== null && completed < started)
  ) {
    throw new Error('Comparison plan must precede execution and completion must follow start')
  }
  if (!['passed', 'failed', 'unavailable', 'incomplete'].includes(attempt.status))
    throw new Error('Invalid comparison attempt outcome')
  object(attempt.proof, 'attempt.proof')
  if (
    attempt.proof.status !== attempt.status ||
    attempt.proofDigest !== comparisonDigest(attempt.proof)
  ) {
    throw new Error('Comparison attempt does not match its immutable proof')
  }
  exactKeys(attempt.measurements, Object.keys(GROUPS), 'attempt.measurements')
  for (const [group, fields] of Object.entries(GROUPS)) {
    exactKeys(attempt.measurements[group], fields, `measurements.${group}`)
    for (const field of fields)
      assertMeasurement(attempt.measurements[group][field], attempt.proof, group, field, attempt)
  }
  const retained = attempt.measurements.actual.retentionMs
  if (
    retained.status === 'observed' &&
    (completed === null || retained.value > completed - started) &&
    Object.values(attempt.measurements.persistence).some(
      (measurement) => measurement.status === 'observed' && measurement.value,
    )
  ) {
    throw new Error('Retention observation cannot exceed the measured attempt duration')
  }
  return attempt
}

/** Every observed value is bound to a field of the retained producer proof. */
export function captureComparisonAttempt({
  plan,
  id,
  proof,
  startedAt,
  completedAt,
  measurements = {},
}) {
  assertComparisonPlan(plan)
  const cell = plan.attempts.find((entry) => entry.id === id)
  if (cell === undefined) throw new Error('Cannot capture an undeclared comparison attempt')
  // Sanitize at the report's wrapper depth so a write/read cannot change the proof digest.
  const sanitized = JSON.parse(safeJson({ attempts: [{ proof }] })).attempts[0].proof
  const attempt = {
    schema: COMPARISON_ATTEMPT_SCHEMA,
    id,
    provider: cell.provider,
    planDigest: comparisonDigest(plan),
    startedAt,
    completedAt,
    status: sanitized.status,
    proofDigest: comparisonDigest(sanitized),
    proof: sanitized,
    measurements: Object.fromEntries(
      Object.entries(GROUPS).map(([group, fields]) => [
        group,
        Object.fromEntries(
          fields.map((field) => [field, measurements[group]?.[field] ?? unavailableMeasurement()]),
        ),
      ]),
    ),
  }
  return assertComparisonAttempt(plan, attempt)
}

export function comparisonDistribution(measurements, requested) {
  const values = measurements
    .filter((entry) => entry?.status === 'observed')
    .map((entry) => entry.value)
    .sort((a, b) => a - b)
  const percentile = (fraction) =>
    values.length === 0 ? null : values[Math.ceil(values.length * fraction) - 1]
  return {
    requested,
    observed: values.length,
    unavailable: measurements.filter((entry) => entry?.status === 'unavailable').length,
    excluded: measurements.filter((entry) => entry?.status === 'excluded').length,
    excludedValues: measurements
      .filter((entry) => entry?.status === 'excluded')
      .map(({ value, reason }) => ({ value, reason })),
    notStarted: requested - measurements.length,
    min: values[0] ?? null,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: values.at(-1) ?? null,
    values,
  }
}

function complete(dist) {
  return dist.requested > 0 && dist.observed === dist.requested
}

function outcomes(attempts, requested) {
  return {
    requested,
    attempted: attempts.length,
    passed: attempts.filter((entry) => entry.status === 'passed').length,
    failed: attempts.filter((entry) => entry.status === 'failed').length,
    unavailable: attempts.filter((entry) => entry.status === 'unavailable').length,
    incomplete: attempts.filter((entry) => entry.status === 'incomplete').length,
    notStarted: requested - attempts.length,
  }
}

function summarizeProvider(plan, provider, attempts) {
  const requested = plan.attempts.filter((cell) => cell.provider === provider).length
  const count = outcomes(attempts, requested)
  const distribution = (group, field) =>
    comparisonDistribution(
      attempts.map((attempt) => {
        const measurement = attempt.measurements[group][field]
        if (
          ['timing', 'ease'].includes(group) &&
          attempt.status !== 'passed' &&
          measurement.status === 'observed'
        ) {
          return {
            status: 'excluded',
            reason: 'workflow-did-not-complete-successfully',
            value: measurement.value,
          }
        }
        return measurement
      }),
      requested,
    )
  const costs = Object.fromEntries(
    COST_FIELDS.map((field) => {
      const values = distribution('costs', field)
      return [field, { ...values, observedUsd: sumUsd(values.values) }]
    }),
  )
  const totals = attempts.map((attempt) => {
    const fields = COST_FIELDS.map((field) => attempt.measurements.costs[field])
    return fields.every((entry) => entry.status === 'observed')
      ? { status: 'observed', value: sumUsd(fields.map((entry) => entry.value)) }
      : unavailableMeasurement('incomplete-charge-accounting')
  })
  const cost = comparisonDistribution(totals, requested)
  const observedTotalUsd = sumUsd(
    totals.filter((entry) => entry.status === 'observed').map((entry) => entry.value),
  )
  const cells = attempts.map((attempt) => {
    const mismatches = COHORT_FIELDS.filter(
      (field) =>
        attempt.measurements.actual[field].status === 'observed' &&
        attempt.measurements.actual[field].value !== plan.cohort[field],
    )
    const unknown = COHORT_FIELDS.filter(
      (field) => attempt.measurements.actual[field].status !== 'observed',
    )
    return {
      id: attempt.id,
      status: attempt.status,
      mismatches,
      unknown,
      comparable: mismatches.length === 0 && unknown.length === 0,
    }
  })
  const persistence = Object.fromEntries(
    PERSISTENCE_FIELDS.map((field) => {
      const records = attempts.map((attempt) => attempt.measurements.persistence[field])
      return [
        field,
        {
          requested,
          passed: records.filter((entry) => entry.status === 'observed' && entry.value).length,
          failed: records.filter((entry) => entry.status === 'observed' && !entry.value).length,
          unavailable: records.filter((entry) => entry.status === 'unavailable').length,
          notStarted: requested - records.length,
        },
      ]
    }),
  )
  const cleaned = attempts.filter(
    (attempt) =>
      attempt.measurements.cleanup.exactOwnedResourcesRemoved.status === 'observed' &&
      attempt.measurements.cleanup.exactOwnedResourcesRemoved.value,
  ).length
  return {
    provider,
    outcomes: count,
    cells,
    comparable: cells.length === requested && cells.every((cell) => cell.comparable),
    costs: {
      components: costs,
      total: cost,
      observedTotalUsd,
      knownComponentUsd: sumUsd(Object.values(costs).map((component) => component.observedUsd)),
      totalUsd: complete(cost) ? observedTotalUsd : null,
      usdPerSuccessfulAttempt:
        complete(cost) && count.passed > 0 ? observedTotalUsd / count.passed : null,
    },
    timing: Object.fromEntries(
      TIMING_FIELDS.map((field) => [field, distribution('timing', field)]),
    ),
    persistence,
    ease: Object.fromEntries(EASE_FIELDS.map((field) => [field, distribution('ease', field)])),
    cleanup: { requested, confirmed: cleaned, unproved: requested - cleaned },
  }
}

function lowerVerdict(left, right) {
  if (left.some((value) => value === null) || right.some((value) => value === null))
    return 'unknown'
  if (left.some((value, index) => value > right[index])) return 'behind'
  return left.some((value, index) => value < right[index]) ? 'ahead' : 'tied'
}

function compareProviders(plan, target, competitor) {
  const limits = []
  if (!target.comparable || !competitor.comparable) limits.push('unverified-or-unequal-cohort')
  if (target.outcomes.requested !== competitor.outcomes.requested)
    limits.push('unequal-attempt-count')
  if (
    target.outcomes.attempted < plan.minimumSamples ||
    competitor.outcomes.attempted < plan.minimumSamples
  )
    limits.push('below-declared-minimum-samples')
  if (target.outcomes.notStarted || competitor.outcomes.notStarted)
    limits.push('planned-attempts-not-started')
  if (target.outcomes.unavailable || competitor.outcomes.unavailable)
    limits.push('unavailable-attempts')
  if (target.outcomes.incomplete || competitor.outcomes.incomplete)
    limits.push('incomplete-attempts')
  if (target.cleanup.unproved || competitor.cleanup.unproved)
    limits.push('resource-cleanup-unproved')
  const worseSuccess =
    target.outcomes.passed / target.outcomes.requested <
    competitor.outcomes.passed / competitor.outcomes.requested
  const timingComplete = TIMING_FIELDS.every(
    (field) => complete(target.timing[field]) && complete(competitor.timing[field]),
  )
  const easeComplete = EASE_FIELDS.every(
    (field) => complete(target.ease[field]) && complete(competitor.ease[field]),
  )
  const persistenceComplete = [target, competitor].every((provider) =>
    PERSISTENCE_FIELDS.every(
      (field) =>
        provider.persistence[field].unavailable === 0 &&
        provider.persistence[field].notStarted === 0,
    ),
  )
  const dimensions = {
    cost:
      complete(target.costs.total) && complete(competitor.costs.total)
        ? lowerVerdict(
            [target.costs.usdPerSuccessfulAttempt],
            [competitor.costs.usdPerSuccessfulAttempt],
          )
        : 'unknown',
    latency: timingComplete
      ? lowerVerdict(
          TIMING_FIELDS.flatMap((field) => [target.timing[field].p50, target.timing[field].p95]),
          TIMING_FIELDS.flatMap((field) => [
            competitor.timing[field].p50,
            competitor.timing[field].p95,
          ]),
        )
      : 'unknown',
    persistence: persistenceComplete
      ? lowerVerdict(
          PERSISTENCE_FIELDS.map(
            (field) => 1 - target.persistence[field].passed / target.persistence[field].requested,
          ),
          PERSISTENCE_FIELDS.map(
            (field) =>
              1 - competitor.persistence[field].passed / competitor.persistence[field].requested,
          ),
        )
      : 'unknown',
    ease: easeComplete
      ? lowerVerdict(
          EASE_FIELDS.flatMap((field) => [target.ease[field].p50, target.ease[field].p95]),
          EASE_FIELDS.flatMap((field) => [competitor.ease[field].p50, competitor.ease[field].p95]),
        )
      : 'unknown',
  }
  if (worseSuccess) limits.push('target-has-lower-task-success')
  return {
    target: target.provider,
    competitor: competitor.provider,
    dimensions,
    limits,
    status:
      limits.length === 0 && Object.values(dimensions).every((verdict) => verdict === 'ahead')
        ? 'passed'
        : 'unproved',
  }
}

export function providerComparisonReport(plan, attempts, infrastructureEvidence = []) {
  assertComparisonPlan(plan)
  const unique = new Map()
  for (const attempt of attempts) {
    assertComparisonAttempt(plan, attempt)
    if (unique.has(attempt.id)) {
      const previous = unique.get(attempt.id)
      if (
        previous.status === 'incomplete' &&
        attempt.status !== 'incomplete' &&
        previous.startedAt === attempt.startedAt
      ) {
        unique.set(attempt.id, attempt)
        continue
      }
      if (
        attempt.status === 'incomplete' &&
        previous.status !== 'incomplete' &&
        previous.startedAt === attempt.startedAt
      )
        continue
      if (comparisonDigest(previous) !== comparisonDigest(attempt))
        throw new Error('Conflicting duplicate comparison attempt')
      continue
    }
    unique.set(attempt.id, attempt)
  }
  const records = [...unique.values()]
  const providers = [...new Set(plan.attempts.map((cell) => cell.provider))].map((provider) =>
    summarizeProvider(
      plan,
      provider,
      records.filter((attempt) => attempt.provider === provider),
    ),
  )
  const target = providers.find((provider) => provider.provider === plan.targetProvider)
  const comparisons = providers
    .filter((provider) => provider !== target)
    .map((provider) => {
      const comparison = compareProviders(plan, target, provider)
      const providerRecords = records.filter((attempt) =>
        [target.provider, provider.provider].includes(attempt.provider),
      )
      const allocations = providerRecords.map(
        (attempt) => attempt.measurements.allocation.environmentId,
      )
      if (
        allocations.some((measurement) => measurement.status !== 'observed') ||
        new Set(
          allocations.map(
            (measurement, index) => `${providerRecords[index].provider}:${measurement.value}`,
          ),
        ).size !== allocations.length
      )
        comparison.limits.push('allocation-independence-unproved')
      comparison.descriptiveStatus = comparison.status === 'passed' ? 'ahead-candidate' : 'unproved'
      comparison.uncertainty = {
        status: 'unproved',
        owner: 'tangle-network/agent-dev-container',
        reason: 'registered-all-four-provider-assessment-required',
      }
      comparison.status = 'unproved'
      return comparison
    })
  return {
    schema: COMPARISON_REPORT_SCHEMA,
    planDigest: comparisonDigest(plan),
    plan,
    status: comparisons.every((comparison) => comparison.status === 'passed')
      ? 'passed'
      : 'unproved',
    requested: plan.attempts.length,
    attempted: records.length,
    providers,
    comparisons,
    infrastructureEvidence,
    statisticalLimits: [
      'Nearest-rank p50/p95 are descriptive observations; leadership also requires every preregistered uncertainty and precision gate.',
      'The declared minimum is a collection gate, not a power guarantee.',
      'Failures, unavailable measurements, incomplete attempts and unstarted cells remain in every denominator.',
      'Ties on a dimension do not establish leadership.',
    ],
    attempts: records,
  }
}

export async function writeComparisonArtifact(path, value) {
  const destination = resolve(path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${safeJson(value)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, destination)
  } finally {
    await rm(temporary, { force: true })
  }
}

/** Collection consumes existing live producers; it never starts a provider run. */
export async function collectProviderComparison({
  planPath,
  attemptPaths,
  outputPath,
  infrastructurePaths = [],
}) {
  const plan = await readComparisonPlan(planPath)
  const attempts = []
  for (const path of attemptPaths) {
    const value = JSON.parse(await readFile(resolve(path), 'utf8'))
    attempts.push(...(Array.isArray(value.comparableAttempts) ? value.comparableAttempts : [value]))
  }
  const infrastructureEvidence = []
  for (const path of infrastructurePaths)
    infrastructureEvidence.push(await readInfrastructureEvidence(path))
  const report = providerComparisonReport(plan, attempts, infrastructureEvidence)
  if (outputPath !== undefined) await writeComparisonArtifact(outputPath, report)
  return report
}
