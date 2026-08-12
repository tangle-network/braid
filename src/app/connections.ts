import { canonicalDigest } from '../domain/canonical.js'
import type { ConnectionKind, ConnectionRecord } from '../domain/entities.js'
import type { ConnectionId, Digest, WorkspaceId } from '../domain/ids.js'
import { parseConnectionId } from '../domain/ids.js'
import { assertConnectionRecord } from '../domain/invariants-profile.js'
import { redactSensitiveText } from '../domain/redaction.js'
import { ConnectionError } from './connection-errors.js'

export interface ConnectionSelectionInput {
  readonly connectionId: string
  readonly expectedKind?: ConnectionKind
  readonly expectedUpdatedAt?: string
}

export interface ConnectionSelection {
  readonly input: ConnectionSelectionInput
  readonly record: ConnectionRecord
  readonly digest: Digest
}

export interface ConnectionCatalog {
  get(connectionId: string): ConnectionRecord | undefined
  select(input: ConnectionSelectionInput): ConnectionSelection
}

/**
 * In-memory connection catalog for the application boundary.
 *
 * Durable event/state adapters can feed records into this catalog, while the
 * runtime resolver only receives an exact id-based selection.
 */
export class ConnectionRegistry implements ConnectionCatalog {
  readonly #records = new Map<ConnectionId, ConnectionRecord>()

  constructor(records: readonly ConnectionRecord[] = []) {
    for (const record of records) {
      if (this.#records.has(record.id)) {
        throw new ConnectionError('INVALID_CONNECTION_RECORD', 'Duplicate connection identifier')
      }
      this.#records.set(record.id, freezeConnectionRecord(validateRecord(record)))
    }
  }

  get(connectionId: string): ConnectionRecord | undefined {
    try {
      return this.#records.get(parseConnectionId(connectionId))
    } catch {
      return undefined
    }
  }

  list(workspaceId?: WorkspaceId): readonly ConnectionRecord[] {
    const records = [...this.#records.values()].filter(
      (record) => workspaceId === undefined || record.workspaceId === workspaceId,
    )
    return Object.freeze(records)
  }

  upsert(record: ConnectionRecord): ConnectionRecord {
    const normalized = freezeConnectionRecord(validateRecord(record))
    this.#records.set(normalized.id, normalized)
    return normalized
  }

  remove(input: ConnectionSelectionInput): ConnectionRecord {
    const selected = this.select(input)
    this.#records.delete(selected.record.id)
    return selected.record
  }

  select(input: ConnectionSelectionInput): ConnectionSelection {
    const id = parseSelectionId(input)
    const record = this.#records.get(id)
    if (!record) {
      throw new ConnectionError('CONNECTION_NOT_FOUND', 'The selected connection does not exist', {
        connectionId: id,
      })
    }
    if (input.expectedKind !== undefined && input.expectedKind !== record.kind) {
      throw new ConnectionError(
        'CONNECTION_KIND_MISMATCH',
        'The selected connection kind does not match the requested kind',
        { connectionId: id },
      )
    }
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== record.updatedAt) {
      throw new ConnectionError(
        'CONNECTION_REVISION_MISMATCH',
        'The selected connection changed before execution was admitted',
        { connectionId: id },
      )
    }
    return Object.freeze({
      input: Object.freeze({ ...input, connectionId: id }),
      record,
      digest: canonicalDigest({
        connectionId: id,
        kind: record.kind,
        updatedAt: record.updatedAt,
      }),
    })
  }
}

/** Saved connection identity wins; newer journal observations may refresh only health fields. */
export function mergeConnectionTelemetry(
  saved: ConnectionRecord,
  observed: ConnectionRecord,
): ConnectionRecord {
  if (
    saved.kind !== observed.kind ||
    saved.workspaceId !== observed.workspaceId ||
    saved.endpoint !== observed.endpoint ||
    saved.credentialRef !== observed.credentialRef ||
    canonicalDigest(saved.providerOptions) !== canonicalDigest(observed.providerOptions)
  ) {
    return saved
  }
  const savedHealthAt = 'checkedAt' in saved.lastHealth ? saved.lastHealth.checkedAt : undefined
  const observedHealthAt =
    'checkedAt' in observed.lastHealth ? observed.lastHealth.checkedAt : undefined
  const lastHealth =
    observedHealthAt !== undefined &&
    (savedHealthAt === undefined || observedHealthAt > savedHealthAt)
      ? observed.lastHealth
      : saved.lastHealth
  const savedModelAt = saved.lastModelVerification?.checkedAt
  const observedModelAt = observed.lastModelVerification?.checkedAt
  const lastModelVerification =
    observedModelAt !== undefined && (savedModelAt === undefined || observedModelAt > savedModelAt)
      ? observed.lastModelVerification
      : saved.lastModelVerification
  return {
    ...saved,
    lastHealth,
    ...(lastModelVerification === undefined ? {} : { lastModelVerification }),
  }
}

