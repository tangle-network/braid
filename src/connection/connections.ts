import type {
  AgentEnvironmentCapabilities,
  AgentProfile,
  AgentProfileValidationResult,
  HarnessType,
  ModelReasoningCapability,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from '../domain/canonical.js'
import { cloneBoundedProfileValue, type ProfileJsonLimits } from '../profile/profile-json.js'
import { validateNormalizedCapabilityShape } from './capability-shape.js'
import type { CredentialReference } from './credentials.js'
import { credentialReferenceString, parseCredentialReference } from './credentials.js'
import {
  hasTrustedTunnel,
  providerOptionCredentialReferences,
  validateProviderOptions,
} from './provider-options.js'
import { containsControlCharacters, redactProviderText } from './redaction.js'

export {
  CLI_BRIDGE_SETUP,
  type ProviderSetupSpec,
  TANGLE_INFERENCE_SETUP,
  TANGLE_SANDBOX_SETUP,
} from './provider-setups.js'
export type ConnectionKind = 'cli-bridge' | 'tangle-inference' | 'tangle-sandbox'

export type ConnectionHealthStatus =
  | 'healthy'
  | 'unauthorized'
  | 'unreachable'
  | 'incompatible'
  | 'rate-limited'
  | 'unknown'

export interface ConnectionHealth {
  readonly status: ConnectionHealthStatus
  readonly checkedAt: string
  readonly latencyMs?: number
  readonly providerVersion?: string
  readonly message?: string
}

export interface ConnectionRecord {
  readonly id: string
  readonly kind: ConnectionKind
  readonly name: string
  readonly endpoint?: string
  readonly credentialRef?: string
  readonly account?: string
  readonly providerOptions: Readonly<Record<string, unknown>>
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastHealth?: ConnectionHealth
}
export interface ConnectionCapabilitySnapshot {
  readonly environment: AgentEnvironmentCapabilities
  readonly supportedRunners: readonly HarnessType[]
  readonly modelIds: readonly string[]
  readonly modelReasoning: Readonly<Record<string, ModelReasoningCapability>>
  readonly retrievedAt: string
  readonly source: string
  /** Computed over the complete validated snapshot; never trusted from a caller. */
  readonly digest?: string
}
/**
 * Capability reports are provider input, including when a test or an adapter
 * supplies an already-parsed object instead of HTTP JSON.
 *
 * The HTTP adapter applies a stricter shape validator, but this boundary also
 * has to protect admission from a direct provider port that returns a cyclic,
 * accessor-backed, or oversized object before the digest code sees it.
 */
const CAPABILITY_SNAPSHOT_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 30_000,
  maxStringLength: 4_096,
  maxEntries: 4_096,
})
const CONNECTION_RECORD_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 16,
  maxNodes: 4_096,
  maxStringLength: 4_096,
  maxEntries: 256,
})
function boundedCapabilitySnapshot(
  value: ConnectionCapabilitySnapshot | Omit<ConnectionCapabilitySnapshot, 'digest'>,
): Omit<ConnectionCapabilitySnapshot, 'digest'> {
  return cloneBoundedProfileValue(value, CAPABILITY_SNAPSHOT_LIMITS) as Omit<
    ConnectionCapabilitySnapshot,
    'digest'
  >
}
export function connectionCapabilityDigest(
  capabilities: Omit<ConnectionCapabilitySnapshot, 'digest'>,
): string {
  const bounded = boundedCapabilitySnapshot(capabilities)
  validateNormalizedCapabilityShape(bounded)
  return canonicalDigest({
    kind: 'braid.connection-capabilities',
    schemaVersion: 1,
    environment: bounded.environment,
    supportedRunners: [...bounded.supportedRunners],
    modelIds: [...bounded.modelIds],
    modelReasoning: bounded.modelReasoning,
    retrievedAt: bounded.retrievedAt,
    source: bounded.source,
  })
}
export function withCapabilityDigest(
  capabilities: ConnectionCapabilitySnapshot,
): ConnectionCapabilitySnapshot {
  const cloned = cloneBoundedProfileValue(capabilities, CAPABILITY_SNAPSHOT_LIMITS)
  if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new Error('Capability snapshot must be an object')
  }
  const boundedInput = cloned as Record<string, unknown>
  const { digest: _ignored, ...withoutDigest } = boundedInput
  validateNormalizedCapabilityShape(withoutDigest)
  const bounded = withoutDigest as Omit<ConnectionCapabilitySnapshot, 'digest'>
  return deepFreeze({ ...bounded, digest: connectionCapabilityDigest(bounded) })
}
export interface ProviderRequestOptions {
  readonly signal?: AbortSignal
}

/**
 * Profile validation takes the capability snapshot the caller already recorded,
 * so a provider cannot answer against a different snapshot than the one the
 * admission receipt names.
 */
