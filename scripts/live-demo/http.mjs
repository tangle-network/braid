import assert from 'node:assert/strict'
import { setTimeout as pause } from 'node:timers/promises'

export const LIVE_DEMO_HTTP_TIMEOUT_MS = 10_000

export class HttpResponseError extends Error {
  constructor(url, status) {
    super(`${url} returned HTTP ${status}`)
    this.name = 'HttpResponseError'
    this.status = status
  }
}

export async function jsonRequest(url, timeoutMs = LIVE_DEMO_HTTP_TIMEOUT_MS) {
  assert.equal(typeof url, 'string', 'Live demo HTTP URL must be text')
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIVE_DEMO_HTTP_TIMEOUT_MS,
    `Live demo HTTP timeout must be an integer from 1 to ${LIVE_DEMO_HTTP_TIMEOUT_MS}ms`,
  )
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new HttpResponseError(url, response.status)
  return response.json()
}

export async function pollJsonRequest(url, timeoutMs = LIVE_DEMO_HTTP_TIMEOUT_MS) {
  try {
    return await jsonRequest(url, timeoutMs)
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return undefined
    throw error
  }
}

export async function bridgeSetupJsonRequest(url) {
  let failure = 'timed out'
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const value = await pollJsonRequest(url)
      if (value !== undefined) return value
      failure = 'timed out'
    } catch (error) {
      if (!(error instanceof HttpResponseError) || ![502, 503, 504].includes(error.status)) {
        throw error
      }
      failure = `returned HTTP ${error.status}`
    }
    process.stderr.write(`GET ${url} ${failure}; setup attempt ${attempt}/3\n`)
    if (attempt < 3) await pause(500)
  }
  throw new Error(`GET ${url} ${failure} during Bridge setup`)
}
