import { randomBytes, randomUUID } from 'node:crypto'
import {
  parseConversationId,
  parseEventId,
  parseOperationId,
  parseReplayCursor,
  parseRunId,
  parseWorkspaceId,
} from '../../domain/ids.js'
import type { CredentialRef, SecretHandle } from '../../ports/credentials.js'
import { credentialRef } from '../../ports/credentials.js'
import type { ConversationId, EventId, StoredJournalEvent } from '../../ports/storage.js'
import { decryptPayload, payloadChecksum } from './sqlite-crypto.js'
import { StorageError } from './sqlite-errors.js'

import { SqliteStorageBase } from './sqlite-base.js'
import type { SqliteEventRow } from './sqlite-types.js'
import {
  asBuffer,
  asNumber,
  asString,
  credentialErrorCode,
  redactedPersistedPayload,
} from './sqlite-rows.js'

export abstract class SqliteContentStorage extends SqliteStorageBase {
  async storedEvent(row: SqliteEventRow): Promise<StoredJournalEvent> {
    const conversationId = parseConversationId(asString(row.conversation_id, 'conversation_id'))
    const base = {
      workspaceId: parseWorkspaceId(asString(row.workspace_id, 'workspace_id')),
      conversationId,
      runId: parseRunId(asString(row.run_id, 'run_id')),
      eventId: parseEventId(asString(row.event_id, 'event_id')),
      sequence: asNumber(row.run_sequence, 'run_sequence'),
      kind: asString(row.kind, 'kind'),
      occurredAt: asString(row.occurred_at, 'occurred_at'),
      ...(row.cursor === null ? {} : { cursor: parseReplayCursor(asString(row.cursor, 'cursor')) }),
      ...(row.operation_id === null
        ? {}
        : { operationId: parseOperationId(asString(row.operation_id, 'operation_id')) }),
      terminal: row.terminal === 1,
      receivedAt: asString(row.received_at, 'received_at'),
      payloadChecksum: asString(row.payload_checksum, 'payload_checksum'),
      redacted: row.redacted === 1,
      ...(row.provider_event_id === null || row.provider_event_id === undefined
        ? {}
        : { providerEventId: asString(row.provider_event_id, 'provider_event_id') }),
    }
    const tombstone = this.database
      .prepare('SELECT reason FROM braid_conversation_tombstones WHERE conversation_id = ?')
      .get(conversationId) as { readonly reason?: unknown } | undefined
    if (tombstone) {
      return {
        ...base,
        payload: redactedPersistedPayload(null, row, 'destruction'),
        payloadState: 'deleted',
        tombstoneReason: asString(tombstone.reason, 'tombstone.reason'),
      }
    }
    const key = await this.existingContentKey(conversationId)
    if (!key) return { ...base, payload: null, payloadState: 'content-key-unavailable' }
    try {
      const payload = decryptPayload(asBuffer(row.payload, 'payload'), key)
      if (payloadChecksum(payload) !== base.payloadChecksum) {
        throw new StorageError(
          'PAYLOAD_CHECKSUM_MISMATCH',
          `Stored payload checksum does not match event ${base.eventId}`,
        )
      }
      return { ...base, payload, payloadState: row.redacted === 1 ? 'redacted' : 'available' }
    } finally {
      key.fill(0)
    }
  }

  async ensureContentKey(
    conversationId: ConversationId,
    created: CredentialRef[],
  ): Promise<{ readonly key: Buffer; readonly ref: CredentialRef }> {
    const row = this.database
      .prepare(
        'SELECT credential_ref, destroyed FROM braid_conversation_keys WHERE conversation_id = ?',
      )
      .get(conversationId) as
      | { readonly credential_ref?: unknown; readonly destroyed?: unknown }
      | undefined
    if (row) {
      if (Number(row.destroyed) === 1)
        throw new StorageError('CONTENT_KEY_DESTROYED', 'Conversation content key was destroyed')
      const ref = credentialRef(asString(row.credential_ref, 'credential_ref'))
      return { key: await this.resolveKey(ref), ref }
    }
    const ref = credentialRef(`cred:v1:content-${randomUUID()}`)
    const key = randomBytes(32)
    try {
      await this.credentials.store({ ref, value: key })
      created.push(ref)
      return { key: Buffer.from(key), ref }
    } finally {
      key.fill(0)
    }
  }

  async existingContentKey(conversationId: ConversationId): Promise<Buffer | undefined> {
    const row = this.database
      .prepare(
        'SELECT credential_ref, destroyed FROM braid_conversation_keys WHERE conversation_id = ?',
      )
      .get(conversationId) as
      | { readonly credential_ref?: unknown; readonly destroyed?: unknown }
      | undefined
    if (!row || Number(row.destroyed) === 1) return undefined
    const ref = credentialRef(asString(row.credential_ref, 'credential_ref'))
    try {
      return await this.resolveKey(ref)
    } catch (error) {
      if (credentialErrorCode(error) === 'CREDENTIAL_NOT_FOUND') return undefined
      throw error
    }
  }

  async resolveKey(ref: CredentialRef): Promise<Buffer> {
    let handle: SecretHandle | undefined
    try {
      handle = await this.credentials.resolve(ref)
      const key = Buffer.from(handle.read())
      if (key.length !== 32)
        throw new StorageError('CONTENT_KEY_INVALID', 'Stored content key has invalid length')
      return key
    } finally {
      handle?.dispose()
    }
  }

  async verifyConversation(
    conversationId: ConversationId,
    eventId: EventId,
    ref: CredentialRef,
  ): Promise<boolean> {
    const key = await this.resolveKey(ref)
    try {
      const rows = this.database
        .prepare('SELECT * FROM braid_journal_events WHERE conversation_id = ? ORDER BY storage_id')
        .all(conversationId) as readonly SqliteEventRow[]
      for (const row of rows) {
        const value = decryptPayload(asBuffer(row.payload, 'payload'), key)
        if (payloadChecksum(value) !== row.payload_checksum) return false
        if (row.event_id === eventId && row.redacted !== 1) return false
      }
      return true
    } finally {
      key.fill(0)
    }
  }
}
