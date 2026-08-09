import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { canonicalDigest } from '../../domain/canonical.js'
import { parseConversationId, parseRunId } from '../../domain/ids.js'
import { credentialRef } from '../../ports/credentials.js'
import type {
  ConversationId,
  DestructionReport,
  EventId,
  NonTerminalRun,
  OperationIntent,
  RedactionReport,
  RetentionReport,
} from '../../ports/storage.js'
import { decryptPayload, encryptPayload, payloadChecksum } from './sqlite-crypto.js'
import type { SqliteValue } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'
import { SqliteMaintenanceStorage } from './sqlite-maintenance.js'
import { classifySqliteError } from './sqlite-paths.js'
import {
  asBuffer,
  asString,
  missingFromCursor,
  now,
  redactedPersistedPayload,
  redactionReasonDigest,
} from './sqlite-rows.js'
import type { CursorRow, SqliteEventRow } from './sqlite-types.js'
import { assertOperationRequestDigest } from './storage-validation.js'

export class SqliteRedactionStorage extends SqliteMaintenanceStorage {
  async applyRetention(input: {
    readonly before: string
    readonly conversationId?: ConversationId
    readonly operation: OperationIntent
  }): Promise<RetentionReport> {
    assertOperationRequestDigest(input.operation, {
      before: input.before,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    })
    const replay = await this.reuseMutation<RetentionReport>(input.operation)
    if (replay !== undefined) return replay
    let mutationCommitted = false
    try {
      const result = await this.writes.run(async () => {
        this.assertOpen()
        const conditions = ['e.received_at < ?', 'e.redacted = 0', 'c.terminal = 1']
        const parameters: SqliteValue[] = [input.before]
        if (input.conversationId !== undefined) {
          conditions.push('e.conversation_id = ?')
          parameters.push(input.conversationId)
        }
        const rows = this.database
          .prepare(
            `SELECT e.* FROM braid_journal_events e
         JOIN braid_run_cursors c ON c.run_id = e.run_id WHERE ${conditions.join(' AND ')}`,
          )
          .all(...parameters) as readonly SqliteEventRow[]
        if (rows.length === 0) return { redactedEvents: 0, deletedConversations: [] }
        const keys = new Map<ConversationId, Buffer>()
        try {
          for (const row of rows) {
            const conversationId = parseConversationId(row.conversation_id)
            if (!keys.has(conversationId)) {
              const key = await this.existingContentKey(conversationId)
              if (!key)
                throw new StorageError(
                  'CONTENT_KEY_UNAVAILABLE',
                  `Content key for ${conversationId} is unavailable`,
                )
              keys.set(conversationId, key)
            }
          }
          await this.stateSnapshots.destroyKeysBeforeMutation()
          this.begin()
          for (const row of rows) {
            const conversationId = parseConversationId(row.conversation_id)
            const key = keys.get(conversationId)
            if (!key)
              throw new StorageError(
                'CONTENT_KEY_UNAVAILABLE',
                'Retention content key is unavailable',
              )
            const original = decryptPayload(asBuffer(row.payload, 'payload'), key)
            const marker = redactedPersistedPayload(original, row, 'retention')
            const encoded = encryptPayload(marker, key)
            this.database
              .prepare(
                'UPDATE braid_journal_events SET payload = ?, redacted = 1, payload_checksum = ? WHERE conversation_id = ? AND event_id = ?',
              )
              .run(encoded, payloadChecksum(marker), row.conversation_id, row.event_id)
            encoded.fill(0)
            this.database
              .prepare(
                `INSERT INTO braid_redaction_records(conversation_id, event_id, reason, rewritten_at)
             VALUES (?, ?, 'retention', ?) ON CONFLICT(conversation_id, event_id) DO UPDATE SET reason = excluded.reason, rewritten_at = excluded.rewritten_at`,
              )
              .run(row.conversation_id, row.event_id, now())
          }
          this.stateSnapshots.invalidateUnsafe()
          this.commit('retention')
          mutationCommitted = true
          await this.stateSnapshots.finishInvalidationUnsafe()
          return { redactedEvents: rows.length, deletedConversations: [] }
        } catch (error) {
          if (!mutationCommitted) this.rollback()
          throw classifySqliteError(error)
        } finally {
          for (const key of keys.values()) key.fill(0)
        }
      })
      await this.completeMutation(input.operation, 'terminal', result)
      return result
    } catch (error) {
      await this.completeMutationFailure(input.operation, error, mutationCommitted)
      throw error
    }
  }

