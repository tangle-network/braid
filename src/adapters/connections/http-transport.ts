import type { ConnectionRecord } from '../../connection/connections.js'
import {
  parseCredentialReference,
  type CredentialReference,
  type CredentialStore,
} from '../../connection/credentials.js'
import {
  containsControlCharacters,
  redactErrorMessage,
  redactProviderText,
  redactProviderValue,
} from '../../connection/redaction.js'
import {
  cloneBoundedProfileValue,
  parseBoundedProfileJson,
  ProfileJsonLimitError,
  type ProfileJsonLimits,
} from '../../profile/profile-json.js'

export interface ConnectionHttpResponse {
  readonly status: number
  readonly payload: unknown
  readonly providerVersion?: string
}

export interface ConnectionHttpRequest {
  readonly connection: ConnectionRecord
  /** Optional provider-owned endpoint, such as a validated router base URL. */
  readonly endpoint?: string
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly body?: unknown
  readonly bearer?: string
  /** `null` deliberately disables fallback to the connection's generic reference. */
  readonly credentialReference?: CredentialReference | null
  /** Validate raw JSON before any redaction or truncation. */
  readonly payloadValidator?: (payload: unknown) => unknown
  readonly signal?: AbortSignal
}

export interface ConnectionHttpTransport {
  request(input: ConnectionHttpRequest): Promise<ConnectionHttpResponse>
}

export interface HttpTransportLimits {
  /** Whole-request deadline including body read. */
  readonly timeoutMs: number
  /** Largest response body Braid will buffer. */
  readonly maxResponseBytes: number
  /** Largest request body Braid will send. */
  readonly maxRequestBytes: number
}

export const HTTP_TRANSPORT_LIMITS: HttpTransportLimits = Object.freeze({
  timeoutMs: 10_000,
  maxResponseBytes: 1_048_576,
  maxRequestBytes: 1_048_576,
})

export interface FetchTransportOptions {
  readonly credentials?: CredentialStore
  readonly fetchImpl?: typeof fetch
  readonly limits?: Partial<HttpTransportLimits>
}

export class ProviderResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Provider response exceeded ${limit} bytes`)
    this.name = 'ProviderResponseTooLargeError'
  }
}

export class ProviderRequestTooLargeError extends Error {
  constructor(limit: number) {
    super(`Provider request exceeded ${limit} bytes`)
    this.name = 'ProviderRequestTooLargeError'
  }
}

export class ProviderPayloadError extends Error {
  constructor(detail: string) {
    super(`Provider response payload is invalid: ${detail}`)
    this.name = 'ProviderPayloadError'
  }
}

export class ProviderContentTypeError extends Error {
  constructor(contentType: string | null) {
    super(
      `Provider response must use JSON content-type${
        contentType === null
          ? ''
          : `, received ${redactProviderText(contentType, 128) ?? 'unknown'}`
      }`,
    )
    this.name = 'ProviderContentTypeError'
  }
}

export class ProviderRedirectError extends Error {
  constructor(status?: number) {
    super(
      status === undefined
        ? 'Provider request attempted a redirect'
        : `Provider request returned redirect status ${status}`,
    )
    this.name = 'ProviderRedirectError'
  }
}

export class ProviderRequestAbortedError extends Error {
  constructor() {
    super('Provider request was cancelled')
    this.name = 'ProviderRequestAbortedError'
  }
}

export class ProviderRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider request exceeded ${timeoutMs}ms`)
    this.name = 'ProviderRequestTimeoutError'
  }
}

export class ProviderOriginError extends Error {
  readonly path: string

  constructor(path: string, origin: string) {
    const safePath = redactProviderText(path, 256) ?? '<invalid>'
    super(`Provider path ${safePath} does not stay on the configured origin ${origin}`)
    this.name = 'ProviderOriginError'
    this.path = safePath
  }
}

function isTransportError(error: unknown): error is Error {
  return (
    error instanceof ProviderPayloadError ||
    error instanceof ProviderContentTypeError ||
    error instanceof ProviderRedirectError ||
    error instanceof ProviderResponseTooLargeError ||
    error instanceof ProviderRequestTooLargeError ||
    error instanceof ProviderRequestTimeoutError ||
    error instanceof ProviderRequestAbortedError ||
    error instanceof ProviderOriginError
  )
}

