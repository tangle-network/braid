import { createHash } from 'node:crypto'

import {
  canonicalJson,
  validateMeasurements,
  validatePerformanceMatrix,
} from '../release-evidence.mjs'
import { bindingForCheck } from './build-identity.mjs'
import { redactText } from './command-runner.mjs'

const STRUCTURED_CATEGORIES = new Set(['eval', 'live', 'performance'])
const EXACT_MEASUREMENT_CHECK = /^(?:(?:UP|LIVE|PERF|EVAL)-[0-9]{2}|VR-03)$/u

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(value) {
  return createHash('sha256')
    .update(Buffer.from(canonicalJson(value)))
    .digest('hex')
}

function unavailableMeasurement(category, reason, secrets = []) {
  return {
    kind: 'uncaptured',
    name: `${category}-evidence`,
    reason: redactText(reason, secrets),
  }
}

function markers(text, prefix) {
  return String(text)
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      try {
        return JSON.parse(line.slice(prefix.length))
      } catch (error) {
        throw new Error(`Invalid ${prefix} release marker`, { cause: error })
      }
    })
}

function unavailableEvidence(category, reason, result = 'uncaptured', secrets = []) {
  const safeReason = redactText(reason, secrets)
  return {
    result,
    measurements: [unavailableMeasurement(category, safeReason, secrets)],
    reason: safeReason,
  }
}

function resultMarkerValue(category, values, secrets) {
  if (values.length === 0) return undefined
  if (values.length !== 1)
    throw new Error(`${category} emitted duplicate BRAID_RELEASE_RESULT_JSON markers`)
  const value = values[0]
  assert(
    value && typeof value === 'object' && !Array.isArray(value),
    `${category} result marker is not an object`,
  )
  const keys = Object.keys(value)
  assert(
    keys.every((key) => key === 'status' || key === 'reason'),
    `${category} result marker has unknown fields`,
  )
  assert(typeof value.status === 'string', `${category} result marker has no status`)
  if (value.reason !== undefined)
    assert(typeof value.reason === 'string', `${category} result marker reason is not text`)
  return value.reason === undefined
    ? value
    : { ...value, reason: redactText(value.reason, secrets) }
}

function sanitizeMeasurementStrings(measurements, secrets) {
  if (!Array.isArray(measurements)) return measurements
  return measurements.map((measurement) => {
    if (!measurement || typeof measurement !== 'object' || Array.isArray(measurement))
      return measurement
    const sanitized = { ...measurement }
    for (const [field, value] of Object.entries(sanitized)) {
      if (typeof value !== 'string') continue
      if (field === 'reason') sanitized[field] = redactText(value, secrets)
      else if (secrets.some((secret) => secret.length > 0 && value.includes(secret)))
        throw new Error(`Structured measurement ${field} contains a credential value`)
    }
    return sanitized
  })
}