  async redact(input: {
    readonly conversationId: ConversationId
    readonly eventId: EventId
    readonly reason: string
    readonly operation: OperationIntent
  }): Promise<RedactionReport> {
    assertOperationRequestDigest(input.operation, {
      conversationId: input.conversationId,
      eventId: input.eventId,
      reasonDigest: canonicalDigest(input.reason),
    })
    const replay = await this.reuseMutation<RedactionReport>(input.operation)
    if (replay !== undefined) return replay
    let mutationCommitted = false
    try {
      const result = await this.writes.run(async () =>
        this.withExclusiveLock(async () => {
          this.assertOpen()
          const target = this.database
            .prepare(
              'SELECT * FROM braid_journal_events WHERE conversation_id = ? AND event_id = ?',
            )
            .get(input.conversationId, input.eventId) as SqliteEventRow | undefined
          if (!target)
            throw new StorageError('EVENT_NOT_FOUND', `Event ${input.eventId} was not found`)
          const keyRow = this.database
            .prepare(
              'SELECT credential_ref, destroyed FROM braid_conversation_keys WHERE conversation_id = ?',
            )
            .get(input.conversationId) as
            | { readonly credential_ref?: unknown; readonly destroyed?: unknown }
            | undefined
          const oldRef =
            keyRow === undefined || Number(keyRow.destroyed) === 1
              ? undefined
              : credentialRef(asString(keyRow.credential_ref, 'credential_ref'))
          const oldKey = await this.existingContentKey(input.conversationId)
          if (!oldKey)
            throw new StorageError('CONTENT_KEY_UNAVAILABLE', 'The old content key is unavailable')
          if (oldRef === undefined) {
            oldKey.fill(0)
            throw new StorageError(
              'CONTENT_KEY_UNAVAILABLE',
              'The conversation has no replaceable content key',
            )
          }
          const newRef = credentialRef(
            `cred:v1:content-redacted-${createHash('sha256').update(input.conversationId).digest('hex')}-${randomUUID()}`,
          )
          const newKey = randomBytes(32)
          const rows = this.database
            .prepare(
              'SELECT * FROM braid_journal_events WHERE conversation_id = ? ORDER BY storage_id',
            )
            .all(input.conversationId) as readonly SqliteEventRow[]
          let rewritten: Array<{
            readonly row: SqliteEventRow
            readonly encoded: Buffer
            readonly checksum: string
            readonly redacted: boolean
          }> = []
          try {
            await this.stateSnapshots.destroyKeysBeforeMutation()
            this.begin()
            try {
              this.database
                .prepare(
                  `INSERT INTO braid_content_key_rotations(
               conversation_id, old_credential_ref, new_credential_ref, redacted_event_id, phase, prepared_at
             ) VALUES (?, ?, ?, ?, 'prepared', ?)
             ON CONFLICT(conversation_id) DO UPDATE SET old_credential_ref = excluded.old_credential_ref,
             new_credential_ref = excluded.new_credential_ref, redacted_event_id = excluded.redacted_event_id,
             phase = excluded.phase, prepared_at = excluded.prepared_at`,
                )
                .run(input.conversationId, oldRef, newRef, input.eventId, now())
              this.commit('redaction.prepare')
            } catch (error) {
              this.rollback()
              throw error
            }

            this.durableBoundaryHook?.('before:redaction.key.store')
            await this.credentials.store({ ref: newRef, value: newKey })
            this.durableBoundaryHook?.('after:redaction.key.store')
            rewritten = rows.map((row) => {
              const oldPayload = decryptPayload(asBuffer(row.payload, 'payload'), oldKey)
              const nextPayload =
                row.event_id === input.eventId
                  ? redactedPersistedPayload(oldPayload, row, input.reason)
                  : oldPayload
              const encoded = encryptPayload(nextPayload, newKey)
              return {
                row,
                encoded,
                checksum: payloadChecksum(nextPayload),
                redacted: row.event_id === input.eventId || row.redacted === 1,
              }
            })

            this.begin()
            for (const item of rewritten) {
              this.database
                .prepare(
                  'UPDATE braid_journal_events SET payload = ?, payload_checksum = ?, redacted = ? WHERE storage_id = ?',
                )
                .run(item.encoded, item.checksum, item.redacted ? 1 : 0, item.row.storage_id)
              item.encoded.fill(0)
            }
            this.database
              .prepare(
                'UPDATE braid_conversation_keys SET credential_ref = ?, destroyed = 0 WHERE conversation_id = ?',
              )
              .run(newRef, input.conversationId)
            this.database
              .prepare(
                `UPDATE braid_content_key_rotations
               SET phase = 'rewritten' WHERE conversation_id = ?`,
              )
              .run(input.conversationId)
            this.database
              .prepare(
                `INSERT INTO braid_redaction_records(conversation_id, event_id, reason, rewritten_at)
             VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id, event_id) DO UPDATE SET reason = excluded.reason, rewritten_at = excluded.rewritten_at`,
              )
              .run(input.conversationId, input.eventId, redactionReasonDigest(input.reason), now())
            this.stateSnapshots.invalidateUnsafe()
            this.commit('redaction')
            mutationCommitted = true
            await this.stateSnapshots.finishInvalidationUnsafe()
          } catch (error) {
            if (!mutationCommitted) {
              this.rollback()
              await this.removeCredentialIfPresent(newRef).catch(() => undefined)
              this.begin()
              try {
                this.database
                  .prepare('DELETE FROM braid_content_key_rotations WHERE conversation_id = ?')
                  .run(input.conversationId)
                this.commit('redaction.prepare.cleanup')
              } catch {
                this.rollback()
              }
            }
            for (const item of rewritten) item.encoded.fill(0)
            oldKey.fill(0)
            newKey.fill(0)
            throw classifySqliteError(error)
          }
          for (const item of rewritten) item.encoded.fill(0)
          try {
            const verification = await this.verifyConversation(
              input.conversationId,
              input.eventId,
              newRef,
            )
            if (!verification) {
              throw new StorageError(
                'REDACTION_VERIFY_FAILED',
                'Redaction rewrite verification failed',
              )
            }
            this.durableBoundaryHook?.('before:redaction.old-key.remove')
            await this.removeCredentialIfPresent(oldRef)
            this.durableBoundaryHook?.('after:redaction.old-key.remove')
            this.begin()
            try {
              this.database
                .prepare('DELETE FROM braid_content_key_rotations WHERE conversation_id = ?')
                .run(input.conversationId)
              this.commit('redaction.cleanup')
            } catch (error) {
              this.rollback()
              throw error
            }
          } catch (error) {
            // A committed rewrite is recoverable: the rotation row intentionally
            // remains until startup can finish key cleanup.
            throw error instanceof StorageError
              ? error
              : new StorageError(
                  'REDACTION_CLEANUP_FAILED',
                  'Redaction key cleanup did not complete',
                  { cause: error },
                )
          } finally {
            oldKey.fill(0)
            newKey.fill(0)
          }
          return {
            conversationId: input.conversationId,
            redactedEventId: input.eventId,
            rewrittenEvents: rewritten.length,
            newContentKeyRef: newRef,
          }
        }),
      )
      await this.completeMutation(input.operation, 'terminal', result)
      return result
    } catch (error) {
      await this.completeMutationFailure(input.operation, error, mutationCommitted)
      throw error
    }
  }

