import { ConnectionError } from '../../app/connection-errors.js'
import type { ConnectionRecord } from '../../domain/entities.js'
import type { ConnectionId } from '../../domain/ids.js'
import {
  DEFAULT_TANGLE_SANDBOX_ENDPOINT,
  type ProductionConnectionOptions,
} from './production-connection-types.js'

// Keep this narrow helper independent of agent-runtime so composition can cold-load
// connection configuration without materializing the runtime kernel.
export const DEFAULT_TANGLE_INFERENCE_ENDPOINT = 'https://router.tangle.tools'

export function connectionEndpoint(
  record: ConnectionRecord,
  options: Pick<
    ProductionConnectionOptions,
    'defaultInferenceEndpoint' | 'defaultSandboxEndpoint' | 'trustedTransportPolicy'
  > = {},
): string {
  const recordEndpoint = record.endpoint
  const optionEndpoint = record.providerOptions.endpoint
  if (
    recordEndpoint !== undefined &&
    optionEndpoint !== undefined &&
    recordEndpoint !== optionEndpoint
  ) {
    throw new ConnectionError(
      'CONNECTION_ENDPOINT_CONFLICT',
      'The connection has conflicting endpoint references',
      { connectionId: record.id },
    )
  }
  const endpoint =
    recordEndpoint ??
    optionEndpoint ??
    (record.kind === 'tangle-inference'
      ? (options.defaultInferenceEndpoint ?? DEFAULT_TANGLE_INFERENCE_ENDPOINT)
      : record.kind === 'tangle-sandbox'
        ? (options.defaultSandboxEndpoint ?? DEFAULT_TANGLE_SANDBOX_ENDPOINT)
        : undefined)
  if (!endpoint) {
    throw new ConnectionError(
      'CONNECTION_ENDPOINT_REQUIRED',
      'This connection requires an HTTP endpoint',
      { connectionId: record.id },
    )
  }
  validateHttpEndpoint(endpoint, record.id)
  assertTrustedTransport(record, endpoint, options.trustedTransportPolicy)
  return endpoint.replace(/\/$/u, '')
}

export function normalizeCliBridgeRuntimeBaseUrl(
  endpoint: string,
  connectionId?: ConnectionId,
): string {
  const url = parseHttpEndpoint(endpoint, connectionId)
  const path = url.pathname.replace(/\/+$/u, '')
  if (path === '' || path === '/') url.pathname = '/v1'
  else if (!path.endsWith('/v1')) url.pathname = `${path}/v1`
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/u, '')
}

/** The provider owns `/v1`; pass only the server root so it cannot duplicate the API prefix. */
export function normalizeCliBridgeProviderBaseUrl(
  endpoint: string,
  connectionId?: ConnectionId,
): string {
  return stripCliBridgeVersion(normalizeCliBridgeRuntimeBaseUrl(endpoint, connectionId))
}

export function appendHealthPath(endpoint: string): string {
  const url = new URL(endpoint)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/health`
  return url.toString()
}

export function stripCliBridgeVersion(endpoint: string): string {
  const url = new URL(endpoint)
  const path = url.pathname.replace(/\/+$/u, '')
  if (path.endsWith('/v1')) url.pathname = path.slice(0, -3) || '/'
  return url.toString().replace(/\/$/u, '')
}

export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return isLoopbackHostname(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

function assertTrustedTransport(
  record: ConnectionRecord,
  endpoint: string,
  policy: ProductionConnectionOptions['trustedTransportPolicy'],
): void {
  const url = new URL(endpoint)
  if (url.protocol !== 'http:' || isLoopbackHostname(url.hostname)) return
  let trusted = false
  try {
    trusted = policy?.({ record, endpoint: url.toString().replace(/\/$/u, '') }) === true
  } catch {
    trusted = false
  }
  if (!trusted) {
    throw new ConnectionError(
      'CONNECTION_ENDPOINT_INSECURE',
      'Remote HTTP requires an explicit trusted transport policy',
      { connectionId: record.id },
    )
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  if (normalized === 'localhost' || normalized === '::1') return true
  const octets = normalized.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.slice(1).every((octet) => /^\d+$/u.test(octet) && Number(octet) <= 255)
  )
}

function validateHttpEndpoint(endpoint: string, connectionId: ConnectionId): void {
  parseHttpEndpoint(endpoint, connectionId)
}

function parseHttpEndpoint(endpoint: string, connectionId?: ConnectionId): URL {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new ConnectionError(
      'CONNECTION_ENDPOINT_INVALID',
      'The connection endpoint is not an HTTP URL',
      {
        ...(connectionId ? { connectionId } : {}),
      },
    )
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ConnectionError(
      'CONNECTION_ENDPOINT_INVALID',
      'The connection endpoint is not a safe HTTP URL',
      {
        ...(connectionId ? { connectionId } : {}),
      },
    )
  }
  return url
}
