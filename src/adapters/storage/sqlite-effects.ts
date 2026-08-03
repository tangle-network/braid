import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson } from '../../domain/canonical.js'
import { parseConversationId, parseEventId } from '../../domain/ids.js'
import { credentialRef } from '../../ports/credentials.js'
import type { EffectRecord } from '../../ports/effect-storage.js'
import type { JsonValue, OperationIntent, ProjectionSnapshot } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'
import { pragmaNumber, SQLITE_SCHEMA_VERSION } from './sqlite-schema.js'
import { assertEffectRecordInput, assertOperationRequestDigest } from './storage-validation.js'

import { SqliteOperationStorage } from './sqlite-operations.js'
import { effectRecordFromRow, jsonValue, cloneJson, asNumber, asString } from './sqlite-rows.js'
import { classifySqliteError, assertApprovedPath, validatePath } from './sqlite-paths.js'

export abstract class SqliteEffectsStorage extends SqliteOperationStorage {
  async rebuild(operation: OperationIntent): Promise<ProjectionSnapshot> {
    assertOperationRequestDigest(operation, {})
    const replay = await this.reuseMutation<ProjectionSnapshot>(operation)
    if (replay !== undefined) return replay
    let mutationCommitted = false
    try {
      const result = await this.writes.run(async () => {
        this.assertOpen()
        this.begin()
        try {
          const projection = this.buildProjection()
          this.writeProjection(projection)
          this.commit('rebuild')
          mutationCommitted = true
          return structuredClone(projection)
        } catch (error) {
          this.rollback()
          throw classifySqliteError(error)
        }
      })
      await this.completeMutation(operation, 'terminal', jsonValue(result))
      return result
    } catch (error) {
      await this.completeMutationFailure(operation, error, mutationCommitted)
      throw error
    }
  }

