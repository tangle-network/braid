import { canonicalJson } from '../../domain/canonical.js'
import type { CredentialRef } from '../../ports/credentials.js'
import { CredentialError } from '../../ports/credentials.js'
import type {
  AppendResult,
  ConversationId,
  EventId,
  JournalEvent,
  ProjectionSnapshot,
  ReplayResult,
  RunId,
  StoredJournalEvent,
  WorkspaceId,
} from '../../ports/storage.js'
import { assertPersistablePayload, encryptPayload, payloadChecksum } from './sqlite-crypto.js'
import type { SqliteValue } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'
import { assertJournalEventInput } from './storage-validation.js'

import { SqliteLifecycleStorage } from './sqlite-lifecycle.js'
import type { CursorRow, SqliteEventRow } from './sqlite-types.js'
import { asString, missingFromCursor } from './sqlite-rows.js'
import { now } from './sqlite-rows.js'
import { classifySqliteError } from './sqlite-paths.js'

export abstract class SqliteJournalStorage extends SqliteLifecycleStorage {
  async append(events: readonly JournalEvent[]): Promise<AppendResult> {
    if (events.length === 0) {
      return {
        acceptedEventIds: [],
        duplicateEventIds: [],
        missingHistory: [],
        projectionChecksum: this.storedProjectionChecksum(),
      }
    }
    if (events.length > this.maxEvents) {
      throw new StorageError(
        'STORAGE_TRANSACTION_BOUNDS',
        `A transaction may contain at most ${this.maxEvents} events`,
      )
    }
    let payloadBytes = 0
    for (const event of events) {
      assertJournalEventInput(event)
      assertPersistablePayload(event.payload)
      payloadBytes += Buffer.byteLength(canonicalJson(event.payload))
    }
    if (payloadBytes > this.maxPayloadBytes) {
      throw new StorageError(
        'STORAGE_TRANSACTION_BOUNDS',
        'The event batch exceeds the transaction byte bound',
      )
    }
    return this.writes.run(async () => this.appendUnsafe(events))
  }

