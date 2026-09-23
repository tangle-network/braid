const TRANSIENT_PROVIDER_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504])
const TRANSIENT_PROVIDER_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'NETWORK_ERROR',
])
const TRANSIENT_PROVIDER_MESSAGE_PATTERN = /\b(?:fetch failed|network error|socket hang up|connection reset|timed out)\b/iu

export const READ_ONLY_PROVIDER_MAX_RETRIES = 4
export const READ_ONLY_PROVIDER_RETRY_BASE_MS = 100
export const READ_ONLY_PROVIDER_RETRY_MAX_BACKOFF_MS = 500

function finiteInteger(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const parsed = Number(value)
    if (Number.isSafeInteger(parsed)) return parsed
  }
  return undefined
}

function publicText(value, limit = 128) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const withoutQuery = value.replace(/[?#].*$/u, '')
  const printable = withoutQuery.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '?')
  return printable.slice(0, limit) || undefined
}

function publicEndpoint(value) {
  const text = publicText(value)
  if (text === undefined) return undefined
  try {
    return new URL(text, 'https://sandbox.invalid').pathname.slice(0, 128) || '/'
  } catch {
    return text
  }
}

function errorChain(error) {
  const chain = []
  const seen = new Set()
  let candidate = error
  while (candidate !== null && typeof candidate === 'object' && !seen.has(candidate)) {
    seen.add(candidate)
    chain.push(candidate)
    if (chain.length >= 8) break
    candidate = candidate.cause
  }
  return chain
}

function errorStatus(error) {
  for (const candidate of errorChain(error)) {
    const status = finiteInteger(candidate.status ?? candidate.statusCode)
    if (status !== undefined && status >= 100 && status <= 599) return status
    if (candidate.response && typeof candidate.response === 'object') {
      const responseStatus = finiteInteger(candidate.response.status)
      if (responseStatus !== undefined && responseStatus >= 100 && responseStatus <= 599) {
        return responseStatus
      }
    }
  }
  return undefined
}

function errorField(error, field) {
  for (const candidate of errorChain(error)) {
    const value = candidate[field]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function retryAfter(error) {
  const value = errorField(error, 'retryAfterMs')
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(value, 3_600_000)
}

function errorCode(error) {
  const value = errorField(error, 'code')
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : undefined
}

/**
 * Return the provider metadata that is safe to include in a diagnostic.
 *
 * The SDK exposes these fields as public request metadata. The endpoint query
 * and fragment are removed because they can contain credentials or signatures.
 */
export function providerObservationErrorEvidence(error) {
  const status = errorStatus(error)
  const code = errorCode(error)
  const name = errorField(error, 'name')
  const origin = errorField(error, 'origin')
  const endpoint = errorField(error, 'endpoint')
  const retryAfterMs = retryAfter(error)
  return {
    ...(typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(name)
      ? { name }
      : {}),
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(publicText(origin, 64) === undefined ? {} : { origin: publicText(origin, 64) }),
    ...(publicEndpoint(endpoint) === undefined ? {} : { endpoint: publicEndpoint(endpoint) }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  }
}

function hasTransientCode(error) {
  return errorChain(error).some((candidate) => {
    const code = candidate.code
    return typeof code === 'string' && TRANSIENT_PROVIDER_ERROR_CODES.has(code.toUpperCase())
  })
}

function hasTransientMessage(error) {
  return errorChain(error).some(
    (candidate) => typeof candidate.message === 'string' && TRANSIENT_PROVIDER_MESSAGE_PATTERN.test(candidate.message),
  )
}

/**
 * Read-only provider observations may be retried on transport or service
 * pressure errors. Authentication, validation, not-found, and state errors
 * fail immediately so a broken proof cannot hide behind polling.
 */
export function isTransientProviderObservationError(error) {
  const status = errorStatus(error)
  return (
    (status !== undefined && TRANSIENT_PROVIDER_STATUS_CODES.has(status)) ||
    hasTransientCode(error) ||
    hasTransientMessage(error)
  )
}

function retryDelay(error, retryCount) {
  const retryAfterMs = retryAfter(error)
  if (retryAfterMs !== undefined) return retryAfterMs
  return Math.min(
    READ_ONLY_PROVIDER_RETRY_BASE_MS * 2 ** retryCount,
    READ_ONLY_PROVIDER_RETRY_MAX_BACKOFF_MS,
  )
}

function diagnosticLabel(label) {
  return publicText(label, 160) ?? 'provider observation'
}

export class ReadOnlyProviderObservationError extends Error {
  constructor(label, attempts, error) {
    const evidence = providerObservationErrorEvidence(error)
    super(
      `${diagnosticLabel(label)} failed after ${String(attempts)} read-only provider observation attempts: ${JSON.stringify(evidence)}`,
      { cause: error },
    )
    this.name = 'ReadOnlyProviderObservationError'
    this.code = 'BRAID_PROVIDER_OBSERVATION_FAILED'
    this.status = evidence.status
    this.origin = evidence.origin
    this.endpoint = evidence.endpoint
    this.retryAfterMs = evidence.retryAfterMs
    this.attempts = attempts
    this.observation = Object.freeze({
      label: diagnosticLabel(label),
      attempts,
      error: Object.freeze(evidence),
    })
  }
}

/**
 * Execute one read-only provider observation with a bounded transient retry.
 *
 * `deadline` is shared by the caller's polling loop, so retries cannot extend
 * the proof timeout. The optional callback receives sanitized retry evidence.
 */
export async function withReadOnlyProviderObservation(
  label,
  operation,
  {
    timeoutMs,
    deadline = undefined,
    maxRetries = READ_ONLY_PROVIDER_MAX_RETRIES,
    now = () => performance.now(),
    pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    onRetry = undefined,
  } = {},
) {
  if (typeof operation !== 'function') throw new TypeError('provider observation operation is required')
  if (deadline === undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('provider observation timeout must be positive')
    }
    deadline = now() + timeoutMs
  }
  if (!Number.isFinite(deadline)) throw new RangeError('provider observation deadline must be finite')
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new RangeError('provider observation retry limit must be a non-negative integer')
  }

  let retries = 0
  let attempts = 0
  for (;;) {
    attempts += 1
    try {
      return await operation()
    } catch (error) {
      if (!isTransientProviderObservationError(error) || retries >= maxRetries) throw error
      const remainingMs = deadline - now()
      if (remainingMs <= 0) throw new ReadOnlyProviderObservationError(label, attempts, error)
      const delayMs = retryDelay(error, retries)
      if (delayMs > remainingMs) throw new ReadOnlyProviderObservationError(label, attempts, error)
      if (typeof onRetry === 'function') {
        onRetry(
          Object.freeze({
            attempt: attempts,
            retry: retries + 1,
            delayMs,
            remainingMs,
            error: Object.freeze(providerObservationErrorEvidence(error)),
          }),
        )
      }
      await pause(delayMs)
      retries += 1
    }
  }
}
