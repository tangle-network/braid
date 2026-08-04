import type { ConnectionCapabilityReport } from '../adapters/connections/production-connection-types.js'
import { redactStructuredValue } from '../domain/bounded-structured.js'
import type {
  ConnectionHealth,
  ConnectionModelVerification,
  ConnectionRecord,
  OperationRecord,
} from '../domain/entities.js'
import type { JsonValue } from '../domain/entities-base.js'
import type { Digest } from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import type { ConnectionSummary, ConnectionTestResultData } from './connection-action-types.js'
import { acknowledgedOperation, type parseOperation } from './conversation-support.js'

export function selectedModel(profile: Readonly<Record<string, unknown>>): string | undefined {
  const model = profile.model
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return undefined
  const value = (model as { readonly default?: unknown }).default
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

export function unverifiedModel(
  model: string | undefined,
  checkedAt: string,
): ConnectionModelVerification {
  return {
    model: model ?? '',
    status: 'unverified',
    checkedAt,
    message: 'The configured adapter does not expose model verification',
  }
}

export function connectionSummary(
  record: ConnectionRecord,
  requestedModel: string | undefined,
  capabilities?: ConnectionCapabilityReport,
): ConnectionSummary {
  const cachedModel =
    record.lastModelVerification?.model === requestedModel
      ? record.lastModelVerification
      : undefined
  return {
    id: record.id,
    name: redactText(record.name, 512),
    kind: record.kind,
    ...(record.endpoint === undefined ? {} : { endpoint: redactText(record.endpoint, 2048) }),
    ...(record.providerOptions.region === undefined
      ? {}
      : { region: redactText(record.providerOptions.region, 512) }),
    ...(record.providerOptions.account === undefined
      ? {}
      : { account: redactText(record.providerOptions.account, 512) }),
    credentialConfigured: record.credentialRef !== undefined,
    health: record.lastHealth,
    ...(cachedModel === undefined ? {} : { modelVerification: cachedModel }),
    capabilityHints: [...(record.providerOptions.capabilityHints ?? [])],
    ...(capabilities === undefined ? {} : { capabilities }),
    ready: record.lastHealth.status === 'healthy' && cachedModel?.status === 'verified',
  }
}

export function cachedCapabilities(
  state: BraidState,
  connectionId: string,
): ConnectionCapabilityReport | undefined {
  for (const operation of [...state.operations].reverse()) {
    if (operation.kind !== 'connection-change' || operation.status !== 'acknowledged') continue
    const result = operation.result
    if (!isRecord(result) || result.connectionId !== connectionId) continue
    const capabilities = result.capabilities
    if (isCapabilityReport(capabilities, connectionId)) return capabilities
  }
  return undefined
}

export function operationTestResult(
  operation: OperationRecord,
  credentialConfigured = false,
): ConnectionTestResultData | undefined {
  const value = operation.result
  if (!isRecord(value)) return undefined
  if (!isRecord(value.connection) || !isPersistedConnectionSummary(value.connection))
    return undefined
  if (!isHealth(value.health)) return undefined
  if (!isModelVerification(value.modelVerification)) return undefined
  if (typeof value.ready !== 'boolean') return undefined
  if (value.capabilities !== undefined && value.capabilities !== null) {
    if (!isCapabilityReport(value.capabilities, String(value.connection.id))) return undefined
  }
  return {
    connection: {
      ...(value.connection as unknown as Omit<ConnectionSummary, 'credentialConfigured'>),
      credentialConfigured,
    },
    health: value.health as ConnectionHealth,
    modelVerification: value.modelVerification as ConnectionModelVerification,
    ...(value.capabilities === undefined || value.capabilities === null
      ? {}
      : { capabilities: value.capabilities as ConnectionCapabilityReport }),
    ready: value.ready,
  }
}

export function operationSelectionSummary(
  operation: OperationRecord,
  credentialConfigured = false,
): ConnectionSummary | undefined {
  const value = operation.result?.connection
  return isRecord(value) && isPersistedConnectionSummary(value)
    ? {
        ...(value as unknown as Omit<ConnectionSummary, 'credentialConfigured'>),
        credentialConfigured,
      }
    : undefined
}

export function connectionSelectionOperationResult(
  connectionId: string,
  connection: ConnectionSummary,
): NonNullable<OperationRecord['result']> {
  return jsonObject({ connectionId, connection: persistedConnectionSummary(connection) })
}

export function connectionTestOperationResult(
  result: ConnectionTestResultData,
): NonNullable<OperationRecord['result']> {
  const capabilities =
    result.capabilities === undefined ? undefined : safeCapabilities(result.capabilities)
  const connection = persistedConnectionSummary(result.connection, capabilities)
  const value = {
    connectionId: result.connection.id,
    connection,
    health: safeHealth(result.health),
    modelVerification: safeModelVerification(result.modelVerification),
    ...(capabilities === undefined ? {} : { capabilities }),
    ready: result.ready,
  }
  return jsonObject(value)
}

export function pendingConnectionOperation(
  id: ReturnType<typeof parseOperation>,
  digest: Digest,
  at: string,
): OperationRecord & { readonly kind: 'connection-change' } {
  return {
    id,
    kind: 'connection-change',
    requestDigest: digest,
    status: 'pending',
    createdAt: at,
    updatedAt: at,
  }
}

export function acknowledgedConnectionOperation(input: {
  readonly id: ReturnType<typeof parseOperation>
  readonly digest: Digest
  readonly at: string
  readonly result?: OperationRecord['result']
}): OperationRecord & { readonly kind: 'connection-change' } {
  return acknowledgedOperation({ ...input, kind: 'connection-change' }) as OperationRecord & {
    readonly kind: 'connection-change'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isHealth(value: unknown): value is ConnectionHealth {
  return isRecord(value) && typeof value.status === 'string'
}

function isModelVerification(value: unknown): value is ConnectionModelVerification {
  return isRecord(value) && typeof value.model === 'string' && typeof value.status === 'string'
}

function isPersistedConnectionSummary(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.kind === 'string' &&
    isHealth(value.health) &&
    typeof value.ready === 'boolean'
  )
}

function isCapabilityReport(
  value: unknown,
  connectionId: string,
): value is ConnectionCapabilityReport {
  if (!isRecord(value)) return false
  if (value.connectionId !== connectionId || typeof value.kind !== 'string') return false
  if (!isRecord(value.runtime) || !isRecord(value.runtime.streaming)) return false
  if (!isRecord(value.runtime.sessions) || !isRecord(value.runtime.interactions)) return false
  if (!isRecord(value.providerMethods) || !isRecord(value.actions)) return false
  return Object.values(value.actions).every((item) => typeof item === 'boolean')
}

function persistedConnectionSummary(
  summary: ConnectionSummary,
  capabilities: ConnectionCapabilityReport | undefined = undefined,
): Omit<ConnectionSummary, 'credentialConfigured'> {
  const { credentialConfigured: _credentialConfigured, ...persisted } = summary
  return {
    ...persisted,
    health: safeHealth(summary.health),
    ...(summary.modelVerification === undefined
      ? {}
      : { modelVerification: safeModelVerification(summary.modelVerification) }),
    ...(capabilities === undefined ? {} : { capabilities }),
  }
}

function safeHealth(health: ConnectionHealth): ConnectionHealth {
  if (health.status === 'unknown' || health.message === undefined) return health
  return { ...health, message: redactSensitiveText(health.message, 2048) }
}

function safeModelVerification(
  verification: ConnectionModelVerification,
): ConnectionModelVerification {
  return {
    ...verification,
    model: redactSensitiveText(verification.model, 512),
    ...(verification.code === undefined
      ? {}
      : { code: redactSensitiveText(verification.code, 256) }),
    ...(verification.message === undefined
      ? {}
      : { message: redactSensitiveText(verification.message, 2048) }),
  }
}

function safeCapabilities(report: ConnectionCapabilityReport): ConnectionCapabilityReport {
  return redactStructuredValue(report, undefined, {
    maxBytes: 512 * 1024,
  }) as ConnectionCapabilityReport
}

function redactText(value: string, maxBytes: number): string {
  return redactSensitiveText(value, maxBytes)
}

function jsonObject(value: unknown): NonNullable<OperationRecord['result']> {
  if (!isRecord(value)) return {}
  return value as Record<string, JsonValue>
}