export function structuredChildEvidence(
  category,
  stdoutBytes,
  durationMs,
  checkId,
  structuredError,
  secrets = [],
) {
  const unavailable = (reason, result = 'uncaptured') =>
    unavailableEvidence(category, reason, result, secrets)
  if (structuredError) return unavailable(structuredError)
  const text = Buffer.from(stdoutBytes).toString('utf8')
  let resultMarker
  let measurementMarkers
  try {
    resultMarker = resultMarkerValue(category, markers(text, 'BRAID_RELEASE_RESULT_JSON='), secrets)
    measurementMarkers = markers(text, 'BRAID_RELEASE_MEASUREMENTS_JSON=')
  } catch (error) {
    return unavailable(error.message)
  }
  const exactMeasurementRequired = EXACT_MEASUREMENT_CHECK.test(checkId)
  if (!STRUCTURED_CATEGORIES.has(category) && !exactMeasurementRequired) {
    if (measurementMarkers.length > 0) {
      return unavailable(`${category} emitted an unexpected measurement marker`)
    }
    if (!resultMarker) {
      return {
        result: 'passed',
        measurements: [{ kind: 'scalar', name: 'duration', unit: 'ms', value: durationMs }],
        reason: null,
      }
    }
    if (resultMarker.status === 'passed')
      return {
        result: 'passed',
        measurements: [{ kind: 'scalar', name: 'duration', unit: 'ms', value: durationMs }],
        reason: null,
      }
    if (resultMarker.status === 'unavailable')
      return unavailable(resultMarker.reason ?? 'The check reported unavailable', 'unavailable')
    if (resultMarker.status === 'failed')
      return unavailable(resultMarker.reason ?? 'The check reported failed', 'failed')
    return unavailable(`Unknown ${category} result status: ${resultMarker.status}`)
  }
  if (!resultMarker)
    return unavailable(`${category} command completed without BRAID_RELEASE_RESULT_JSON`)
  if (resultMarker.status === 'unavailable') {
    if (measurementMarkers.length > 0)
      return unavailable(`${category} reported unavailable and measurements together`)
    return unavailable(resultMarker.reason ?? 'The check reported unavailable', 'unavailable')
  }
  if (resultMarker.status === 'failed') {
    if (measurementMarkers.length > 0)
      return unavailable(`${category} reported failed and measurements together`)
    return unavailable(resultMarker.reason ?? 'The check reported failed', 'failed')
  }
  if (resultMarker.status !== 'passed')
    return unavailable(`Unknown ${category} result status: ${resultMarker.status}`)
  if (measurementMarkers.length !== 1)
    return unavailable(`${category} must emit exactly one measurement marker`)
  let evidence
  try {
    evidence = measurementMarkers[0]
  } catch (error) {
    return unavailable(error.message)
  }
  let measurements = Array.isArray(evidence) ? evidence : evidence.measurements
  try {
    measurements = sanitizeMeasurementStrings(measurements, secrets)
    if (category === 'performance') validatePerformanceMatrix(measurements, 'Performance evidence')
    else validateMeasurements(measurements, `${category} evidence`)
  } catch (error) {
    return unavailable(error.message)
  }
  let selectedMeasurements = measurements
  if (exactMeasurementRequired) {
    selectedMeasurements = measurements.filter((measurement) => measurement.name === checkId)
    if (selectedMeasurements.length !== 1)
      return unavailable(`${checkId} emitted no unique matching measurement`)
  }
  if (
    selectedMeasurements.some(
      (measurement) => measurement.kind === 'unavailable' || measurement.kind === 'uncaptured',
    )
  ) {
    return unavailable(`${category} evidence contains an unavailable or uncaptured measurement`)
  }
  if (
    checkId === 'VR-03' &&
    (selectedMeasurements[0]?.kind !== 'scalar' ||
      selectedMeasurements[0]?.unit !== 'seeds' ||
      !Number.isInteger(selectedMeasurements[0]?.value) ||
      selectedMeasurements[0].value < 100_000)
  )
    return unavailable('VR-03 requires at least 100,000 completed seeds')
  if (
    typeof checkId === 'string' &&
    checkId.startsWith('UP-') &&
    (selectedMeasurements[0]?.kind !== 'scalar' ||
      selectedMeasurements[0]?.unit !== 'upstream-attestations' ||
      !Number.isInteger(selectedMeasurements[0]?.value) ||
      selectedMeasurements[0].value < 1)
  )
    return unavailable(`${checkId} requires owning-repository attestations`)
  return { result: 'passed', measurements: selectedMeasurements, reason: null }
}

export function environmentRecord({ cwd, argv, environment, boundary }) {
  const details = { schemaVersion: 1, cwd, argv, environment, boundary }
  return {
    id: `env-${sha256(details).slice(0, 32)}`,
    kind: 'child-process',
    details,
  }
}

export function boundaryForCheck({ cwd, processResult, identity, requirementIds }) {
  return {
    schemaVersion: 1,
    shell: false,
    cwd,
    processTreeStrategy: processResult.processTreeStrategy,
    cleanupConfirmed: processResult.cleanupConfirmed,
    tarballSha256: identity.tarballSha256,
    gitCommit: identity.gitCommit,
    dependencyDigest: identity.dependencyDigest,
    requirementIds: [...requirementIds].sort(),
  }
}

