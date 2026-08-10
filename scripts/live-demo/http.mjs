import assert from 'node:assert/strict'

export const LIVE_DEMO_HTTP_TIMEOUT_MS = 10_000

export async function jsonRequest(url, timeoutMs = LIVE_DEMO_HTTP_TIMEOUT_MS) {
  assert.equal(typeof url, 'string', 'Live demo HTTP URL must be text')
  assert.ok(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= LIVE_DEMO_HTTP_TIMEOUT_MS,
    `Live demo HTTP timeout must be an integer from 1 to ${LIVE_DEMO_HTTP_TIMEOUT_MS}ms`,
  )
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`)
  return response.json()
}