/**
 * Resolve a provider path against the configured endpoint.
 *
 * `new URL(path, endpoint)` treats an absolute URL in `path` as a full override,
 * so a provider-supplied path of `https://other.example/steal` would send the
 * connection's bearer credential to a third party. Only endpoint-relative paths
 * are accepted, and the composed URL must still sit under the endpoint's origin
 * and base path.
 */
export function resolveProviderUrl(endpoint: string, path: string): URL {
  if (typeof endpoint !== 'string' || typeof path !== 'string') {
    throw new ProviderOriginError('<invalid>', '<invalid origin>')
  }
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    throw new ProviderOriginError(endpoint, '<invalid origin>')
  }
  if (
    (base.protocol !== 'http:' && base.protocol !== 'https:') ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new ProviderOriginError(endpoint, '<invalid origin>')
  }
  if (
    path.length === 0 ||
    path.length > 2_048 ||
    containsControlCharacters(path) ||
    path.includes('?') ||
    path.includes('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) ||
    path.startsWith('//')
  ) {
    throw new ProviderOriginError(path, base.origin)
  }
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, new URL(basePath, base))
  if (url.origin !== base.origin || !url.pathname.startsWith(basePath)) {
    throw new ProviderOriginError(path, base.origin)
  }
  if (url.username || url.password) throw new ProviderOriginError(path, base.origin)
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    throw new ProviderOriginError(path, base.origin)
  }
  if (decodedPath.split('/').some((part) => part === '..')) {
    throw new ProviderOriginError(path, base.origin)
  }
  return url
}

async function readBoundedText(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ProviderPayloadError('content-length is invalid')
    }
    if (bytes > limit) throw new ProviderResponseTooLargeError(limit)
  }
  const body = response.body
  if (body === null) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', cancelOnAbort, { once: true })
  try {
    if (signal?.aborted === true) throw new ProviderRequestAbortedError()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > limit) throw new ProviderResponseTooLargeError(limit)
      chunks.push(value)
    }
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort)
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(merged)
  } catch {
    throw new ProviderPayloadError('body is not valid UTF-8')
  }
}

/**
 * Bounded HTTP transport. Every request carries a deadline, propagates the
 * caller's abort signal, refuses to leave the configured origin, and caps both
 * the request and response body.
 */
export class FetchConnectionHttpTransport implements ConnectionHttpTransport {
  readonly #credentials: CredentialStore | undefined
  readonly #fetch: typeof fetch
  readonly #limits: HttpTransportLimits

  constructor(options: FetchTransportOptions = {}) {
    this.#credentials = options.credentials
    this.#fetch = options.fetchImpl ?? fetch
    const limits = { ...HTTP_TRANSPORT_LIMITS, ...(options.limits ?? {}) }
    if (
      !Number.isSafeInteger(limits.timeoutMs) ||
      limits.timeoutMs <= 0 ||
      !Number.isSafeInteger(limits.maxResponseBytes) ||
      limits.maxResponseBytes < 0 ||
      !Number.isSafeInteger(limits.maxRequestBytes) ||
      limits.maxRequestBytes < 0
    ) {
      throw new Error('HTTP transport limits must be finite, bounded, and non-negative')
    }
    this.#limits = Object.freeze(limits)
  }

