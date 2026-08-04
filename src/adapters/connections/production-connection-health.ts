import { ConnectionError } from '../../app/connection-errors.js'
import type {
  ConnectionHealth,
  ConnectionModelVerification,
  ConnectionRecord,
  IsoDateTime,
} from '../../domain/entities.js'
import { parseCliBridgeHealth } from './cli-bridge-health.js'
import { readConnectionCredential } from './production-connection-credentials.js'
import {
  appendHealthPath,
  connectionEndpoint,
  normalizeCliBridgeRuntimeBaseUrl,
  stripCliBridgeVersion,
} from './production-connection-endpoints.js'
import { createTangleSandboxClient } from './production-connection-providers.js'
import type {
  ConnectionHealthOptions,
  ConnectionModelVerificationOptions,
  ProductionConnectionOptions,
} from './production-connection-types.js'

export async function healthForConnection(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  healthOptions: ConnectionHealthOptions,
): Promise<ConnectionHealth> {
  const checkedAt = (healthOptions.now ?? options.now ?? nowIso)()
  try {
    const endpoint = connectionEndpoint(record, options)
    if (record.kind === 'tangle-sandbox') {
      const client = (await createTangleSandboxClient(
        record,
        options,
        healthOptions.signal,
      )) as SandboxHealthClient
      return await probeSandboxHealth(client, checkedAt, healthOptions.signal)
    }
    const credential = await readConnectionCredential(record, options, endpoint)
    const healthUrl =
      record.kind === 'cli-bridge'
        ? appendHealthPath(stripCliBridgeVersion(endpoint))
        : appendHealthPath(endpoint)
    return await probeHttpHealth(
      healthUrl,
      credential,
      checkedAt,
      options.fetch,
      healthOptions.signal,
      record.kind === 'cli-bridge' ? stripCliBridgeVersion(endpoint) : undefined,
    )
  } catch (error) {
    return healthFromError(error, checkedAt)
  }
}

export async function verifyModelForConnection(
  record: ConnectionRecord,
  options: ProductionConnectionOptions,
  model: string,
  verificationOptions: ConnectionModelVerificationOptions,
): Promise<ConnectionModelVerification> {
  const checkedAt = (verificationOptions.now ?? options.now ?? nowIso)()
  const normalizedModel = model.trim()
  if (normalizedModel.length === 0) {
    return {
      model: '',
      status: 'unverified',
      checkedAt,
      message: 'No model.default is selected for this connection',
    }
  }
  if (record.kind === 'tangle-sandbox') {
    return {
      model: normalizedModel,
      status: 'unverified',
      checkedAt,
      message: 'Sandbox model verification requires an admitted environment',
    }
  }
  try {
    const endpoint = connectionEndpoint(record, options)
    const credential = await readConnectionCredential(record, options, endpoint)
    const request = options.fetch ?? globalThis.fetch
    if (typeof request !== 'function') {
      return {
        model: normalizedModel,
        status: 'unreachable',
        checkedAt,
        message: 'Model verification is unavailable in this runtime',
      }
    }
    const chatUrl =
      record.kind === 'cli-bridge'
        ? `${normalizeCliBridgeRuntimeBaseUrl(endpoint)}/chat/completions`
        : `${endpoint.replace(/\/+$/u, '')}/chat/completions`
    const response = await request(chatUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      body: JSON.stringify({
        model: normalizedModel,
        messages: [{ role: 'user', content: 'Braid connection verification. Reply with OK.' }],
        stream: false,
        max_tokens: 1,
      }),
      ...(verificationOptions.signal ? { signal: verificationOptions.signal } : {}),
    })
    const body = await response.text().catch(() => '')
    return modelVerificationFromResponse(normalizedModel, response.status, body, checkedAt)
  } catch (error) {
    return modelVerificationFromError(normalizedModel, checkedAt, error)
  }
}

interface SandboxHealthClient {
  fetch?: (path: string, options?: RequestInit) => Promise<Response>
  health?: () => Promise<boolean>
}

async function probeSandboxHealth(
  client: SandboxHealthClient,
  checkedAt: IsoDateTime,
  signal?: AbortSignal,
): Promise<ConnectionHealth> {
  if (typeof client.fetch === 'function') {
    try {
      const response = await client.fetch('/health', {
        method: 'GET',
        ...(signal ? { signal } : {}),
      })
      return healthFromStatus(response.status, checkedAt)
    } catch {
      return {
        status: 'unreachable',
        checkedAt,
        message: 'Sandbox health endpoint was unreachable',
      }
    }
  }
  if (typeof client.health === 'function') {
    try {
      return (await client.health())
        ? { status: 'healthy', checkedAt }
        : { status: 'unreachable', checkedAt, message: 'Sandbox health endpoint returned not-ok' }
    } catch {
      return {
        status: 'unreachable',
        checkedAt,
        message: 'Sandbox health endpoint was unreachable',
      }
    }
  }
  return {
    status: 'incompatible',
    checkedAt,
    message: 'The published sandbox client exposes no health operation',
  }
}

