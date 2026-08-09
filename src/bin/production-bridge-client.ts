import {
  appendHealthPath,
  normalizeCliBridgeRuntimeBaseUrl,
  stripCliBridgeVersion,
} from '../adapters/connections/production-connection-endpoints.js'
import { redactSensitiveText } from '../domain/redaction.js'

export const DEFAULT_BRIDGE_DISCOVERY_TIMEOUT_MS = 10_000
export const DEFAULT_MODEL_VALIDATION_TIMEOUT_MS = 60_000
export const MAX_BRIDGE_DISCOVERY_BODY_BYTES = 1024 * 1024
export const MAX_MODEL_VALIDATION_BODY_BYTES = 1024 * 1024

export type BridgeRequestErrorCode =
  | 'BRIDGE_ENDPOINT_INVALID'
  | 'BRIDGE_TIMEOUT'
  | 'BRIDGE_UNREACHABLE'
  | 'BRIDGE_RESPONSE_TOO_LARGE'
  | 'BRIDGE_RESPONSE_UNREADABLE'

export class ProductionBridgeRequestError extends Error {
  readonly code: BridgeRequestErrorCode
  readonly endpoint: string

  constructor(code: BridgeRequestErrorCode, endpoint: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProductionBridgeRequestError'
    this.code = code
    this.endpoint = endpoint
  }
}

export interface BridgeResponse {
  readonly status: number
  readonly ok: boolean
  readonly body: string
}

export interface BridgeRequestOptions {
  readonly endpoint: string
  readonly path: 'health' | 'models' | 'chat/completions'
  readonly fetcher?: typeof fetch
  /** An in-memory bearer token; it is never part of a connection record or error. */
  readonly auth?: string
  readonly timeoutMs: number
  readonly maxBodyBytes: number
  readonly init?: Omit<RequestInit, 'signal' | 'headers'> & {
    readonly headers?: Readonly<Record<string, string>>
  }
}

function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return '<invalid bridge endpoint>'
    }
    return url.toString().replace(/\/$/u, '')
  } catch {
    return '<invalid bridge endpoint>'
  }
}

export function normalizeBridgeEndpoint(endpoint: string): string {
  const display = safeEndpoint(endpoint)
  if (display === '<invalid bridge endpoint>') {
    throw new ProductionBridgeRequestError(
      'BRIDGE_ENDPOINT_INVALID',
      display,
      'The selected CLI Bridge endpoint must be an HTTP(S) URL without credentials, query, or fragment data',
    )
  }
  try {
    return normalizeCliBridgeRuntimeBaseUrl(endpoint)
  } catch (error) {
    throw new ProductionBridgeRequestError(
      'BRIDGE_ENDPOINT_INVALID',
      display,
      'The selected CLI Bridge endpoint is not a safe HTTP(S) URL',
      error,
    )
  }
}

export function displayBridgeEndpoint(endpoint: string): string {
  return safeEndpoint(endpoint)
}

function bridgeUrl(endpoint: string, path: BridgeRequestOptions['path']): string {
  const base = normalizeBridgeEndpoint(endpoint)
  if (path === 'health') return appendHealthPath(stripCliBridgeVersion(base))
  return `${base}/${path}`
}

function authorizationHeader(auth: string | undefined): string | undefined {
  const value = auth?.trim()
  if (!value) return undefined
  return /^(?:Bearer|Basic)\s+/iu.test(value) ? value : `Bearer ${value}`
}

function timeoutValue(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError('Bridge request timeout must be a positive integer')
  }
  return timeoutMs
}

async function readBoundedBody(
  response: Response,
  maxBodyBytes: number,
  endpoint: string,
): Promise<string> {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new RangeError('Bridge response body limit must be a non-negative integer')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk = next.value
      total += chunk.byteLength
      if (total > maxBodyBytes) {
        await reader.cancel('response body limit exceeded').catch(() => undefined)
        throw new ProductionBridgeRequestError(
          'BRIDGE_RESPONSE_TOO_LARGE',
          endpoint,
          `The CLI Bridge response at ${endpoint} exceeded the ${maxBodyBytes}-byte limit`,
        )
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof ProductionBridgeRequestError) throw error
    throw new ProductionBridgeRequestError(
      'BRIDGE_RESPONSE_UNREADABLE',
      endpoint,
      `The CLI Bridge response at ${endpoint} could not be read`,
      error,
    )
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString('utf8')
}

/** Performs one bounded bridge request; discovery and validation share this boundary. */
export async function requestBridge(options: BridgeRequestOptions): Promise<BridgeResponse> {
  const timeoutMs = timeoutValue(options.timeoutMs)
  const endpoint = displayBridgeEndpoint(options.endpoint)
  let url: string
  try {
    url = bridgeUrl(options.endpoint, options.path)
  } catch (error) {
    if (error instanceof ProductionBridgeRequestError) throw error
    throw new ProductionBridgeRequestError(
      'BRIDGE_ENDPOINT_INVALID',
      endpoint,
      'The selected CLI Bridge endpoint is invalid',
      error,
    )
  }
  const request = options.fetcher ?? globalThis.fetch
  if (typeof request !== 'function') {
    throw new ProductionBridgeRequestError(
      'BRIDGE_UNREACHABLE',
      endpoint,
      `The CLI Bridge at ${endpoint} cannot be queried in this runtime`,
    )
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  const auth = authorizationHeader(options.auth)
  try {
    let response: Response
    try {
      response = await request(url, {
        ...(options.init ?? {}),
        headers: {
          Accept: 'application/json',
          ...(options.init?.headers ?? {}),
          ...(auth === undefined ? {} : { Authorization: auth }),
        },
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProductionBridgeRequestError(
          'BRIDGE_TIMEOUT',
          endpoint,
          `The CLI Bridge request to ${endpoint} timed out after ${timeoutMs} ms`,
          error,
        )
      }
      throw new ProductionBridgeRequestError(
        'BRIDGE_UNREACHABLE',
        endpoint,
        `The CLI Bridge at ${endpoint} could not be reached`,
        error,
      )
    }
    const body = await readBoundedBody(response, options.maxBodyBytes, endpoint)
    return { status: response.status, ok: response.ok, body }
  } finally {
    clearTimeout(timeout)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Extracts only short provider fields, after redaction and without returning raw bodies. */
export function safeBridgeDetail(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (!isRecord(parsed)) return undefined
    const error = isRecord(parsed.error) ? parsed.error : parsed
    const pieces = [error.code, error.type, error.message].filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    )
    if (pieces.length === 0) return undefined
    const detail = redactSensitiveText(pieces.join(': '), 256)
      .replace(/[\r\n]+/gu, ' ')
      .trim()
    return detail.length > 0 ? detail : undefined
  } catch {
    return undefined
  }
}