export function buildCheckRecord({
  checkId,
  category,
  command,
  cwd,
  attempt,
  identity,
  requirementIds,
  processResult,
  sanitizedArgv,
  sanitizedEnvironment,
  environmentId,
  structuredRedactionSecrets = [],
  structuredEvidenceOverride,
}) {
  const evidence =
    structuredEvidenceOverride ??
    structuredChildEvidence(
      category,
      processResult.structuredStdout?.bytes ?? processResult.stdout.bytes,
      processResult.durationMs,
      checkId,
      processResult.structuredStdout?.error,
      structuredRedactionSecrets,
    )
  const outputRedactionComplete =
    processResult.stdout.redactionFailClosed === false &&
    processResult.stderr.redactionFailClosed === false
  const processPassed =
    processResult.exitCode === 0 &&
    processResult.signal === null &&
    processResult.timedOut === false &&
    processResult.spawnError === null &&
    processResult.cleanupConfirmed === true &&
    outputRedactionComplete
  const result = processPassed ? evidence.result : processResult.timedOut ? 'failed' : 'failed'
  const failureReason = processPassed
    ? evidence.reason
    : !outputRedactionComplete
      ? 'output redaction failed closed'
      : processResult.timedOut
        ? 'command timed out'
        : processResult.spawnError
          ? `command could not start: ${processResult.spawnError}`
          : processResult.signal
            ? `command terminated by ${processResult.signal}`
            : `command exited with status ${String(processResult.exitCode)}`
  const failureDetails =
    result === 'passed'
      ? null
      : {
          reason: redactText(
            failureReason ?? 'release evidence was not captured',
            structuredRedactionSecrets,
          ),
          exitCode: processResult.exitCode,
          signal: processResult.signal,
          timedOut: processResult.timedOut,
          spawnError: processResult.spawnError,
          processTreeStrategy: processResult.processTreeStrategy,
          cleanupConfirmed: processResult.cleanupConfirmed,
        }
  const boundary = boundaryForCheck({ cwd, processResult, identity, requirementIds })
  return {
    id: checkId,
    category,
    required: true,
    command,
    cwd,
    environment: environmentId,
    startedAt: processResult.startedAt,
    completedAt: processResult.completedAt,
    durationMs: processResult.durationMs,
    attempt,
    exitCode: processResult.exitCode,
    result,
    buildSha256: identity.tarballSha256,
    measurements: evidence.measurements,
    stdout: undefined,
    stderr: undefined,
    failureDetails,
    argv: sanitizedArgv,
    environmentSnapshot: sanitizedEnvironment,
    boundary,
    binding: bindingForCheck(identity, requirementIds),
    logs: {
      stdout: {
        rawByteLength: processResult.stdout.rawByteLength,
        redactedSha256: processResult.stdout.redactedSha256,
        redactedByteLength: processResult.stdout.redactedByteLength,
        redactedTruncated: processResult.stdout.redactedTruncated,
        redactionFailClosed: processResult.stdout.redactionFailClosed,
      },
      stderr: {
        rawByteLength: processResult.stderr.rawByteLength,
        redactedSha256: processResult.stderr.redactedSha256,
        redactedByteLength: processResult.stderr.redactedByteLength,
        redactedTruncated: processResult.stderr.redactedTruncated,
        redactionFailClosed: processResult.stderr.redactionFailClosed,
      },
    },
    __outputBytes: { stdout: processResult.stdout.bytes, stderr: processResult.stderr.bytes },
  }
}

export function verifyBinding(check, identity, requirementIds) {
  assert(check.binding && typeof check.binding === 'object', `Check ${check.id} has no binding`)
  assert(
    canonicalJson(check.binding) === canonicalJson(bindingForCheck(identity, requirementIds)),
    `Check ${check.id} binding differs`,
  )
  assert(check.buildSha256 === identity.tarballSha256, `Check ${check.id} uses another tarball`)
  assert(
    check.boundary?.tarballSha256 === identity.tarballSha256,
    `Check ${check.id} boundary uses another tarball`,
  )
  assert(
    check.boundary?.gitCommit === identity.gitCommit,
    `Check ${check.id} boundary uses another commit`,
  )
}
