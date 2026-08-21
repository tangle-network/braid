import { createHash } from 'node:crypto'
import { canonicalDigest, canonicalJson } from '../../domain/canonical.js'
import {
  parseConversationId,
  parseEventId,
  parseOperationId,
  parseRunId,
} from '../../domain/ids.js'
import { isCanonicalIsoDateTime } from '../../domain/text.js'
import type { CredentialRef } from '../../ports/credentials.js'
import { CredentialError, credentialRef } from '../../ports/credentials.js'
import type { EffectRecord } from '../../ports/effect-storage.js'
import type {
  JsonValue,
  MissingHistory,
  OperationRecord,
  ProjectionRun,
  ProjectionSnapshot,
} from '../../ports/storage.js'
import { isJsonValue, PROJECTION_SCHEMA_VERSION } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'
import type { CursorRow, OperationRow, SqliteEventRow } from './sqlite-types.js'
import { assertEffectRecordInput } from './storage-validation.js'

export function now(): string {
  return new Date().toISOString()
}

export function asNumber(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : Number(value)
  if (!Number.isSafeInteger(number))
    throw new StorageError('STORAGE_ROW_INVALID', `Invalid ${field} in SQLite row`)
  return number
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== 'string')
    throw new StorageError('STORAGE_ROW_INVALID', `Invalid ${field} in SQLite row`)
  return value
}

export function asBuffer(value: unknown, field: string): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  throw new StorageError('STORAGE_ROW_INVALID', `Invalid ${field} in SQLite row`)
}

export function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue
}

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue
}

export function redactedPersistedPayload(
  value: JsonValue,
  row: SqliteEventRow,
  _reason: string,
): JsonValue {
  const eventId = asString(row.event_id, 'event_id')
  const storageSequence = asNumber(row.storage_id, 'storage_id')
  const fallback = (): JsonValue => ({
    __braidEvent: {
      kind: 'unknown.event',
      unknown: {
        id: eventId,
        type: asString(row.kind, 'kind'),
        namespace: 'braid.redacted',
        summary: 'Event payload redacted',
        sequence: asNumber(row.run_sequence, 'run_sequence'),
      },
    },
    __braidEnvelope: {
      eventId,
      sequence: storageSequence,
      revision: storageSequence,
      occurredAt: asString(row.occurred_at, 'occurred_at'),
      ...(row.cursor === null ? {} : { cursor: asString(row.cursor, 'cursor') }),
    },
  })
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback()
  const candidate = value as Readonly<Record<string, JsonValue>>
  const event = candidate.__braidEvent
  const envelope = candidate.__braidEnvelope
  if (
    event === null ||
    typeof event !== 'object' ||
    Array.isArray(event) ||
    envelope === null ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope)
  )
    return fallback()
  const eventRecord = event as Readonly<Record<string, JsonValue>>
  const envelopeRecord = envelope as Readonly<Record<string, JsonValue>>
  if (
    typeof eventRecord.kind !== 'string' ||
    typeof envelopeRecord.sequence !== 'number' ||
    typeof envelopeRecord.revision !== 'number' ||
    typeof envelopeRecord.occurredAt !== 'string'
  )
    return fallback()
  return {
    __braidEvent: {
      kind: 'unknown.event',
      unknown: {
        id: eventId,
        type: eventRecord.kind,
        namespace: 'braid.redacted',
        summary: 'Event payload redacted',
        sequence: envelopeRecord.sequence,
      },
    },
    __braidEnvelope: {
      eventId,
      sequence: envelopeRecord.sequence,
      revision: envelopeRecord.revision,
      occurredAt: envelopeRecord.occurredAt,
      ...(typeof envelopeRecord.cursor === 'string' ? { cursor: envelopeRecord.cursor } : {}),
    },
  }
}

export function credentialErrorCode(error: unknown): string | undefined {
  return error instanceof CredentialError ? error.code : undefined
}

export function deterministicCredentialRef(prefix: string, value: string): CredentialRef {
  const digest = createHash('sha256').update(value).digest('hex')
  return credentialRef(`cred:v1:${prefix}-${digest}`)
}

export function redactionReasonDigest(reason: string): string {
  return `sha256:${createHash('sha256').update(reason).digest('hex')}`
}

export function operationRecordFromRow(row: OperationRow): OperationRecord {
  const request: unknown = JSON.parse(row.request_json)
  if (!isJsonValue(request))
    throw new StorageError('OPERATION_RECORD_INVALID', 'Stored operation request is invalid')
  const result = row.result_json === null ? undefined : (JSON.parse(row.result_json) as unknown)
  if (result !== undefined && !isJsonValue(result)) {
    throw new StorageError('OPERATION_RECORD_INVALID', 'Stored operation result is invalid')
  }
  if (
    !isCanonicalIsoDateTime(row.created_at) ||
    !isCanonicalIsoDateTime(row.updated_at) ||
    row.updated_at < row.created_at
  ) {
    throw new StorageError('OPERATION_RECORD_INVALID', 'Stored operation timestamps are invalid')
  }
  return {
    operationId: parseOperationId(row.operation_id),
    kind: row.operation_kind,
    request,
    requestDigest: row.request_digest,
    status: row.status,
    ...(result === undefined ? {} : { result }),
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }
}

