import { parseOperationId } from '../../domain/ids.js'
import { isCanonicalIsoDateTime } from '../../domain/text.js'
import type {
  IntegrityReport,
  JsonValue,
  OperationId,
  OperationIntent,
  OperationRecord,
  OperationReservation,
  ProjectionSnapshot,
} from '../../ports/storage.js'
import { PROJECTION_SCHEMA_VERSION } from '../../ports/storage.js'
import { assertPersistablePayload } from './sqlite-crypto.js'
import { StorageError } from './sqlite-errors.js'
import { assertOperationIntentInput, assertOperationRequestDigest } from './storage-validation.js'
import { clone, jsonValue, projectionOf } from './memory-base.js'

import { MemoryJournalStorage } from './memory-journal.js'

export class MemoryOperationStorage extends MemoryJournalStorage {
  async rebuild(operation: OperationIntent): Promise<ProjectionSnapshot> {
    this.assertOpen()
    assertOperationRequestDigest(operation, {})
    const replay = await this.reuseMutation<ProjectionSnapshot>(operation)
    if (replay !== undefined) return replay
    this.projectionState = projectionOf(this.eventStore, [...this.cursorStore.values()])
    const result = clone(this.projectionState)
    await this.completeMutation(operation, 'terminal', jsonValue(result))
    return result
  }

  async reserveOperation(intent: OperationIntent): Promise<OperationReservation> {
    this.assertOpen()
    assertOperationIntentInput(intent)
    assertPersistablePayload(intent.request)
    const existing = this.operationStore.get(intent.operationId)
    if (existing) {
      if (existing.requestDigest !== intent.requestDigest) {
        const conflict = {
          ...existing,
          status: 'conflict' as const,
          updatedAt: new Date().toISOString(),
        }
        return { record: clone(conflict), created: false }
      }
      return { record: clone(existing), created: false }
    }
    const createdAt = intent.createdAt ?? new Date().toISOString()
    const record: OperationRecord = {
      ...intent,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    }
    this.operationStore.set(intent.operationId, record)
    return { record: clone(record), created: true }
  }

  async completeOperation(input: {
    readonly operationId: OperationId
    readonly requestDigest: string
    readonly status: Exclude<import('../../ports/storage.js').EffectStatus, 'pending' | 'conflict'>
    readonly result?: JsonValue
    readonly updatedAt?: string
  }): Promise<OperationRecord> {
    this.assertOpen()
    parseOperationId(input.operationId)
    if (!/^[0-9a-f]{64}$/u.test(input.requestDigest)) {
      throw new StorageError(
        'OPERATION_INVALID',
        'Operation request digest must be a SHA-256 digest',
      )
    }
    if (input.updatedAt !== undefined && !isCanonicalIsoDateTime(input.updatedAt)) {
      throw new StorageError(
        'OPERATION_INVALID',
        'Operation updatedAt must be a canonical ISO date',
      )
    }
    const current = this.operationStore.get(input.operationId)
    if (!current)
      throw new StorageError(
        'OPERATION_NOT_FOUND',
        `Operation ${input.operationId} was not reserved`,
      )
    if (current.requestDigest !== input.requestDigest) {
      const conflict = {
        ...current,
        status: 'conflict' as const,
        updatedAt: input.updatedAt ?? new Date().toISOString(),
      }
      return clone(conflict)
    }
    if (current.status !== 'pending' && current.status !== 'unknown') return clone(current)
    if (input.result !== undefined) assertPersistablePayload(input.result)
    const next: OperationRecord = {
      ...current,
      status: input.status,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
      ...(input.result === undefined ? {} : { result: clone(input.result) }),
    }
    this.operationStore.set(input.operationId, next)
    return clone(next)
  }

  async recordOperationConflict(input: {
    readonly operationId: OperationId
    readonly requestDigest: string
    readonly attemptedDigest: string
    readonly occurredAt?: string
  }): Promise<void> {
    this.assertOpen()
    parseOperationId(input.operationId)
    if (
      !/^[0-9a-f]{64}$/u.test(input.requestDigest) ||
      !/^[0-9a-f]{64}$/u.test(input.attemptedDigest)
    ) {
      throw new StorageError(
        'OPERATION_INVALID',
        'Operation conflict digests must be SHA-256 digests',
      )
    }
    if (input.requestDigest === input.attemptedDigest) {
      throw new StorageError('OPERATION_INVALID', 'A conflict requires a different digest')
    }
    if (input.occurredAt !== undefined && !isCanonicalIsoDateTime(input.occurredAt)) {
      throw new StorageError(
        'OPERATION_INVALID',
        'Operation conflict occurredAt must be a canonical ISO date',
      )
    }
    const current = this.operationStore.get(input.operationId)
    if (!current) {
      throw new StorageError(
        'OPERATION_NOT_FOUND',
        `Operation ${input.operationId} was not reserved`,
      )
    }
    if (current.requestDigest !== input.requestDigest) {
      throw new StorageError(
        'OPERATION_CONFLICT',
        `Operation ${input.operationId} is bound to another request digest`,
      )
    }
  }

  async operation(operationId: OperationId): Promise<OperationRecord | null> {
    this.assertOpen()
    const record = this.operationStore.get(operationId)
    return record === undefined ? null : clone(record)
  }

  async integrity(): Promise<IntegrityReport> {
    this.assertOpen()
    return {
      ok: true,
      encryption: 'not-applicable',
      quickCheck: true,
      fullCheck: true,
      foreignKeys: true,
      wal: false,
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      errors: [],
    }
  }

  async reuseMutation<T>(intent: OperationIntent): Promise<T | undefined> {
    const reservation = await this.reserveOperation(intent)
    if (reservation.record.status === 'conflict') {
      throw new StorageError(
        'OPERATION_CONFLICT',
        `Operation ${intent.operationId} was reused with a different request digest`,
      )
    }
    if (!reservation.created && reservation.record.status === 'failed') {
      throw new StorageError(
        'OPERATION_FAILED_REPLAY',
        `Operation ${intent.operationId} already failed; use a new operation identifier to retry`,
      )
    }
    if (!reservation.created && reservation.record.status === 'unknown') {
      throw new StorageError(
        'OPERATION_OUTCOME_UNKNOWN',
        `Operation ${intent.operationId} has an unknown outcome and requires reconciliation`,
      )
    }
    if (
      !reservation.created &&
      (reservation.record.status === 'terminal' || reservation.record.status === 'acknowledged')
    ) {
      if (reservation.record.result === undefined)
        throw new StorageError(
          'OPERATION_RESULT_MISSING',
          `Operation ${intent.operationId} has no stored result`,
        )
      return clone(reservation.record.result) as T
    }
    return undefined
  }

  async completeMutation(
    intent: OperationIntent,
    status: 'terminal' | 'failed' | 'unknown',
    result: JsonValue,
  ): Promise<void> {
    await this.completeOperation({
      operationId: intent.operationId,
      requestDigest: intent.requestDigest,
      status,
      result,
    })
  }

  async completeMutationFailure(intent: OperationIntent, error: unknown): Promise<void> {
    const result: JsonValue = {
      code: error instanceof StorageError ? error.code : 'STORAGE_MUTATION_FAILED',
      message: error instanceof StorageError ? error.code : 'Storage mutation failed',
    }
    try {
      await this.completeMutation(intent, 'failed', result)
    } catch {
      await this.completeMutation(intent, 'unknown', {
        code: 'STORAGE_MUTATION_OUTCOME_UNKNOWN',
      }).catch(() => undefined)
    }
  }
}
