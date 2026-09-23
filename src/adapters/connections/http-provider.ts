import type {
  AgentProfile,
  AgentProfileValidationIssue,
  AgentProfileValidationResult,
} from '@tangle-network/agent-interface'
import type {
  ConnectionCapabilitySnapshot,
  ConnectionHealth,
  ConnectionProviderPort,
  ConnectionRecord,
  ProviderRequestOptions,
  ProviderValidationContext,
} from '../../connection/connections.js'
import { parseCredentialReference, type CredentialReference } from '../../connection/credentials.js'
import { redactProviderText } from '../../connection/redaction.js'
import { validateCanonicalProfile } from '../../profile/profile-validation.js'
import { readCapabilitySnapshot, unsupportedProfileDimensions } from './capability-report.js'
import {
  ProviderRequestAbortedError,
  ProviderRequestTimeoutError,
  type ConnectionHttpTransport,
} from './http-transport.js'

export class ProviderHttpStatusError extends Error {
  readonly status: number

  constructor(operation: string, status: number) {
    super(`Provider ${operation} failed with HTTP ${status}`)
    this.name = 'ProviderHttpStatusError'
    this.status = status
  }
}

interface ProviderPaths {
  readonly health: string
  readonly capabilities: string
  readonly validateProfile?: string
}

/** Most issues Braid keeps from one provider validation response. */
const MAX_PROVIDER_ISSUES = 64

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function healthMessage(payload: unknown): string | undefined {
  const value = record(payload)
  return typeof value?.message === 'string' ? redactProviderText(value.message) : undefined
}

function healthStatus(status: number): ConnectionHealth['status'] {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'incompatible'
  if (status === 429) return 'rate-limited'
  if (status >= 200 && status < 300) return 'healthy'
  return 'unknown'
}

function providerRequestBinding(connection: ConnectionRecord): {
  readonly endpoint?: string
  readonly credentialReference?: CredentialReference | null
} {
  const options = connection.providerOptions
  if (connection.kind === 'tangle-inference') {
    const router = options.routerCredential
    return {
      ...(typeof options.routerBaseUrl === 'string' ? { endpoint: options.routerBaseUrl } : {}),
      credentialReference:
        router !== null && typeof router === 'object' && !Array.isArray(router)
          ? parseCredentialReference((router as { reference: string }).reference)
          : null,
    }
  }
  if (connection.kind === 'tangle-sandbox') {
    const operator = options.operatorCredential
    return {
      credentialReference:
        operator !== null && typeof operator === 'object' && !Array.isArray(operator)
          ? parseCredentialReference((operator as { reference: string }).reference)
          : connection.credentialRef === undefined
            ? null
            : parseCredentialReference(connection.credentialRef),
    }
  }
  return {}
}

/**
 * Read one provider validation response.
 *
 * Every issue string is redacted before it can reach a view or a receipt: a
 * provider that echoes the request — including its `authorization` header — would
 * otherwise persist a live credential in Braid's own artifacts.
 */
function validationResult(payload: unknown): AgentProfileValidationResult {
  const value = record(payload)
  if (typeof value?.ok !== 'boolean' || !Array.isArray(value.issues)) {
    throw new Error('Provider profile validation response is malformed')
  }
  if (value.issues.length > MAX_PROVIDER_ISSUES) {
    throw new Error(`Provider reported more than ${MAX_PROVIDER_ISSUES} validation issues`)
  }
  const issues: AgentProfileValidationIssue[] = value.issues.flatMap((issue) => {
    const entry = record(issue)
    if (
      entry === undefined ||
      (entry.level !== 'error' && entry.level !== 'warning' && entry.level !== 'info')
    ) {
      return []
    }
    if (typeof entry.code !== 'string' || typeof entry.message !== 'string') return []
    const code = redactProviderText(entry.code, 128)
    const message = redactProviderText(entry.message)
    if (code === undefined || message === undefined) return []
    const path = typeof entry.path === 'string' ? redactProviderText(entry.path, 256) : undefined
    return [
      {
        level: entry.level,
        code,
        message,
        ...(path === undefined ? {} : { path }),
      },
    ]
  })
  if (issues.length !== value.issues.length) {
    throw new Error('Provider profile validation response contains an invalid issue')
  }
  const result: AgentProfileValidationResult = { ok: value.ok, issues }
  if (value.normalizedProfile !== undefined) {
    const normalized = validateCanonicalProfile(value.normalizedProfile)
    if (!normalized.ok || normalized.profile === undefined) {
      throw new Error('Provider returned an invalid normalized profile')
    }
    result.normalizedProfile = normalized.profile
  }
  return result
}