function parseSelectionId(input: ConnectionSelectionInput): ConnectionId {
  try {
    return parseConnectionId(input.connectionId)
  } catch {
    throw new ConnectionError('INVALID_CONNECTION_SELECTION', 'A connection id is required')
  }
}

function validateRecord(record: ConnectionRecord): ConnectionRecord {
  try {
    assertSecretFree(record)
    assertConnectionRecord(record)
    return record
  } catch (error) {
    if (error instanceof ConnectionError) throw error
    throw new ConnectionError('INVALID_CONNECTION_RECORD', 'The connection record is invalid')
  }
}

function assertSecretFree(record: ConnectionRecord): void {
  const allowedKeys = new Set([
    'id',
    'workspaceId',
    'kind',
    'name',
    'endpoint',
    'credentialRef',
    'providerOptions',
    'createdAt',
    'updatedAt',
    'lastHealth',
    'lastModelVerification',
  ])
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ConnectionError(
        'SECRET_IN_CONNECTION_RECORD',
        'Connection records may contain references, not provider-native or credential material',
        { connectionId: record.id },
      )
    }
  }
  const healthKeys = new Set(['status', 'checkedAt', 'message'])
  for (const key of Object.keys(record.lastHealth)) {
    if (!healthKeys.has(key)) {
      throw new ConnectionError(
        'SECRET_IN_CONNECTION_RECORD',
        'Connection health metadata may not contain provider-native or credential material',
        { connectionId: record.id },
      )
    }
  }
  if (record.lastModelVerification !== undefined) {
    const verificationKeys = new Set([
      'model',
      'status',
      'checkedAt',
      'code',
      'httpStatus',
      'message',
    ])
    for (const key of Object.keys(record.lastModelVerification)) {
      if (!verificationKeys.has(key)) {
        throw new ConnectionError(
          'SECRET_IN_CONNECTION_RECORD',
          'Connection verification metadata may not contain provider-native or credential material',
          { connectionId: record.id },
        )
      }
    }
  }
  const strings = [
    record.name,
    record.endpoint,
    record.providerOptions.transport,
    record.providerOptions.endpoint,
    record.providerOptions.region,
    record.providerOptions.account,
    record.providerOptions.lifecycle,
    ...(record.providerOptions.capabilityHints ?? []),
    ...('message' in record.lastHealth ? [record.lastHealth.message] : []),
    ...(record.lastModelVerification === undefined
      ? []
      : [
          record.lastModelVerification.model,
          record.lastModelVerification.code,
          record.lastModelVerification.message,
        ]),
  ]
  for (const value of strings) {
    if (value !== undefined && redactSensitiveText(value) !== value) {
      throw new ConnectionError(
        'SECRET_IN_CONNECTION_RECORD',
        'Connection records may contain references, not credential material',
        { connectionId: record.id },
      )
    }
    if (value?.includes('?') || value?.includes('#')) {
      throw new ConnectionError(
        'SECRET_IN_CONNECTION_RECORD',
        'Connection URLs must not contain query or fragment data',
        { connectionId: record.id },
      )
    }
  }
}

function freezeConnectionRecord(record: ConnectionRecord): ConnectionRecord {
  const providerOptions = Object.freeze({
    ...record.providerOptions,
    ...(record.providerOptions.capabilityHints === undefined
      ? {}
      : { capabilityHints: Object.freeze([...record.providerOptions.capabilityHints]) }),
  })
  const lastHealth = Object.freeze({ ...record.lastHealth })
  const lastModelVerification =
    record.lastModelVerification === undefined
      ? undefined
      : Object.freeze({ ...record.lastModelVerification })
  return Object.freeze({
    ...record,
    providerOptions,
    lastHealth,
    ...(lastModelVerification === undefined ? {} : { lastModelVerification }),
  })
}
