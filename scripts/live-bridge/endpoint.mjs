import { exitCodes } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { evidenceValue, redactString } from './redaction.mjs'

export function safeEndpoint(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch (error) {
    throw new LiveBridgeError(
      'BRIDGE_URL_INVALID',
      'CLI Bridge URL must be an absolute http(s) URL without embedded credentials',
      exitCodes.unavailable,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new LiveBridgeError(
      'BRIDGE_URL_INVALID',
      'CLI Bridge URL must be an absolute http(s) URL without embedded credentials',
      exitCodes.unavailable,
    )
  }
  if (parsed.search || parsed.hash) {
    throw new LiveBridgeError(
      'BRIDGE_URL_INVALID',
      'CLI Bridge URL must not contain query or fragment data',
      exitCodes.unavailable,
    )
  }
  return parsed.toString().replace(/\/$/u, '')
}

export function endpointForEvidence(endpoint) {
  const parsed = new URL(endpoint)
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/u, '')}`
}

export function unknownEndpointForEvidence(raw) {
  try {
    return endpointForEvidence(safeEndpoint(raw))
  } catch {
    return redactString(raw)
      .replace(/(https?:\/\/)([^/@:]+):([^/@]+)@/iu, '$1[redacted]@')
      .replace(
        /([?&](?:token|api[-_]?key|secret|password|authorization|credential)=)[^&\s]+/giu,
        '$1[redacted]',
      )
  }
}

export function isLoopback(endpoint) {
  const hostname = new URL(endpoint).hostname.toLowerCase()
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

export function bridgeAuthToken() {
  return (
    process.env.BRAID_CLI_BRIDGE_BEARER ??
    process.env.CLI_BRIDGE_BEARER ??
    process.env.BRIDGE_BEARER
  )
}

export async function requestJson(endpoint, path, token, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${endpoint}${path}`, {
      headers: {
        accept: 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: controller.signal,
    })
    const text = await response.text()
    let body
    try {
      body = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      body = undefined
    }
    return {
      status: response.status,
      ok: response.ok,
      body: evidenceValue(body),
      text: redactString(text).slice(0, 64_000),
    }
  } catch (error) {
    return {
      status: undefined,
      ok: false,
      error: redactString(error instanceof Error ? error.message : String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

export function healthIsStructurallyValid(response) {
  if (!response.ok || !response.body || typeof response.body !== 'object') return false
  if (response.body.status !== 'ok') return false
  const backends = response.body.backends
  return (
    Array.isArray(backends) &&
    backends.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.name === 'string' &&
        typeof item.state === 'string',
    )
  )
}

export function healthBackendsReady(response, requiredBackends) {
  if (!healthIsStructurallyValid(response)) return false
  return requiredBackends.every((required) =>
    response.body.backends.some(
      (backend) => backend.name === required && backend.state === 'ready',
    ),
  )
}

export function modelIds(response) {
  if (!response.ok || !response.body || typeof response.body !== 'object') return []
  if (!Array.isArray(response.body.data)) return []
  return response.body.data
    .map((item) => (item && typeof item.id === 'string' ? item.id : undefined))
    .filter((id) => id !== undefined)
}
