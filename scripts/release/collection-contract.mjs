import { createHash } from 'node:crypto'

import {
  canonicalJson,
  validateMeasurements,
  validatePerformanceMatrix,
} from '../release-evidence.mjs'
import { bindingForCheck } from './build-identity.mjs'
import { redactText } from './command-runner.mjs'

const STRUCTURED_CATEGORIES = new Set(['eval', 'live', 'performance'])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(value) {
  return createHash('sha256')
    .update(Buffer.from(canonicalJson(value)))
    .digest('hex')
}

function unavailableMeasurement(category, reason) {
  return {
    kind: 'uncaptured',
    name: `${category}-evidence`,
    reason: redactText(reason),
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

function unavailableEvidence(category, reason, result = 'uncaptured') {
  const safeReason = redactText(reason)
  return {
    result,
    measurements: [unavailableMeasurement(category, safeReason)],
    reason: safeReason,
  }
}

function resultMarkerValue(category, values) {
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
  return value
}

export function structuredChildEvidence(category, stdoutBytes, durationMs, checkId) {
  const text = Buffer.from(stdoutBytes).toString('utf8')
  let resultMarker
  let measurementMarkers
  try {
    resultMarker = resultMarkerValue(category, markers(text, 'BRAID_RELEASE_RESULT_JSON='))
    measurementMarkers = markers(text, 'BRAID_RELEASE_MEASUREMENTS_JSON=')
  } catch (error) {
    return unavailableEvidence(category, error.message)
  }
  if (!STRUCTURED_CATEGORIES.has(category)) {
    if (measurementMarkers.length > 0) {
      return unavailableEvidence(category, `${category} emitted an unexpected measurement marker`)
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
      return unavailableEvidence(
        category,
        resultMarker.reason ?? 'The check reported unavailable',
        'unavailable',
      )
    if (resultMarker.status === 'failed')
      return unavailableEvidence(
        category,
        resultMarker.reason ?? 'The check reported failed',
        'failed',
      )
    return unavailableEvidence(
      category,
      `Unknown ${category} result status: ${resultMarker.status}`,
    )
  }
  if (!resultMarker)
    return unavailableEvidence(
      category,
      `${category} command completed without BRAID_RELEASE_RESULT_JSON`,
    )
  if (resultMarker.status === 'unavailable') {
    if (measurementMarkers.length > 0)
      return unavailableEvidence(
        category,
        `${category} reported unavailable and measurements together`,
      )
    return unavailableEvidence(
      category,
      resultMarker.reason ?? 'The check reported unavailable',
      'unavailable',
    )
  }
  if (resultMarker.status === 'failed') {
    if (measurementMarkers.length > 0)
      return unavailableEvidence(category, `${category} reported failed and measurements together`)
    return unavailableEvidence(
      category,
      resultMarker.reason ?? 'The check reported failed',
      'failed',
    )
  }
  if (resultMarker.status !== 'passed')
    return unavailableEvidence(
      category,
      `Unknown ${category} result status: ${resultMarker.status}`,
    )
  if (measurementMarkers.length !== 1)
    return unavailableEvidence(category, `${category} must emit exactly one measurement marker`)
  let evidence
  try {
    evidence = measurementMarkers[0]
  } catch (error) {
    return unavailableEvidence(category, error.message)
  }
  const measurements = Array.isArray(evidence) ? evidence : evidence.measurements
  try {
    if (category === 'performance') validatePerformanceMatrix(measurements, 'Performance evidence')
    else validateMeasurements(measurements, `${category} evidence`)
  } catch (error) {
    return unavailableEvidence(category, error.message)
  }
  let selectedMeasurements = measurements
  if (/^(LIVE|PERF|EVAL)-[0-9]{2}$/u.test(checkId)) {
    selectedMeasurements = measurements.filter((measurement) => measurement.name === checkId)
    if (selectedMeasurements.length !== 1)
      return unavailableEvidence(category, `${checkId} emitted no unique matching measurement`)
  }
  if (
    selectedMeasurements.some(
      (measurement) => measurement.kind === 'unavailable' || measurement.kind === 'uncaptured',
    )
  ) {
    return unavailableEvidence(
      category,
      `${category} evidence contains an unavailable or uncaptured measurement`,
    )
  }
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
}) {
  const evidence = structuredChildEvidence(
    category,
    processResult.stdout.bytes,
    processResult.durationMs,
    checkId,
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
          reason: redactText(failureReason ?? 'release evidence was not captured'),
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
        rawSha256: processResult.stdout.rawSha256,
        rawByteLength: processResult.stdout.rawByteLength,
        redactedSha256: processResult.stdout.redactedSha256,
        redactedByteLength: processResult.stdout.redactedByteLength,
        redactedTruncated: processResult.stdout.redactedTruncated,
        redactionFailClosed: processResult.stdout.redactionFailClosed,
      },
      stderr: {
        rawSha256: processResult.stderr.rawSha256,
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
