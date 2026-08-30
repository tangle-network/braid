import { NetworkError, QuotaError, ServerError, TimeoutError } from '@tangle-network/sandbox'

import { sleep } from '../live-bridge/process.mjs'

export const PROVIDER_OBSERVATION_INTERVAL_MS = 500
const defaultNow = () => performance.now()

function transientDelay(error, intervalMs) {
  if (error instanceof QuotaError) {
    const retryAfterMs =
      Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : 0
    return Math.max(intervalMs, retryAfterMs)
  }
  if (error instanceof NetworkError || error instanceof TimeoutError) return intervalMs
  if (error instanceof ServerError && [502, 503, 504].includes(error.status)) return intervalMs
  return undefined
}

function validateLabel(label) {
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('provider observation label is required')
  }
}

function validateTimeout(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('provider observation timeout must be positive')
  }
}

function validateNow(now) {
  if (typeof now !== 'function') throw new TypeError('provider observation clock is required')
}

export function createProviderObservationDeadline(label, timeoutMs, { now = defaultNow } = {}) {
  validateLabel(label)
  validateTimeout(timeoutMs)
  validateNow(now)
  const startedAt = now()
  if (!Number.isFinite(startedAt)) {
    throw new RangeError('provider observation clock must return a finite number')
  }
  return Object.freeze({
    label,
    timeoutMs,
    deadline: startedAt + timeoutMs,
    now,
  })
}

function validateDeadline(deadline) {
  if (
    deadline === null ||
    typeof deadline !== 'object' ||
    !Number.isFinite(deadline.deadline) ||
    !Number.isFinite(deadline.timeoutMs) ||
    deadline.timeoutMs <= 0 ||
    typeof deadline.now !== 'function'
  ) {
    throw new TypeError('provider observation deadline is invalid')
  }
}

function timeoutError(deadline, label, attempts, transientFailures, lastTransientError, stage) {
  const suffix =
    stage === undefined
      ? ''
      : `; ${stage === 'operation' ? 'provider operation' : stage} exceeded deadline`
  const error = new Error(
    `${label} timed out after ${deadline.timeoutMs}ms (${attempts} attempts, ${transientFailures} transient failures)${suffix}`,
    lastTransientError === undefined ? undefined : { cause: lastTransientError },
  )
  error.code = 'PROVIDER_OBSERVATION_TIMEOUT'
  error.deadline = deadline.deadline
  error.attempts = attempts
  error.transientFailures = transientFailures
  return error
}

function assertBeforeDeadline(
  deadline,
  label,
  attempts,
  transientFailures,
  lastTransientError,
  stage,
) {
  const now = deadline.now()
  if (!Number.isFinite(now)) {
    throw new RangeError('provider observation clock must return a finite number')
  }
  if (now >= deadline.deadline) {
    throw timeoutError(deadline, label, attempts, transientFailures, lastTransientError, stage)
  }
  return now
}

export function assertProviderObservationDeadline(deadline, label, stage = 'operation') {
  validateLabel(label)
  validateDeadline(deadline)
  return assertBeforeDeadline(deadline, label, 0, 0, undefined, stage)
}

export async function waitForProviderObservation(
  label,
  observe,
  timeoutMs,
  {
    intervalMs = PROVIDER_OBSERVATION_INTERVAL_MS,
    now = defaultNow,
    pause = sleep,
    deadline: providedDeadline,
  } = {},
) {
  validateLabel(label)
  if (typeof observe !== 'function') throw new TypeError('provider observer is required')
  if (providedDeadline === undefined) validateTimeout(timeoutMs)
  else validateDeadline(providedDeadline)
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('provider observation interval must be positive')
  }
  if (typeof pause !== 'function') throw new TypeError('provider observation pause is required')

  const deadline = providedDeadline ?? createProviderObservationDeadline(label, timeoutMs, { now })
  let attempts = 0
  let transientFailures = 0
  let lastTransientError
  for (;;) {
    assertBeforeDeadline(deadline, label, attempts, transientFailures, lastTransientError)
    attempts += 1
    let delayMs = intervalMs
    let value
    try {
      value = await observe()
    } catch (error) {
      if (deadline.now() >= deadline.deadline) {
        throw timeoutError(deadline, label, attempts, transientFailures, error, 'operation')
      }
      const retryDelayMs = transientDelay(error, intervalMs)
      if (retryDelayMs === undefined) throw error
      transientFailures += 1
      lastTransientError = error
      delayMs = retryDelayMs
    }

    const observedAt = assertBeforeDeadline(
      deadline,
      label,
      attempts,
      transientFailures,
      lastTransientError,
      'operation',
    )
    if (value !== undefined) return value

    await pause(Math.min(delayMs, deadline.deadline - observedAt))
    assertBeforeDeadline(
      deadline,
      label,
      attempts,
      transientFailures,
      lastTransientError,
      'retry delay',
    )
  }
}