export function effectRecordFromRow(row: Record<string, unknown>): EffectRecord {
  const metadataValue: unknown = JSON.parse(asString(row.metadata_json, 'metadata_json'))
  if (
    metadataValue === null ||
    typeof metadataValue !== 'object' ||
    Array.isArray(metadataValue) ||
    Object.values(metadataValue).some((value) => typeof value !== 'string')
  ) {
    throw new StorageError('EFFECT_RECORD_INVALID', 'Stored effect metadata is invalid')
  }
  const status = asString(row.status, 'status')
  if (!['pending', 'acknowledged', 'failed', 'unknown', 'conflict', 'terminal'].includes(status)) {
    throw new StorageError('EFFECT_RECORD_INVALID', `Unknown effect status ${status}`)
  }
  const record: EffectRecord = {
    operationId: parseOperationId(asString(row.operation_id, 'operation_id')),
    effectKind: asString(row.effect_kind, 'effect_kind'),
    requestDigest: asString(row.request_digest, 'request_digest'),
    status: status as EffectRecord['status'],
    attempt: asNumber(row.attempt, 'attempt'),
    createdAt: asString(row.created_at, 'created_at'),
    updatedAt: asString(row.updated_at, 'updated_at'),
    metadata: metadataValue as Readonly<Record<string, string>>,
    ...(row.detail === null || row.detail === undefined
      ? {}
      : { detail: asString(row.detail, 'detail') }),
    ...(row.external_reference === null || row.external_reference === undefined
      ? {}
      : { externalReference: asString(row.external_reference, 'external_reference') }),
    ...(row.conflict_with_digest === null || row.conflict_with_digest === undefined
      ? {}
      : { conflictWithDigest: asString(row.conflict_with_digest, 'conflict_with_digest') }),
  }
  assertEffectRecordInput(record)
  return record
}

export function missingFromCursor(row: CursorRow): MissingHistory | null {
  if (row.missing_from === null || row.missing_to === null) return null
  return {
    runId: parseRunId(row.run_id),
    fromSequence: row.missing_from,
    toSequence: row.missing_to,
  }
}

export const PROJECTION_EVENT_DIGEST_SEED = createHash('sha256')
  .update('braid-projection-events-v1')
  .digest('hex')

export function appendProjectionEventDigest(previous: string, eventId: string): string {
  return createHash('sha256').update(`${previous}\u0000${eventId}`).digest('hex')
}

export function projectionRunDigest(runs: readonly ProjectionRun[]): string {
  const aggregate = Buffer.alloc(32)
  for (const run of [...runs].sort((left, right) => left.runId.localeCompare(right.runId))) {
    const digest = Buffer.from(canonicalDigest(run), 'hex')
    for (let index = 0; index < aggregate.length; index += 1) {
      aggregate[index] = (aggregate[index] ?? 0) ^ (digest[index] ?? 0)
    }
  }
  return aggregate.toString('hex')
}

export function projectionChecksum(input: {
  readonly schemaVersion: number
  readonly eventCount: number
  readonly revision: number
  readonly eventIdsDigest: string
  readonly runsDigest: string
}): string {
  return canonicalDigest(input)
}

export function projectionFromRows(
  rows: readonly SqliteEventRow[],
  cursors: readonly CursorRow[],
): ProjectionSnapshot {
  const runs = new Map<string, ProjectionRun>()
  for (const row of cursors) {
    runs.set(row.run_id, {
      runId: parseRunId(row.run_id),
      conversationId: parseConversationId(row.conversation_id),
      lastSequence: row.last_sequence,
      lastCursor: row.last_cursor,
      missingFrom: row.missing_from,
      missingTo: row.missing_to,
      terminal: row.terminal === 1,
    })
  }
  const eventIds = rows.map((row) => parseEventId(row.event_id))
  const base = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    eventCount: rows.length,
    revision: rows.length,
    eventIds,
    runs: [...runs.values()].sort((left, right) => left.runId.localeCompare(right.runId)),
  }
  let eventIdsDigest = PROJECTION_EVENT_DIGEST_SEED
  for (const eventId of eventIds)
    eventIdsDigest = appendProjectionEventDigest(eventIdsDigest, eventId)
  return {
    ...base,
    checksum: projectionChecksum({
      schemaVersion: base.schemaVersion,
      eventCount: base.eventCount,
      revision: base.revision,
      eventIdsDigest,
      runsDigest: projectionRunDigest(base.runs),
    }),
  }
}