  reserveEffect(record: EffectRecord): {
    readonly record: EffectRecord
    readonly created: boolean
  } {
    this.assertOpen()
    assertEffectRecordInput(record)
    this.begin()
    try {
      const admission = this.database
        .prepare('SELECT * FROM braid_effect_admissions WHERE operation_id = ?')
        .get(record.operationId) as
        | {
            readonly effect_kind?: unknown
            readonly request_digest?: unknown
            readonly attempt?: unknown
            readonly created_at?: unknown
            readonly updated_at?: unknown
          }
        | undefined
      if (admission) {
        const admittedDigest = asString(admission.request_digest, 'request_digest')
        const existing = this.database
          .prepare(
            `SELECT * FROM braid_effect_records
             WHERE operation_id = ? AND request_digest = ?
             ORDER BY effect_sequence DESC LIMIT 1`,
          )
          .get(record.operationId, admittedDigest) as Record<string, unknown> | undefined
        if (admittedDigest === record.requestDigest) {
          const replay = existing
            ? effectRecordFromRow(existing)
            : {
                ...record,
                effectKind: asString(admission.effect_kind, 'effect_kind'),
                attempt: asNumber(admission.attempt, 'attempt'),
                createdAt: asString(admission.created_at, 'created_at'),
                updatedAt: asString(admission.updated_at, 'updated_at'),
              }
          this.commit('effect.reserve.replay')
          return { record: replay, created: false }
        }
        const conflict: EffectRecord = {
          ...record,
          status: 'conflict',
          detail: `Operation is already bound to request digest ${admittedDigest}`,
          conflictWithDigest: admittedDigest,
        }
        this.insertEffectUnsafe(conflict)
        this.commit('effect.reserve.conflict')
        return { record: conflict, created: false }
      }
      this.database
        .prepare(
          `INSERT INTO braid_effect_admissions(
             operation_id, effect_kind, request_digest, attempt, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.operationId,
          record.effectKind,
          record.requestDigest,
          record.attempt,
          record.createdAt,
          record.updatedAt,
        )
      this.insertEffectUnsafe(record)
      this.commit('effect.reserve')
      return { record: structuredClone(record), created: true }
    } catch (error) {
      this.rollback()
      throw classifySqliteError(error)
    }
  }

  current(operationId: string): EffectRecord | undefined {
    this.assertOpen()
    const row = this.database
      .prepare(
        `SELECT * FROM braid_effect_records
       WHERE operation_id = ? AND status <> 'conflict'
       ORDER BY effect_sequence DESC LIMIT 1`,
      )
      .get(operationId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : effectRecordFromRow(row)
  }

  latest(operationId: string, requestDigest: string): EffectRecord | undefined {
    this.assertOpen()
    const row = this.database
      .prepare(
        `SELECT * FROM braid_effect_records
       WHERE operation_id = ? AND request_digest = ?
       ORDER BY effect_sequence DESC LIMIT 1`,
      )
      .get(operationId, requestDigest) as Record<string, unknown> | undefined
    return row === undefined ? undefined : effectRecordFromRow(row)
  }

  appendEffect(record: EffectRecord): void {
    this.assertOpen()
    assertEffectRecordInput(record)
    this.begin()
    try {
      this.insertEffectUnsafe(record)
      if (record.status !== 'conflict') {
        this.database
          .prepare(
            `UPDATE braid_effect_admissions
             SET effect_kind = ?, attempt = ?, updated_at = ?
             WHERE operation_id = ? AND request_digest = ?`,
          )
          .run(
            record.effectKind,
            record.attempt,
            record.updatedAt,
            record.operationId,
            record.requestDigest,
          )
      }
      this.commit('effect')
    } catch (error) {
      this.rollback()
      throw classifySqliteError(error)
    }
  }

  history(operationId: string): readonly EffectRecord[] {
    this.assertOpen()
    const rows = this.database
      .prepare('SELECT * FROM braid_effect_records WHERE operation_id = ? ORDER BY effect_sequence')
      .all(operationId) as readonly Record<string, unknown>[]
    return rows.map(effectRecordFromRow)
  }

  insertEffectUnsafe(record: EffectRecord): void {
    this.database
      .prepare(
        `INSERT INTO braid_effect_records(
        operation_id, effect_kind, request_digest, status, attempt, created_at,
        updated_at, metadata_json, detail, external_reference, conflict_with_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.operationId,
        record.effectKind,
        record.requestDigest,
        record.status,
        record.attempt,
        record.createdAt,
        record.updatedAt,
        canonicalJson(record.metadata),
        record.detail ?? null,
        record.externalReference ?? null,
        record.conflictWithDigest ?? null,
      )
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
    if (!reservation.created && reservation.record.status === 'pending') {
      const reconciled = await this.reconcilePendingMutation(intent)
      if (reconciled !== undefined) {
        await this.completeMutation(intent, 'terminal', jsonValue(reconciled))
        return reconciled as T
      }
      throw new StorageError(
        'OPERATION_OUTCOME_PENDING',
        `Operation ${intent.operationId} is pending and requires explicit reconciliation evidence`,
      )
    }
    if (
      !reservation.created &&
      (reservation.record.status === 'terminal' || reservation.record.status === 'acknowledged')
    ) {
      if (reservation.record.result === undefined) {
        throw new StorageError(
          'OPERATION_RESULT_MISSING',
          `Operation ${intent.operationId} has no stored result`,
        )
      }
      return cloneJson(reservation.record.result) as T
    }
    return undefined
  }

  async reconcilePendingMutation(intent: OperationIntent): Promise<JsonValue | undefined> {
    const request = intent.request
    const object =
      request !== null && typeof request === 'object' && !Array.isArray(request)
        ? (request as Readonly<Record<string, JsonValue>>)
        : undefined
    if (intent.kind === 'backup' && typeof object?.path === 'string') {
      const path = validatePath(object.path, 'Backup path')
      await assertApprovedPath(path, this.workspaceRoot ?? dirname(this.path), 'Backup path')
      const exists = await stat(path)
        .then(() => true)
        .catch(() => false)
      if (!exists) return undefined
      await this.assertEncryptedArtifact(path)
      this.assertReadableBackup(path)
      return { path, bytes: (await stat(path)).size, encrypted: true }
    }
    if (intent.kind === 'destruction' && typeof object?.conversationId === 'string') {
      const tombstone = this.database
        .prepare(
          'SELECT conversation_id FROM braid_conversation_tombstones WHERE conversation_id = ?',
        )
        .get(object.conversationId) as { readonly conversation_id?: unknown } | undefined
      if (tombstone) {
        return {
          conversationId: object.conversationId,
          destroyed: true,
          retainedCiphertext: true,
        }
      }
      return undefined
    }
    if (
      intent.kind === 'redact' &&
      typeof object?.conversationId === 'string' &&
      typeof object.eventId === 'string'
    ) {
      const record = this.database
        .prepare(
          'SELECT rewritten_at FROM braid_redaction_records WHERE conversation_id = ? AND event_id = ?',
        )
        .get(object.conversationId, object.eventId) as
        | { readonly rewritten_at?: unknown }
        | undefined
      if (!record) return undefined
      const keyRow = this.database
        .prepare('SELECT credential_ref FROM braid_conversation_keys WHERE conversation_id = ?')
        .get(object.conversationId) as { readonly credential_ref?: unknown } | undefined
      if (!keyRow) return undefined
      const ref = credentialRef(asString(keyRow.credential_ref, 'credential_ref'))
      const verified = await this.verifyConversation(
        parseConversationId(object.conversationId),
        parseEventId(object.eventId),
        ref,
      )
      if (!verified) return undefined
      const count = this.database
        .prepare('SELECT COUNT(*) AS count FROM braid_journal_events WHERE conversation_id = ?')
        .get(object.conversationId) as { readonly count?: unknown }
      return {
        conversationId: object.conversationId,
        redactedEventId: object.eventId,
        rewrittenEvents: asNumber(count.count, 'rewrittenEvents'),
        newContentKeyRef: ref,
      }
    }
    if (
      intent.kind === 'migrate' &&
      pragmaNumber(this.database, 'user_version') >= SQLITE_SCHEMA_VERSION
    ) {
      return {
        fromVersion: SQLITE_SCHEMA_VERSION,
        toVersion: SQLITE_SCHEMA_VERSION,
        migrated: false,
      }
    }
    if (intent.kind === 'rebuild') return this.buildProjection() as unknown as JsonValue
    if (intent.kind === 'compact') return { completed: true }
    if (intent.kind === 'retention') {
      const before = typeof object?.before === 'string' ? object.before : undefined
      if (!before) return undefined
      const pending = this.database
        .prepare(
          `SELECT 1 FROM braid_journal_events e
           JOIN braid_run_cursors c ON c.run_id = e.run_id
           WHERE e.received_at < ? AND e.redacted = 0 AND c.terminal = 1 LIMIT 1`,
        )
        .get(before)
      if (!pending) return { redactedEvents: 0, deletedConversations: [] }
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

  async completeMutationFailure(
    intent: OperationIntent,
    error: unknown,
    mutationCommitted = false,
  ): Promise<void> {
    const result: JsonValue = {
      code: mutationCommitted
        ? 'STORAGE_MUTATION_OUTCOME_UNKNOWN'
        : error instanceof StorageError
          ? error.code
          : 'STORAGE_MUTATION_FAILED',
      message: mutationCommitted
        ? 'The storage mutation committed but its final outcome is unknown'
        : error instanceof StorageError
          ? error.code
          : 'Storage mutation failed',
    }
    try {
      await this.completeMutation(intent, mutationCommitted ? 'unknown' : 'failed', result)
    } catch {
      await this.completeMutation(intent, 'unknown', {
        code: 'STORAGE_MUTATION_OUTCOME_UNKNOWN',
      }).catch(() => undefined)
    }
  }
}
