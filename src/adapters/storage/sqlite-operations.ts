import { canonicalJson } from '../../domain/canonical.js'
import { parseOperationId } from '../../domain/ids.js'
import { isCanonicalIsoDateTime } from '../../domain/text.js'
import type {
  JsonValue,
  OperationId,
  OperationIntent,
  OperationRecord,
  OperationReservation,
} from '../../ports/storage.js'
import { assertPersistablePayload } from './sqlite-crypto.js'
import { StorageError } from './sqlite-errors.js'
import { assertOperationIntentInput } from './storage-validation.js'

import { SqliteJournalStorage } from './sqlite-journal.js'
import type { OperationRow } from './sqlite-types.js'
import { asString, cloneJson, now, operationRecordFromRow } from './sqlite-rows.js'
import { classifySqliteError } from './sqlite-paths.js'

export abstract class SqliteOperationStorage extends SqliteJournalStorage {
  async reserveOperation(intent: OperationIntent): Promise<OperationReservation> {
    assertOperationIntentInput(intent)
    assertPersistablePayload(intent.request)
    const createdAt = intent.createdAt ?? now()
    return this.writes.run(async () => {
      this.assertOpen()
      this.begin()
      try {
        const existingRow = this.database
          .prepare('SELECT * FROM braid_operation_records WHERE operation_id = ?')
          .get(intent.operationId) as OperationRow | undefined
        if (existingRow) {
          const existing = operationRecordFromRow(existingRow)
          if (existing.requestDigest !== intent.requestDigest) {
            this.recordOperationConflictUnsafe(
              intent.operationId,
              existing.requestDigest,
              intent.requestDigest,
              createdAt,
            )
            this.commit('operation.reserve.conflict')
            return {
              created: false,
              record: { ...existing, status: 'conflict', updatedAt: createdAt },
            }
          }
          this.commit('operation.reserve.replay')
          return { created: false, record: existing }
        }
        this.database
          .prepare(
            `INSERT INTO braid_operation_records(
            operation_id, operation_kind, request_digest, request_json, status, result_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
          )
          .run(
            intent.operationId,
            intent.kind,
            intent.requestDigest,
            canonicalJson(intent.request),
            createdAt,
            createdAt,
          )
        this.commit('operation.reserve')
        return {
          created: true,
          record: {
            ...intent,
            createdAt,
            updatedAt: createdAt,
            status: 'pending',
          },
        }
      } catch (error) {
        this.rollback()
        throw classifySqliteError(error)
      }
    })
  }

  async completeOperation(input: {
    readonly operationId: OperationId
    readonly requestDigest: string
    readonly status: Exclude<import('../../ports/storage.js').EffectStatus, 'pending' | 'conflict'>
    readonly result?: JsonValue
    readonly updatedAt?: string
  }): Promise<OperationRecord> {
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
    if (input.result !== undefined) assertPersistablePayload(input.result)
    return this.writes.run(async () => {
      this.assertOpen()
      this.begin()
      try {
        const row = this.database
          .prepare('SELECT * FROM braid_operation_records WHERE operation_id = ?')
          .get(input.operationId) as OperationRow | undefined
        if (!row)
          throw new StorageError(
            'OPERATION_NOT_FOUND',
            `Operation ${input.operationId} was not reserved`,
          )
        const current = operationRecordFromRow(row)
        if (current.requestDigest !== input.requestDigest) {
          this.recordOperationConflictUnsafe(
            input.operationId,
            current.requestDigest,
            input.requestDigest,
            input.updatedAt ?? now(),
          )
          this.commit('operation.complete.conflict')
          return { ...current, status: 'conflict', updatedAt: input.updatedAt ?? now() }
        }
        if (current.status !== 'pending' && current.status !== 'unknown') {
          this.commit('operation.complete.replay')
          return current
        }
        const updatedAt = input.updatedAt ?? now()
        this.database
          .prepare(
            'UPDATE braid_operation_records SET status = ?, result_json = ?, updated_at = ? WHERE operation_id = ?',
          )
          .run(
            input.status,
            input.result === undefined ? null : canonicalJson(input.result),
            updatedAt,
            input.operationId,
          )
        this.commit('operation.complete')
        return {
          ...current,
          status: input.status,
          updatedAt,
          ...(input.result === undefined ? {} : { result: cloneJson(input.result) }),
        }
      } catch (error) {
        this.rollback()
        throw classifySqliteError(error)
      }
    })
  }

  async recordOperationConflict(input: {
    readonly operationId: OperationId
    readonly requestDigest: string
    readonly attemptedDigest: string
    readonly occurredAt?: string
  }): Promise<void> {
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
    await this.writes.run(async () => {
      this.assertOpen()
      this.begin()
      try {
        const current = this.database
          .prepare('SELECT request_digest FROM braid_operation_records WHERE operation_id = ?')
          .get(input.operationId) as { readonly request_digest?: unknown } | undefined
        if (!current) {
          throw new StorageError(
            'OPERATION_NOT_FOUND',
            `Operation ${input.operationId} was not reserved`,
          )
        }
        if (asString(current.request_digest, 'request_digest') !== input.requestDigest) {
          throw new StorageError(
            'OPERATION_CONFLICT',
            `Operation ${input.operationId} is bound to another request digest`,
          )
        }
        this.recordOperationConflictUnsafe(
          input.operationId,
          input.requestDigest,
          input.attemptedDigest,
          input.occurredAt ?? now(),
        )
        this.commit('operation.conflict')
      } catch (error) {
        this.rollback()
        throw classifySqliteError(error)
      }
    })
  }

  async operation(operationId: OperationId): Promise<OperationRecord | null> {
    this.assertOpen()
    const row = this.database
      .prepare('SELECT * FROM braid_operation_records WHERE operation_id = ?')
      .get(operationId) as OperationRow | undefined
    return row ? operationRecordFromRow(row) : null
  }

  recordOperationConflictUnsafe(
    operationId: OperationId,
    originalDigest: string,
    attemptedDigest: string,
    occurredAt: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO braid_operation_conflicts(operation_id, attempted_digest, original_digest, occurred_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(operation_id, attempted_digest) DO NOTHING`,
      )
      .run(operationId, attemptedDigest, originalDigest, occurredAt)
  }

  reserveRestoredOperationUnsafe(intent: OperationIntent): void {
    const existing = this.database
      .prepare('SELECT request_digest FROM braid_operation_records WHERE operation_id = ?')
      .get(intent.operationId) as { readonly request_digest?: unknown } | undefined
    if (existing) {
      if (asString(existing.request_digest, 'request_digest') !== intent.requestDigest) {
        throw new StorageError(
          'OPERATION_CONFLICT',
          `Operation ${intent.operationId} conflicts with the restored database`,
        )
      }
      return
    }
    const createdAt = intent.createdAt ?? now()
    this.begin()
    try {
      this.database
        .prepare(
          `INSERT INTO braid_operation_records(
            operation_id, operation_kind, request_digest, request_json, status,
            result_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
        )
        .run(
          intent.operationId,
          intent.kind,
          intent.requestDigest,
          canonicalJson(intent.request),
          createdAt,
          createdAt,
        )
      this.commit('restore.operation.reserve')
    } catch (error) {
      this.rollback()
      throw classifySqliteError(error)
    }
  }
}