  async request(input: ConnectionHttpRequest): Promise<ConnectionHttpResponse> {
    const endpoint = input.endpoint ?? input.connection.endpoint
    if (endpoint === undefined) throw new Error('Connection has no endpoint')
    const url = resolveProviderUrl(endpoint, input.path)
    let serialized: string | undefined
    try {
      const boundedBody =
        input.body === undefined
          ? undefined
          : cloneBoundedProfileValue(input.body, requestLimits(this.#limits.maxRequestBytes))
      serialized = boundedBody === undefined ? undefined : JSON.stringify(boundedBody)
    } catch (error) {
      if (error instanceof ProfileJsonLimitError) {
        throw new ProviderRequestTooLargeError(this.#limits.maxRequestBytes)
      }
      throw new ProviderPayloadError('request body is not JSON serializable')
    }
    if (input.body !== undefined && serialized === undefined) {
      throw new ProviderPayloadError('request body is not JSON serializable')
    }
    if (
      serialized !== undefined &&
      Buffer.byteLength(serialized, 'utf8') > this.#limits.maxRequestBytes
    ) {
      throw new ProviderRequestTooLargeError(this.#limits.maxRequestBytes)
    }
    if (input.bearer !== undefined) return this.#execute(url, input, serialized, input.bearer)
    const reference =
      input.credentialReference === null
        ? undefined
        : (input.credentialReference ??
          (input.connection.credentialRef === undefined
            ? undefined
            : parseCredentialReference(input.connection.credentialRef)))
    if (reference === undefined || this.#credentials === undefined) {
      return this.#execute(url, input, serialized, undefined)
    }
    try {
      const handle = await this.#credentials.resolve(reference)
      return handle.use((bearer) => this.#execute(url, input, serialized, bearer))
    } catch (error) {
      if (isTransportError(error)) throw error
      throw new Error(redactErrorMessage(error))
    }
  }

  async #execute(
    url: URL,
    input: ConnectionHttpRequest,
    body: string | undefined,
    bearer: string | undefined,
  ): Promise<ConnectionHttpResponse> {
    const controller = new AbortController()
    let timedOut = false
    let rejectDeadline: (reason: unknown) => void = () => undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject
    })
    const timer = setTimeout(() => {
      timedOut = true
      const timeout = new ProviderRequestTimeoutError(this.#limits.timeoutMs)
      controller.abort(timeout)
      rejectDeadline(timeout)
    }, this.#limits.timeoutMs)
    const abortFromCaller = (): void => {
      controller.abort(input.signal?.reason)
    }
    input.signal?.addEventListener('abort', abortFromCaller, { once: true })
    try {
      if (input.signal?.aborted === true) abortFromCaller()
      const response = await Promise.race([
        this.#fetch(url, {
          method: input.method,
          redirect: 'error',
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
          },
          ...(body === undefined ? {} : { body }),
        }),
        deadline,
      ])
      if (response.status >= 300 && response.status < 400) {
        throw new ProviderRedirectError(response.status)
      }
      const text = await Promise.race([
        readBoundedText(response, this.#limits.maxResponseBytes, controller.signal),
        deadline,
      ])
      if (controller.signal.aborted) {
        if (timedOut) throw new ProviderRequestTimeoutError(this.#limits.timeoutMs)
        throw new ProviderRequestAbortedError()
      }
      if (text.length > 0 && !isJsonContentType(response.headers.get('content-type'))) {
        throw new ProviderContentTypeError(response.headers.get('content-type'))
      }
      const providerVersion = redactProviderText(
        response.headers.get('x-provider-version') ?? '',
        128,
        bearer === undefined ? [] : [bearer],
      )
      return Object.freeze({
        status: response.status,
        payload:
          input.payloadValidator === undefined || response.status < 200 || response.status >= 300
            ? redactProviderValue(
                parsePayload(text, this.#limits.maxResponseBytes),
                0,
                bearer === undefined ? [] : [bearer],
              )
            : input.payloadValidator(parsePayload(text, this.#limits.maxResponseBytes)),
        ...(providerVersion === undefined ? {} : { providerVersion }),
      })
    } catch (error) {
      if (timedOut) throw new ProviderRequestTimeoutError(this.#limits.timeoutMs)
      if (input.signal?.aborted === true) throw new ProviderRequestAbortedError()
      if (isTransportError(error)) throw error
      if (error instanceof TypeError && /redirect/iu.test(error.message)) {
        throw new ProviderRedirectError()
      }
      throw new Error(redactErrorMessage(error, bearer === undefined ? [] : [bearer]))
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
  return (
    mediaType === 'application/json' ||
    (mediaType?.startsWith('application/') === true && mediaType.endsWith('+json'))
  )
}

function parsePayload(text: string, maxBytes: number): unknown {
  if (text.length === 0) return undefined
  try {
    return parseBoundedProfileJson(text, responseLimits(maxBytes))
  } catch {
    throw new ProviderPayloadError('body is not valid JSON')
  }
}

function requestLimits(maxBytes: number): ProfileJsonLimits {
  return {
    maxBytes,
    maxDepth: 32,
    maxNodes: 20_000,
    maxStringLength: Math.min(maxBytes, 262_144),
    maxEntries: 4_096,
  }
}

function responseLimits(maxBytes: number): ProfileJsonLimits {
  return requestLimits(maxBytes)
}
