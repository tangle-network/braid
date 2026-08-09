import { parseCliBridgeHealth } from '../adapters/connections/cli-bridge-health.js'
import type { ConnectionHealth } from '../domain/entities.js'
import { redactSensitiveText } from '../domain/redaction.js'
import {
  DEFAULT_BRIDGE_DISCOVERY_TIMEOUT_MS,
  MAX_BRIDGE_DISCOVERY_BODY_BYTES,
  requestBridge,
  safeBridgeDetail,
} from './production-bridge-client.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

export interface BridgeModel {
  readonly id: string
  readonly backend?: string
}

export interface BridgeDiscoveryResult {
  readonly health: ConnectionHealth
  readonly models: readonly BridgeModel[]
  readonly diagnostics: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function discoveryTimeout(options: ProductionStartupLoadOptions): number {
  return options.discoveryTimeoutMs ?? DEFAULT_BRIDGE_DISCOVERY_TIMEOUT_MS
}

function discoveryDiagnostic(endpoint: string, path: string, error: unknown): string {
  const detail =
    error instanceof Error ? error.message : 'the bridge returned an unavailable discovery result'
  return redactSensitiveText(`CLI Bridge discovery ${path} at ${endpoint} failed: ${detail}`, 512)
}

function responseDiagnostic(endpoint: string, path: string, status: number, body: string): string {
  const detail = safeBridgeDetail(body)
  return [
    `CLI Bridge discovery ${path} at ${endpoint} returned HTTP ${status}`,
    ...(detail === undefined ? [] : [`(${detail})`]),
  ].join(' ')
}

/** Reads the bounded bridge health and model catalogs used by first-run setup. */
export async function discoverBridge(
  options: ProductionStartupLoadOptions,
  endpoint: string,
): Promise<BridgeDiscoveryResult> {
  const [healthResult, modelsResult] = await Promise.allSettled([
    requestBridge({
      endpoint,
      path: 'health',
      ...(options.fetch === undefined ? {} : { fetcher: options.fetch }),
      ...(options.bridgeAuth === undefined ? {} : { auth: options.bridgeAuth }),
      timeoutMs: discoveryTimeout(options),
      maxBodyBytes: MAX_BRIDGE_DISCOVERY_BODY_BYTES,
    }),
    requestBridge({
      endpoint,
      path: 'models',
      ...(options.fetch === undefined ? {} : { fetcher: options.fetch }),
      ...(options.bridgeAuth === undefined ? {} : { auth: options.bridgeAuth }),
      timeoutMs: discoveryTimeout(options),
      maxBodyBytes: MAX_BRIDGE_DISCOVERY_BODY_BYTES,
    }),
  ])
  const diagnostics: string[] = []
  const checkedAt = new Date().toISOString()
  let health: ConnectionHealth = { status: 'unknown' }
  if (healthResult.status === 'fulfilled') {
    const parsed = parseCliBridgeHealth(
      `${endpoint}`,
      healthResult.value.status,
      healthResult.value.body,
      checkedAt,
    )
    health = parsed.health
    if (!healthResult.value.ok || parsed.diagnostic !== undefined) {
      diagnostics.push(
        parsed.diagnostic ??
          responseDiagnostic(
            endpoint,
            '/health',
            healthResult.value.status,
            healthResult.value.body,
          ),
      )
    }
  } else {
    diagnostics.push(discoveryDiagnostic(endpoint, '/health', healthResult.reason))
    health = {
      status: 'unreachable',
      checkedAt,
      message: 'The bridge health check could not be completed',
    }
  }

  if (modelsResult.status === 'rejected') {
    diagnostics.push(discoveryDiagnostic(endpoint, '/v1/models', modelsResult.reason))
    return { health, models: [], diagnostics }
  }
  const modelsResponse = modelsResult.value
  if (!modelsResponse.ok) {
    diagnostics.push(
      responseDiagnostic(endpoint, '/v1/models', modelsResponse.status, modelsResponse.body),
    )
    return { health, models: [], diagnostics }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(modelsResponse.body)
  } catch (error) {
    diagnostics.push(
      discoveryDiagnostic(
        endpoint,
        '/v1/models',
        new Error('the response was not valid JSON', { cause: error }),
      ),
    )
    return { health, models: [], diagnostics }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    diagnostics.push(
      `CLI Bridge discovery /v1/models at ${endpoint}/v1/models returned no model list; choose a configured bridge backend and retry`,
    )
    return { health, models: [], diagnostics }
  }
  const models = parsed.data.flatMap((entry): BridgeModel[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.trim().length === 0) return []
    return [
      {
        id: entry.id.trim(),
        ...(typeof entry.backend === 'string' && entry.backend.trim().length > 0
          ? { backend: entry.backend.trim() }
          : {}),
      },
    ]
  })
  if (models.length === 0) {
    diagnostics.push(
      `CLI Bridge discovery /v1/models at ${endpoint}/v1/models returned no usable model ids; start or configure a bridge backend`,
    )
  }
  return { health, models, diagnostics }
}