export interface ProviderValidationContext extends ProviderRequestOptions {
  readonly capabilities: ConnectionCapabilitySnapshot
}
export interface ConnectionProviderPort {
  readonly kind: ConnectionKind
  health(connection: ConnectionRecord, options?: ProviderRequestOptions): Promise<ConnectionHealth>
  capabilities(
    connection: ConnectionRecord,
    options?: ProviderRequestOptions,
  ): Promise<ConnectionCapabilitySnapshot>
  validateProfile?(
    connection: ConnectionRecord,
    profile: Readonly<AgentProfile>,
    context: ProviderValidationContext,
  ): Promise<AgentProfileValidationResult>
}

export interface ConnectionSetupInput {
  readonly id: string
  readonly kind: ConnectionKind
  readonly name: string
  readonly endpoint?: string
  readonly credentialRef?: CredentialReference
  readonly account?: string
  readonly providerOptions?: Readonly<Record<string, unknown>>
  readonly now: string
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

/**
 * Endpoint policy. Remote plaintext HTTP is accepted only when an operator has
 * explicitly configured the provider's trusted tunnel boundary.
 */
function validateEndpoint(
  kind: ConnectionKind,
  endpoint: string | undefined,
  providerOptions: Readonly<Record<string, unknown>>,
): void {
  if (endpoint === undefined) {
    if (kind === 'cli-bridge') throw new Error('CLI Bridge connections require an endpoint')
    return
  }
  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    endpoint.length > 2_048 ||
    containsControlCharacters(endpoint)
  ) {
    throw new Error('Connection endpoint must be bounded and free of control characters')
  }
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`Invalid ${kind} endpoint`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${kind} endpoints must use HTTP or HTTPS`)
  }
  if (parsed.username || parsed.password) {
    throw new Error('Credentials must not be embedded in a connection endpoint')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Connection endpoints must not carry a query string or fragment')
  }
  if (isLoopback(parsed.hostname) || parsed.protocol === 'https:') return
  if (hasTrustedTunnel(providerOptions)) return
  throw new Error(`${kind} endpoints must use HTTPS outside loopback`)
}

function validateCredentialReference(kind: ConnectionKind, reference: string | undefined): void {
  if (reference === undefined) return
  const parsed = parseCredentialReference(reference)
  if (kind === 'cli-bridge' && parsed.kind === 'session') {
    throw new Error('CLI Bridge connections may not hold a session credential reference')
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}

function validateHealth(health: ConnectionHealth | undefined): ConnectionHealth | undefined {
  if (health === undefined) return undefined
  let bounded: unknown
  try {
    bounded = cloneBoundedProfileValue(health, CONNECTION_RECORD_LIMITS)
  } catch {
    throw new Error('Connection health is oversized or not JSON data')
  }
  if (bounded === null || typeof bounded !== 'object' || Array.isArray(bounded)) {
    throw new Error('Connection health must be an object')
  }
  const candidate = bounded as Record<string, unknown>
  if (
    Object.keys(candidate).some(
      (key) => !['status', 'checkedAt', 'latencyMs', 'providerVersion', 'message'].includes(key),
    )
  ) {
    throw new Error('Connection health contains an unsupported field')
  }
  if (
    !['healthy', 'unauthorized', 'unreachable', 'incompatible', 'rate-limited', 'unknown'].includes(
      candidate.status as string,
    )
  ) {
    throw new Error('Connection health has an invalid status')
  }
  if (typeof candidate.checkedAt !== 'string' || Number.isNaN(Date.parse(candidate.checkedAt))) {
    throw new Error('Connection health must carry an ISO timestamp')
  }
  if (
    candidate.latencyMs !== undefined &&
    (typeof candidate.latencyMs !== 'number' ||
      !Number.isFinite(candidate.latencyMs) ||
      candidate.latencyMs < 0)
  ) {
    throw new Error('Connection health latency must be a non-negative number')
  }
  const latencyMs = candidate.latencyMs
  const rawMessage = candidate.message
  const rawProviderVersion = candidate.providerVersion
  if (rawMessage !== undefined && typeof rawMessage !== 'string') {
    throw new Error('Connection health message must be text')
  }
  if (rawProviderVersion !== undefined && typeof rawProviderVersion !== 'string') {
    throw new Error('Connection health providerVersion must be text')
  }
  const message = rawMessage === undefined ? undefined : redactProviderText(rawMessage, 512)
  const providerVersion =
    rawProviderVersion === undefined ? undefined : redactProviderText(rawProviderVersion, 128)
  return Object.freeze({
    status: candidate.status as ConnectionHealthStatus,
    checkedAt: candidate.checkedAt,
    ...(latencyMs === undefined ? {} : { latencyMs: latencyMs as number }),
    ...(providerVersion === undefined ? {} : { providerVersion }),
    ...(message === undefined ? {} : { message }),
  })
}

/**
 * Validate one connection record end to end. Every entry into the registry runs
 * this, so a restored record cannot bypass the rules setup enforces.
 */
export function validateConnectionRecord(connection: ConnectionRecord): ConnectionRecord {
  let bounded: Record<string, unknown>
  try {
    const value = cloneBoundedProfileValue(connection, CONNECTION_RECORD_LIMITS)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('connection must be an object')
    }
    bounded = value as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `Connection record is oversized or not JSON data: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (
    Object.keys(bounded).some(
      (key) =>
        ![
          'id',
          'kind',
          'name',
          'endpoint',
          'credentialRef',
          'account',
          'providerOptions',
          'createdAt',
          'updatedAt',
          'lastHealth',
        ].includes(key),
    )
  ) {
    throw new Error('Connection record contains an unsupported field')
  }
  if (
    typeof bounded.id !== 'string' ||
    typeof bounded.name !== 'string' ||
    typeof bounded.kind !== 'string'
  ) {
    throw new Error('Connection id, name, and kind must be strings')
  }
  const kind = bounded.kind as ConnectionKind
  if (kind !== 'cli-bridge' && kind !== 'tangle-inference' && kind !== 'tangle-sandbox') {
    throw new Error(`Unknown connection kind: ${bounded.kind}`)
  }
  if (!bounded.id || !bounded.name) throw new Error('Connection id and name are required')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(bounded.id)) {
    throw new Error('Invalid connection id')
  }
  if (bounded.name.length > 256 || containsControlCharacters(bounded.name)) {
    throw new Error('Connection name must be bounded and free of control characters')
  }
  if (
    bounded.account !== undefined &&
    (typeof bounded.account !== 'string' ||
      bounded.account.length > 256 ||
      containsControlCharacters(bounded.account))
  ) {
    throw new Error('Connection account must be bounded and free of control characters')
  }
  const endpoint = bounded.endpoint as string | undefined
  const credentialRef = bounded.credentialRef as string | undefined
  const account = bounded.account as string | undefined
  const createdAt = bounded.createdAt as string
  const updatedAt = bounded.updatedAt as string
  if (
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string' ||
    Number.isNaN(Date.parse(createdAt)) ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    throw new Error('Connection timestamps must be ISO timestamps')
  }
  if (credentialRef !== undefined && typeof credentialRef !== 'string') {
    throw new Error('Connection credential reference must be a string')
  }
  const providerOptions = validateProviderOptions(
    kind,
    bounded.providerOptions as Readonly<Record<string, unknown>> | undefined,
  )
  validateEndpoint(kind, endpoint, providerOptions)
  validateCredentialReference(kind, credentialRef)
  for (const reference of providerOptionCredentialReferences(providerOptions)) {
    parseCredentialReference(reference)
  }
  const health = validateHealth(bounded.lastHealth as ConnectionHealth | undefined)
  return deepFreeze({
    id: bounded.id,
    kind,
    name: bounded.name,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(account === undefined ? {} : { account }),
    providerOptions,
    createdAt,
    updatedAt,
    ...(health === undefined ? {} : { lastHealth: health }),
  })
}