/**
 * HTTP-backed provider adapter.
 *
 * Capability reports are fully validated before use, and profile dimensions the
 * report cannot honor become error issues even when the provider exposes no
 * validation endpoint — the absence of somewhere to ask is not evidence of
 * support.
 */
export class HttpConnectionProvider implements ConnectionProviderPort {
  readonly kind: ConnectionRecord['kind']
  readonly #transport: ConnectionHttpTransport
  readonly #paths: ProviderPaths

  constructor(options: {
    readonly kind: ConnectionRecord['kind']
    readonly transport: ConnectionHttpTransport
    readonly paths?: Partial<ProviderPaths>
  }) {
    this.kind = options.kind
    this.#transport = options.transport
    this.#paths = {
      health: options.paths?.health ?? '/health',
      capabilities: options.paths?.capabilities ?? '/capabilities',
      ...(options.paths?.validateProfile === undefined
        ? {}
        : { validateProfile: options.paths.validateProfile }),
    }
  }

  async health(
    connection: ConnectionRecord,
    options: ProviderRequestOptions = {},
  ): Promise<ConnectionHealth> {
    const started = performance.now()
    try {
      const response = await this.#transport.request({
        connection,
        ...providerRequestBinding(connection),
        path: this.#paths.health,
        method: 'GET',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const message = healthMessage(response.payload)
      return Object.freeze({
        status: healthStatus(response.status),
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        ...(response.providerVersion === undefined
          ? {}
          : { providerVersion: response.providerVersion }),
        ...(message === undefined ? {} : { message }),
      })
    } catch (error) {
      if (
        error instanceof ProviderRequestAbortedError ||
        error instanceof ProviderRequestTimeoutError
      ) {
        throw error
      }
      const message = redactProviderText(error instanceof Error ? error.message : String(error))
      return Object.freeze({
        status: 'unreachable',
        checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        ...(message === undefined ? {} : { message }),
      })
    }
  }

  async capabilities(
    connection: ConnectionRecord,
    options: ProviderRequestOptions = {},
  ): Promise<ConnectionCapabilitySnapshot> {
    const response = await this.#transport.request({
      connection,
      ...providerRequestBinding(connection),
      path: this.#paths.capabilities,
      method: 'GET',
      payloadValidator: (payload) =>
        readCapabilitySnapshot(payload, new Date().toISOString(), this.kind),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderHttpStatusError('capability request', response.status)
    }
    return readCapabilitySnapshot(response.payload, new Date().toISOString(), this.kind)
  }

  async validateProfile(
    connection: ConnectionRecord,
    profile: Readonly<AgentProfile>,
    context: ProviderValidationContext,
  ): Promise<AgentProfileValidationResult> {
    const unsupported = unsupportedProfileDimensions(
      context.capabilities.environment.profile,
      profile,
    )
    const capabilityIssues: AgentProfileValidationIssue[] = unsupported.map((dimension) => ({
      level: 'error' as const,
      code: 'UNSUPPORTED_PROFILE_DIMENSION',
      message: `The ${this.kind} connection does not report support for ${dimension}`,
      path: dimension,
    }))
    if (this.#paths.validateProfile === undefined) {
      return { ok: capabilityIssues.length === 0, issues: capabilityIssues }
    }
    const response = await this.#transport.request({
      connection,
      ...providerRequestBinding(connection),
      path: this.#paths.validateProfile,
      method: 'POST',
      body: { profile },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderHttpStatusError('profile validation', response.status)
    }
    const reported = validationResult(response.payload)
    return {
      ok: reported.ok && capabilityIssues.length === 0,
      issues: [...capabilityIssues, ...reported.issues],
      ...(reported.normalizedProfile === undefined
        ? {}
        : { normalizedProfile: reported.normalizedProfile }),
    }
  }
}