  async appendUnsafe(events: readonly JournalEvent[]): Promise<AppendResult> {
    this.assertOpen()
    const contentKeys = new Map<ConversationId, Buffer>()
    const contentRefs = new Map<ConversationId, CredentialRef>()
    const contentWorkspaces = new Map<ConversationId, WorkspaceId>()
    const createdKeys: CredentialRef[] = []
    try {
      for (const event of events) {
        if (!contentKeys.has(event.conversationId)) {
          const material = await this.ensureContentKey(event.conversationId, createdKeys)
          contentKeys.set(event.conversationId, material.key)
          contentRefs.set(event.conversationId, material.ref)
          contentWorkspaces.set(event.conversationId, event.workspaceId)
        } else if (contentWorkspaces.get(event.conversationId) !== event.workspaceId) {
          throw new StorageError(
            'CONVERSATION_WORKSPACE_CONFLICT',
            `Conversation ${event.conversationId} was used with multiple workspaces`,
          )
        }
      }
      this.begin()
      const acceptedEventIds: EventId[] = []
      const duplicateEventIds: EventId[] = []
      const gapRuns = new Set<RunId>()
      try {
        for (const [conversationId] of contentKeys) {
          const workspaceId = contentWorkspaces.get(conversationId)
          const ref = contentRefs.get(conversationId)
          if (!workspaceId || !ref)
            throw new StorageError(
              'CONTENT_KEY_UNAVAILABLE',
              'Conversation key material is incomplete',
            )
          const conversation = this.database
            .prepare('SELECT workspace_id FROM braid_conversations WHERE conversation_id = ?')
            .get(conversationId) as { readonly workspace_id?: unknown } | undefined
          if (conversation && asString(conversation.workspace_id, 'workspace_id') !== workspaceId) {
            throw new StorageError(
              'CONVERSATION_WORKSPACE_CONFLICT',
              `Conversation ${conversationId} belongs to another workspace`,
            )
          }
          if (!conversation) {
            this.database
              .prepare(
                'INSERT INTO braid_conversations(conversation_id, workspace_id, created_at) VALUES (?, ?, ?)',
              )
              .run(conversationId, workspaceId, now())
          }
          const keyRow = this.database
            .prepare(
              'SELECT credential_ref, destroyed FROM braid_conversation_keys WHERE conversation_id = ?',
            )
            .get(conversationId) as
            | { readonly credential_ref?: unknown; readonly destroyed?: unknown }
            | undefined
          if (keyRow && Number(keyRow.destroyed) === 1) {
            throw new StorageError(
              'CONTENT_KEY_DESTROYED',
              `Conversation ${conversationId} content key was destroyed`,
            )
          }
          if (keyRow && asString(keyRow.credential_ref, 'credential_ref') !== ref) {
            throw new StorageError(
              'CONTENT_KEY_RACE',
              `Conversation ${conversationId} content key was created concurrently`,
            )
          }
          if (!keyRow) {
            this.database
              .prepare(
                'INSERT INTO braid_conversation_keys(conversation_id, credential_ref, destroyed) VALUES (?, ?, 0)',
              )
              .run(conversationId, ref)
          }
        }
        for (const event of events) {
          const existing = this.database
            .prepare(
              `SELECT workspace_id, conversation_id, run_id, event_id, run_sequence, kind,
                    cursor, provider_event_id, operation_id, payload_checksum, occurred_at, received_at, terminal
             FROM braid_journal_events WHERE run_id = ? AND event_id = ?`,
            )
            .get(event.runId, event.eventId) as
            | {
                readonly workspace_id?: unknown
                readonly conversation_id?: unknown
                readonly run_id?: unknown
                readonly event_id?: unknown
                readonly run_sequence?: unknown
                readonly kind?: unknown
                readonly cursor?: unknown
                readonly provider_event_id?: unknown
                readonly operation_id?: unknown
                readonly payload_checksum?: unknown
                readonly occurred_at?: unknown
                readonly received_at?: unknown
                readonly terminal?: unknown
              }
            | undefined
          const checksum = payloadChecksum(event.payload)
          if (existing) {
            const sameImmutableInput =
              existing.workspace_id === event.workspaceId &&
              existing.conversation_id === event.conversationId &&
              existing.run_id === event.runId &&
              existing.event_id === event.eventId &&
              Number(existing.run_sequence) === event.sequence &&
              existing.kind === event.kind &&
              (existing.cursor ?? null) === (event.cursor ?? null) &&
              (existing.provider_event_id ?? null) === (event.providerEventId ?? null) &&
              (existing.operation_id ?? null) === (event.operationId ?? null) &&
              existing.payload_checksum === checksum &&
              existing.occurred_at === event.occurredAt &&
              (event.receivedAt === undefined || existing.received_at === event.receivedAt) &&
              Number(existing.terminal) === (event.terminal === true ? 1 : 0)
            if (!sameImmutableInput) {
              throw new StorageError(
                'EVENT_ID_CONFLICT',
                `Event ${event.eventId} changed its durable input on retry`,
              )
            }
            duplicateEventIds.push(event.eventId)
            continue
          }
          const sequenceExisting = this.database
            .prepare(
              'SELECT event_id FROM braid_journal_events WHERE run_id = ? AND run_sequence = ?',
            )
            .get(event.runId, event.sequence) as { readonly event_id?: unknown } | undefined
          if (sequenceExisting && sequenceExisting.event_id !== event.eventId) {
            throw new StorageError(
              'SEQUENCE_CONFLICT',
              `Sequence ${event.sequence} is already assigned for run ${event.runId}`,
            )
          }
          const cursor = this.database
            .prepare(
              'SELECT run_id, conversation_id, last_sequence, last_cursor, missing_from, missing_to, terminal FROM braid_run_cursors WHERE run_id = ?',
            )
            .get(event.runId) as CursorRow | undefined
          if (cursor && cursor.conversation_id !== event.conversationId) {
            throw new StorageError(
              'RUN_CONVERSATION_CONFLICT',
              `Run ${event.runId} belongs to another conversation`,
            )
          }
          const isMissingSequence =
            cursor?.missing_from !== null &&
            cursor?.missing_from !== undefined &&
            cursor?.missing_to !== null &&
            cursor?.missing_to !== undefined &&
            event.sequence >= cursor.missing_from &&
            event.sequence <= cursor.missing_to
          if (cursor?.terminal === 1 && !isMissingSequence) {
            throw new StorageError(
              'TERMINAL_RUN_MUTATION',
              `Run ${event.runId} is already terminal`,
            )
          }
          const key = contentKeys.get(event.conversationId)
          if (!key)
            throw new StorageError(
              'CONTENT_KEY_UNAVAILABLE',
              'Conversation content key is unavailable',
            )
          const encoded = encryptPayload(event.payload, key)
          this.database
            .prepare(
              `INSERT INTO braid_conversations(conversation_id, workspace_id, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(conversation_id) DO UPDATE SET workspace_id = excluded.workspace_id`,
            )
            .run(event.conversationId, event.workspaceId, event.occurredAt)
          this.database
            .prepare(
              `INSERT INTO braid_journal_events(
              workspace_id, conversation_id, run_id, event_id, provider_event_id, run_sequence, kind, cursor,
              operation_id, payload, payload_checksum, occurred_at, received_at, terminal, redacted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            )
            .run(
              event.workspaceId,
              event.conversationId,
              event.runId,
              event.eventId,
              event.providerEventId ?? null,
              event.sequence,
              event.kind,
              event.cursor ?? null,
              event.operationId ?? null,
              encoded,
              checksum,
              event.occurredAt,
              event.receivedAt ?? now(),
              event.terminal === true ? 1 : 0,
            )
          encoded.fill(0)
          const refreshed = this.refreshCursor({
            runId: event.runId,
            conversationId: event.conversationId,
            sequence: event.sequence,
            terminal: cursor?.terminal === 1 || event.terminal === true,
          })
          if (refreshed.missingFrom !== null) gapRuns.add(event.runId)
          acceptedEventIds.push(event.eventId)
        }
        this.advanceIncrementalProjection(acceptedEventIds)
        this.commit('append')
        createdKeys.length = 0
        const missingHistory = [...gapRuns].flatMap((runId) => {
          const row = this.database
            .prepare('SELECT * FROM braid_run_cursors WHERE run_id = ?')
            .get(runId) as CursorRow
          const missing = missingFromCursor(row)
          return missing ? [missing] : []
        })
        return {
          acceptedEventIds,
          duplicateEventIds,
          missingHistory,
          projectionChecksum: this.storedProjectionChecksum(),
        }
      } catch (error) {
        this.rollback()
        throw classifySqliteError(error)
      }
    } catch (error) {
      for (const ref of createdKeys) await this.credentials.remove(ref).catch(() => undefined)
      if (error instanceof StorageError && error.code === 'CONTENT_KEY_RACE') {
        return this.appendUnsafe(events)
      }
      throw error instanceof StorageError || error instanceof CredentialError
        ? error
        : classifySqliteError(error)
    } finally {
      for (const key of contentKeys.values()) key.fill(0)
    }
  }

  async events(
    input: {
      readonly workspaceId?: WorkspaceId
      readonly conversationId?: ConversationId
      readonly runId?: RunId
    } = {},
  ): Promise<readonly StoredJournalEvent[]> {
    this.assertOpen()
    const clauses: string[] = []
    const parameters: SqliteValue[] = []
    if (input.workspaceId !== undefined) {
      clauses.push('workspace_id = ?')
      parameters.push(input.workspaceId)
    }
    if (input.conversationId !== undefined) {
      clauses.push('conversation_id = ?')
      parameters.push(input.conversationId)
    }
    if (input.runId !== undefined) {
      clauses.push('run_id = ?')
      parameters.push(input.runId)
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const rows = this.database
      .prepare(`SELECT * FROM braid_journal_events${where} ORDER BY storage_id`)
      .all(...parameters) as readonly SqliteEventRow[]
    const result: StoredJournalEvent[] = []
    for (const row of rows) result.push(await this.storedEvent(row))
    return result
  }

  async replay(input: {
    readonly runId: RunId
    readonly afterSequence?: number
  }): Promise<ReplayResult> {
    this.assertOpen()
    const after = input.afterSequence ?? 0
    const cursor = this.database
      .prepare('SELECT * FROM braid_run_cursors WHERE run_id = ?')
      .get(input.runId) as CursorRow | undefined
    const rows = this.database
      .prepare(
        'SELECT * FROM braid_journal_events WHERE run_id = ? AND run_sequence > ? ORDER BY run_sequence',
      )
      .all(input.runId, after) as readonly SqliteEventRow[]
    const events: StoredJournalEvent[] = []
    for (const row of rows) events.push(await this.storedEvent(row))
    const missing = cursor ? missingFromCursor(cursor) : null
    return {
      events,
      complete: missing === null,
      missingHistory: missing ? [missing] : [],
      lastSequence: cursor?.last_sequence ?? 0,
      ...(cursor?.last_cursor === null || cursor?.last_cursor === undefined
        ? {}
        : { lastCursor: cursor.last_cursor }),
    }
  }

  async projection(): Promise<ProjectionSnapshot> {
    this.assertOpen()
    return structuredClone(this.currentProjection())
  }

  async projectionChecksum(): Promise<string> {
    this.assertOpen()
    return this.storedProjectionChecksum()
  }
}