async function probeHttpHealth(
  url: string,
  credential: string | undefined,
  checkedAt: IsoDateTime,
  fetcher: typeof fetch | undefined,
  signal?: AbortSignal,
  cliBridgeEndpoint?: string,
): Promise<ConnectionHealth> {
  const request = fetcher ?? globalThis.fetch
  if (typeof request !== 'function') {
    return { status: 'unreachable', checkedAt, message: 'HTTP health checks are unavailable' }
  }
  try {
    const response = await request(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      ...(signal ? { signal } : {}),
    })
    if (cliBridgeEndpoint !== undefined) {
      const body = await response.text().catch(() => '')
      return parseCliBridgeHealth(cliBridgeEndpoint, response.status, body, checkedAt).health
    }
    return healthFromStatus(response.status, checkedAt)
  } catch {
    return { status: 'unreachable', checkedAt, message: 'Health endpoint was unreachable' }
  }
}

function healthFromStatus(status: number, checkedAt: IsoDateTime): ConnectionHealth {
  if (status >= 200 && status < 300) return { status: 'healthy', checkedAt }
  if (status === 401 || status === 403) {
    return { status: 'unauthorized', checkedAt, message: 'The connection rejected its credential' }
  }
  if (status === 429) {
    return {
      status: 'rate-limited',
      checkedAt,
      message: 'The connection rate-limited the health check',
    }
  }
  if (status === 404 || status === 405 || (status >= 400 && status < 500)) {
    return {
      status: 'incompatible',
      checkedAt,
      message: 'The connection health endpoint is incompatible',
    }
  }
  return { status: 'unreachable', checkedAt, message: 'The connection returned a server failure' }
}

function healthFromError(error: unknown, checkedAt: IsoDateTime): ConnectionHealth {
  if (error instanceof ConnectionError) {
    if (
      error.code === 'CONNECTION_CREDENTIAL_REQUIRED' ||
      error.code === 'CONNECTION_CREDENTIAL_REF_UNMAPPED' ||
      error.code === 'CONNECTION_CREDENTIAL_UNAVAILABLE' ||
      error.code === 'CONNECTION_CREDENTIAL_INVALID'
    ) {
      return {
        status: 'unauthorized',
        checkedAt,
        message: 'A usable connection credential is unavailable',
      }
    }
    if (
      error.code === 'CONNECTION_ENDPOINT_REQUIRED' ||
      error.code === 'CONNECTION_ENDPOINT_INVALID' ||
      error.code === 'CONNECTION_ENDPOINT_CONFLICT'
    ) {
      return { status: 'incompatible', checkedAt, message: 'The connection endpoint is invalid' }
    }
  }
  return { status: 'unreachable', checkedAt, message: 'The connection health check failed' }
}

function modelVerificationFromResponse(
  model: string,
  statusCode: number,
  body: string,
  checkedAt: IsoDateTime,
): ConnectionModelVerification {
  if (statusCode >= 200 && statusCode < 300) {
    return { model, status: 'verified', checkedAt, httpStatus: statusCode }
  }
  if (statusCode === 501 && /not_configured/iu.test(body)) {
    return {
      model,
      status: 'not-configured',
      checkedAt,
      code: 'not_configured',
      httpStatus: statusCode,
      message: `The bridge advertises ${model} but its backend is not configured; sign in to that backend and retry model verification`,
    }
  }
  if (statusCode === 401 || statusCode === 403) {
    return {
      model,
      status: 'unauthorized',
      checkedAt,
      httpStatus: statusCode,
      message: `The connection rejected model ${model}; configure its credential and retry`,
    }
  }
  if (statusCode === 429) {
    return {
      model,
      status: 'rate-limited',
      checkedAt,
      httpStatus: statusCode,
      message: `The connection rate-limited model ${model}; retry later`,
    }
  }
  if (statusCode === 404 || statusCode === 405 || (statusCode >= 400 && statusCode < 500)) {
    return {
      model,
      status: 'incompatible',
      checkedAt,
      httpStatus: statusCode,
      message: `The connection does not expose a compatible model operation for ${model}`,
    }
  }
  return {
    model,
    status: 'unreachable',
    checkedAt,
    httpStatus: statusCode,
    message: `The connection returned a server failure while verifying model ${model}`,
  }
}

function modelVerificationFromError(
  model: string,
  checkedAt: IsoDateTime,
  error: unknown,
): ConnectionModelVerification {
  if (error instanceof ConnectionError) {
    if (
      error.code === 'CONNECTION_CREDENTIAL_REQUIRED' ||
      error.code === 'CONNECTION_CREDENTIAL_REF_UNMAPPED' ||
      error.code === 'CONNECTION_CREDENTIAL_UNAVAILABLE' ||
      error.code === 'CONNECTION_CREDENTIAL_INVALID'
    ) {
      return {
        model,
        status: 'unauthorized',
        checkedAt,
        message: 'A usable connection credential is unavailable for model verification',
      }
    }
    if (
      error.code === 'CONNECTION_ENDPOINT_REQUIRED' ||
      error.code === 'CONNECTION_ENDPOINT_INVALID' ||
      error.code === 'CONNECTION_ENDPOINT_CONFLICT'
    ) {
      return {
        model,
        status: 'incompatible',
        checkedAt,
        message: 'The connection endpoint is invalid for model verification',
      }
    }
  }
  return {
    model,
    status: 'unreachable',
    checkedAt,
    message: 'The model verification request could not reach the connection',
  }
}

function nowIso(): IsoDateTime {
  return new Date().toISOString()
}