export function createConnectionRecord(input: ConnectionSetupInput): ConnectionRecord {
  return validateConnectionRecord({
    id: input.id,
    kind: input.kind,
    name: input.name,
    ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    ...(input.credentialRef === undefined
      ? {}
      : { credentialRef: credentialReferenceString(input.credentialRef) }),
    ...(input.account === undefined ? {} : { account: input.account }),
    providerOptions: input.providerOptions ?? {},
    createdAt: input.now,
    updatedAt: input.now,
  })
}

export function updateConnectionHealth(
  connection: ConnectionRecord,
  health: ConnectionHealth,
  now: string,
): ConnectionRecord {
  return validateConnectionRecord({ ...connection, lastHealth: health, updatedAt: now })
}

/** Every credential reference one record holds, including provider options. */
export function connectionCredentialReferences(connection: ConnectionRecord): readonly string[] {
  return Object.freeze([
    ...(connection.credentialRef === undefined ? [] : [connection.credentialRef]),
    ...providerOptionCredentialReferences(connection.providerOptions),
  ])
}

/** Stable provider binding used to prevent a live run being rebound in place. */
export function connectionIdentityDigest(connection: ConnectionRecord): string {
  return canonicalDigest({
    kind: 'braid.connection-identity',
    schemaVersion: 1,
    id: connection.id,
    connectionKind: connection.kind,
    ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
    ...(connection.account === undefined ? {} : { account: connection.account }),
    credentialReferences: [...connectionCredentialReferences(connection)].sort(),
    providerOptions: connection.providerOptions,
  })
}