  async destroyConversation(input: {
    readonly conversationId: ConversationId
    readonly reason: string
    readonly operation: OperationIntent
  }): Promise<DestructionReport> {
    assertOperationRequestDigest(input.operation, {
      conversationId: input.conversationId,
      reasonDigest: canonicalDigest(input.reason),
    })
    const replay = await this.reuseMutation<DestructionReport>(input.operation)
    if (replay !== undefined) return replay
    let mutationCommitted = false
    try {
      const result = await this.writes.run(async () => {
        this.assertOpen()
        const tombstone = this.database
          .prepare('SELECT reason FROM braid_conversation_tombstones WHERE conversation_id = ?')
          .get(input.conversationId) as { readonly reason?: unknown } | undefined
        if (tombstone) {
          return {
            conversationId: input.conversationId,
            destroyed: true,
            retainedCiphertext: true,
          }
        }
        const keyRow = this.database
          .prepare('SELECT credential_ref FROM braid_conversation_keys WHERE conversation_id = ?')
          .get(input.conversationId) as { readonly credential_ref?: unknown } | undefined
        if (!keyRow)
          throw new StorageError(
            'CONVERSATION_NOT_FOUND',
            `Conversation ${input.conversationId} was not found`,
          )
        const ref = credentialRef(asString(keyRow.credential_ref, 'credential_ref'))
        await this.stateSnapshots.destroyKeysBeforeMutation()
        this.begin()
        try {
          this.database
            .prepare('UPDATE braid_journal_events SET redacted = 0 WHERE conversation_id = ?')
            .run(input.conversationId)
          this.database
            .prepare('UPDATE braid_conversation_keys SET destroyed = 1 WHERE conversation_id = ?')
            .run(input.conversationId)
          this.database
            .prepare(
              `INSERT INTO braid_conversation_tombstones(conversation_id, reason, deleted_at)
               VALUES (?, ?, ?)
               ON CONFLICT(conversation_id) DO UPDATE SET reason = excluded.reason, deleted_at = excluded.deleted_at`,
            )
            .run(input.conversationId, redactionReasonDigest(input.reason), now())
          this.stateSnapshots.invalidateUnsafe()
          this.writeProjection(this.buildProjection())
          this.commit('destruction')
          mutationCommitted = true
          await this.stateSnapshots.finishInvalidationUnsafe()
        } catch (error) {
          this.rollback()
          throw classifySqliteError(error)
        }
        try {
          await this.credentials.remove(ref)
        } catch (error) {
          throw new StorageError(
            'CONTENT_KEY_DESTRUCTION_FAILED',
            'Conversation content key destruction failed',
            { cause: error },
          )
        }
        return { conversationId: input.conversationId, destroyed: true, retainedCiphertext: true }
      })
      await this.completeMutation(input.operation, 'terminal', result)
      return result
    } catch (error) {
      await this.completeMutationFailure(input.operation, error, mutationCommitted)
      throw error
    }
  }

