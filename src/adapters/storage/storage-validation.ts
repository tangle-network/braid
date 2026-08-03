import { canonicalDigest } from '../../domain/canonical.js'
import {
  parseConversationId,
  parseEventId,
  parseOperationId,
  parseReplayCursor,
  parseRunId,
  parseWorkspaceId,
} from '../../domain/ids.js'
import { isSafePublicMetadata } from '../../domain/public-metadata.js'
import { containsUnsafeControlCharacter, isCanonicalIsoDateTime } from '../../domain/text.js'
import type { EffectRecord } from '../../ports/effect-storage.js'
import type { JournalEvent, JsonValue, OperationIntent } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'

export function assertJournalEventInput(event: JournalEvent): void {
  try {
    parseWorkspaceId(event.workspaceId)
    parseConversationId(event.conversationId)
    parseRunId(event.runId)
    parseEventId(event.eventId)
    if (
      event.providerEventId !== undefined &&
      (typeof event.providerEventId !== 'string' ||
        event.providerEventId.length === 0 ||
        event.providerEventId.length > 4096 ||
        event.providerEventId.includes('\u0000') ||
        event.providerEventId.includes('\r') ||
        event.providerEventId.includes('\n'))
    ) {
      throw new StorageError(
        'EVENT_INVALID',
        'Provider event identity must be a bounded single-line string',
      )
    }
    if (event.operationId !== undefined) parseOperationId(event.operationId)
    if (event.cursor !== undefined) parseReplayCursor(event.cursor)
  } catch (error) {
    throw new StorageError(
      'EVENT_INVALID',
      'Journal event contains an identifier from the wrong domain',
      { cause: error },
    )
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new StorageError('EVENT_INVALID', 'Journal event sequence must be a positive integer')
  }
  if (typeof event.kind !== 'string' || event.kind.length === 0 || event.kind.length > 256) {
    throw new StorageError('EVENT_INVALID', 'Journal event kind must be a non-empty bounded string')
  }
  if (!isCanonicalIsoDateTime(event.occurredAt)) {
    throw new StorageError('EVENT_INVALID', 'Journal event occurredAt must be a canonical ISO date')
  }
  if (event.receivedAt !== undefined && !isCanonicalIsoDateTime(event.receivedAt)) {
    throw new StorageError('EVENT_INVALID', 'Journal event receivedAt must be a canonical ISO date')
  }
}

export function assertOperationIntentInput(intent: OperationIntent): void {
  try {
    parseOperationId(intent.operationId)
  } catch (error) {
    throw new StorageError('OPERATION_INVALID', 'Operation identifier is not valid', {
      cause: error,
    })
  }
  if (!/^[0-9a-f]{64}$/u.test(intent.requestDigest)) {
    throw new StorageError('OPERATION_INVALID', 'Operation request digest must be a SHA-256 digest')
  }
  if (canonicalDigest(intent.request) !== intent.requestDigest) {
    throw new StorageError(
      'OPERATION_INVALID',
      'Operation request digest does not match the canonical request',
    )
  }
  if (typeof intent.kind !== 'string' || intent.kind.length === 0 || intent.kind.length > 256) {
    throw new StorageError('OPERATION_INVALID', 'Operation kind must be a non-empty bounded string')
  }
  if (intent.createdAt !== undefined && !isCanonicalIsoDateTime(intent.createdAt)) {
    throw new StorageError('OPERATION_INVALID', 'Operation createdAt must be a canonical ISO date')
  }
}

export function assertOperationRequestDigest(intent: OperationIntent, request: JsonValue): void {
  assertOperationIntentInput(intent)
  if (canonicalDigest(request) !== intent.requestDigest) {
    throw new StorageError(
      'OPERATION_INVALID',
      'Operation request digest does not cover the complete storage mutation request',
    )
  }
}

export function assertEffectRecordInput(record: EffectRecord): void {
  try {
    parseOperationId(record.operationId)
  } catch (error) {
    throw new StorageError('EFFECT_INVALID', 'Effect operation identifier is not valid', {
      cause: error,
    })
  }
  if (!/^[0-9a-f]{64}$/u.test(record.requestDigest)) {
    throw new StorageError('EFFECT_INVALID', 'Effect request digest must be a SHA-256 digest')
  }
  if (
    typeof record.effectKind !== 'string' ||
    record.effectKind.length === 0 ||
    record.effectKind.length > 256
  ) {
    throw new StorageError('EFFECT_INVALID', 'Effect kind must be a non-empty bounded string')
  }
  if (!Number.isSafeInteger(record.attempt) || record.attempt < 1) {
    throw new StorageError('EFFECT_INVALID', 'Effect attempt must be a positive integer')
  }
  if (
    !isCanonicalIsoDateTime(record.createdAt) ||
    !isCanonicalIsoDateTime(record.updatedAt) ||
    record.updatedAt < record.createdAt
  ) {
    throw new StorageError(
      'EFFECT_INVALID',
      'Effect timestamps must be canonical ISO dates in order',
    )
  }
  if (
    !['pending', 'acknowledged', 'failed', 'unknown', 'conflict', 'terminal'].includes(
      record.status,
    )
  ) {
    throw new StorageError('EFFECT_INVALID', 'Effect status is not recognized')
  }
  const safeText = (value: string, field: string, maximum: number): void => {
    if (
      value.length > maximum ||
      containsUnsafeControlCharacter(value) ||
      /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)\s*[:=]/iu.test(
        value,
      )
    ) {
      throw new StorageError('EFFECT_INVALID', `${field} contains unsafe diagnostic text`)
    }
  }
  if (record.detail !== undefined) safeText(record.detail, 'Effect detail', 128)
  if (record.externalReference !== undefined)
    safeText(record.externalReference, 'Effect external reference', 256)
  if (!isSafePublicMetadata(record.metadata)) {
    throw new StorageError(
      'EFFECT_INVALID',
      'Effect metadata must contain only bounded public strings',
    )
  }
}
