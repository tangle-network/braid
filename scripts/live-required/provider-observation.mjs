import { NetworkError, QuotaError, ServerError, TimeoutError } from '@tangle-network/sandbox'

import { sleep } from '../live-bridge/process.mjs'

export const PROVIDER_OBSERVATION_INTERVAL_MS = 500

function transientDelay(error, intervalMs) {
  if (error instanceof QuotaError) {
    return Math.max(intervalMs, error.retryAfterMs ?? 0)
  }
  if (error instanceof NetworkError || error instanceof TimeoutError) return intervalMs
  if (error instanceof ServerError && [502, 503, 504].includes(error.status)) return intervalMs
  return undefined
}

export async function waitForProviderObservation(
  label,
  observe,
  timeoutMs,
  {
    intervalMs = PROVIDER_OBSERVATION_INTERVAL_MS,
    now = () => performance.now(),
    pause = sleep,
  } = {},
) {
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('provider observation label is required')
  }
  if (typeof observe !== 'function') throw new TypeError('provider observer is required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('provider observation timeout must be positive')
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError('provider observation interval must be positive')
  }

  const deadline = now() + timeoutMs
  let attempts = 0
  let transientFailures = 0
  let lastTransientError
  for (;;) {
    if (attempts > 0 && now() >= deadline) {
      throw new Error(
        `${label} timed out after ${timeoutMs}ms (${attempts} attempts, ${transientFailures} transient failures)`,
        { cause: lastTransientError },
      )
    }
    attempts += 1
    let delayMs = intervalMs
    try {
      const value = await observe()
      if (value) return value
    } catch (error) {
      const retryDelayMs = transientDelay(error, intervalMs)
      if (retryDelayMs === undefined) throw error
      transientFailures += 1
      lastTransientError = error
      delayMs = retryDelayMs
    }

    const observedAt = now()
    if (observedAt >= deadline) continue
    await pause(Math.min(delayMs, Math.max(0, deadline - observedAt)))
  }
}
