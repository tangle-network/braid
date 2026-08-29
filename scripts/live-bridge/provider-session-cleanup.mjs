import { exitCodes } from './constants.mjs'
import { requestJson } from './endpoint.mjs'
import { LiveBridgeError } from './errors.mjs'

const providerName = 'cli-bridge'

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function addBinding(sessionIds, value) {
  const candidate = record(value)
  if (candidate === undefined) return
  const controlRef = record(candidate.controlRef)
  const receipt = record(candidate.receipt)
  const provider = controlRef?.provider ?? candidate.provider ?? receipt?.provider
  const sessionId =
    controlRef?.sessionId ?? candidate.providerSessionId ?? receipt?.providerSessionId
  if (
    provider === providerName &&
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    sessionId.length <= 1_024
  ) {
    sessionIds.add(sessionId)
  }
}

export function ownedProviderSessionIds(responses) {
  const sessionIds = new Set()
  for (const response of responses ?? []) {
    addBinding(sessionIds, response?.admission)
    for (const run of response?.state?.runs ?? []) addBinding(sessionIds, run)
    addBinding(sessionIds, response?.event?.payload)
  }
  return [...sessionIds]
}

export function providerSessionReleaseResult(sessionId, response) {
  const closed = response.status === 200 && response.body?.closed === true
  const alreadyAbsent = response.status === 404
  return {
    sessionId,
    status: response.status ?? null,
    closed,
    alreadyAbsent,
    released: closed || alreadyAbsent,
  }
}

export async function closeOwnedProviderSessions({ endpoint, responses, token, timeoutMs }) {
  const sessionIds = ownedProviderSessionIds(responses)
  const admitted = (responses ?? []).some(
    (response) => response?.type === 'ack' && typeof response.runId === 'string',
  )
  if (admitted && sessionIds.length === 0) {
    throw new LiveBridgeError(
      'LIVE_PROVIDER_SESSION_BINDING_MISSING',
      'An admitted packed run did not expose its exact provider session for cleanup',
      exitCodes.failed,
    )
  }

  const results = []
  for (const sessionId of sessionIds) {
    const response = await requestJson(
      endpoint,
      `/v1/sessions/${encodeURIComponent(sessionId)}/close`,
      token,
      Math.min(timeoutMs, 30_000),
      { method: 'POST' },
    )
    results.push(providerSessionReleaseResult(sessionId, response))
  }
  const failed = results.filter((result) => result.released !== true)
  if (failed.length > 0) {
    throw new LiveBridgeError(
      'LIVE_PROVIDER_SESSION_CLEANUP_FAILED',
      'CLI Bridge did not close every provider session owned by the packed proof',
      exitCodes.failed,
      { failures: failed },
    )
  }
  return {
    attempted: results.length,
    closed: results.filter((result) => result.closed).length,
    alreadyAbsent: results.filter((result) => result.alreadyAbsent).length,
    released: results.length,
    complete: true,
    results,
  }
}