  async compact(operation: OperationIntent): Promise<void> {
    assertOperationRequestDigest(operation, {})
    const replay = await this.reuseMutation<{ readonly completed: true }>(operation)
    if (replay !== undefined) return
    let mutationCommitted = false
    try {
      await this.writes.run(async () => {
        this.assertOpen()
        try {
          this.database.pragma('wal_checkpoint(TRUNCATE)')
          this.database.exec('VACUUM')
          mutationCommitted = true
          await this.secureArtifacts()
        } catch (error) {
          throw classifySqliteError(error)
        }
      })
      await this.completeMutation(operation, 'terminal', { completed: true })
    } catch (error) {
      await this.completeMutationFailure(operation, error, mutationCommitted)
      throw error
    }
  }

  async reconcileNonTerminalRuns(): Promise<readonly NonTerminalRun[]> {
    this.assertOpen()
    const rows = this.database
      .prepare('SELECT * FROM braid_run_cursors WHERE terminal = 0 ORDER BY run_id')
      .all() as readonly CursorRow[]
    return rows.map((row) => ({
      runId: parseRunId(row.run_id),
      conversationId: parseConversationId(row.conversation_id),
      lastSequence: row.last_sequence,
      lastCursor: row.last_cursor,
      missingHistory: missingFromCursor(row),
    }))
  }
}
