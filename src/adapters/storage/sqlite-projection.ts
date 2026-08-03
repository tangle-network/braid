import { canonicalDigest, canonicalJson } from '../../domain/canonical.js'
import { parseConversationId, parseRunId } from '../../domain/ids.js'
import type {
  ConversationId,
  EventId,
  JsonValue,
  ProjectionSnapshot,
  RunId,
} from '../../ports/storage.js'
import { isJsonValue, PROJECTION_SCHEMA_VERSION } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'

import { SqliteContentStorage } from './sqlite-content.js'
import type { CursorRow, SqliteEventRow } from './sqlite-types.js'
import {
  asNumber,
  asString,
  projectionFromRows,
  projectionChecksum,
  PROJECTION_EVENT_DIGEST_SEED,
  appendProjectionEventDigest,
  projectionRunDigest,
} from './sqlite-rows.js'

export abstract class SqliteProjectionStorage extends SqliteContentStorage {
  currentProjection(): ProjectionSnapshot {
    const projection = this.buildProjection()
    this.assertStoredProjection(projection)
    return projection
  }

  assertStoredProjection(
    projection: ProjectionSnapshot,
    known?: { readonly state_json?: unknown; readonly checksum?: unknown },
  ): void {
    const stored =
      known ??
      (this.database
        .prepare(
          'SELECT state_json, checksum FROM braid_projection_state WHERE projection_name = ?',
        )
        .get('canonical') as
        | { readonly state_json?: unknown; readonly checksum?: unknown }
        | undefined)
    if (!stored) {
      throw new StorageError(
        'PROJECTION_CHECKSUM_MISMATCH',
        'Persisted projection differs from journal replay',
      )
    }
    let state: unknown
    try {
      state = JSON.parse(asString(stored.state_json, 'state_json')) as unknown
    } catch (error) {
      throw new StorageError(
        'PROJECTION_CHECKSUM_MISMATCH',
        'Persisted projection checksum does not verify',
        { cause: error },
      )
    }
    if (
      state === null ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      !isJsonValue(state)
    ) {
      throw new StorageError(
        'PROJECTION_CHECKSUM_MISMATCH',
        'Persisted projection checksum does not verify',
      )
    }
    const record = state as Record<string, JsonValue>
    const persistedChecksum = record.checksum
    const expectedMetadata = this.projectionMetadata(projection)
    const metadataMatches =
      record.schemaVersion === expectedMetadata.schemaVersion &&
      record.eventCount === expectedMetadata.eventCount &&
      record.revision === expectedMetadata.revision &&
      record.eventIdsDigest === expectedMetadata.eventIdsDigest &&
      record.runsDigest === expectedMetadata.runsDigest
    const legacyMatches =
      Array.isArray(record.eventIds) &&
      Array.isArray(record.runs) &&
      canonicalDigest({
        schemaVersion: record.schemaVersion,
        eventCount: record.eventCount,
        revision: record.revision,
        eventIds: record.eventIds,
        runs: record.runs,
      }) === persistedChecksum
    if (
      typeof persistedChecksum !== 'string' ||
      asString(stored.checksum, 'checksum') !== persistedChecksum ||
      (!metadataMatches && !legacyMatches)
    ) {
      throw new StorageError(
        'PROJECTION_CHECKSUM_MISMATCH',
        'Persisted projection checksum does not verify',
      )
    }
    if (persistedChecksum !== projection.checksum) {
      throw new StorageError(
        'PROJECTION_CHECKSUM_MISMATCH',
        'Persisted projection differs from journal replay',
      )
    }
  }

  buildProjection(): ProjectionSnapshot {
    const rows = this.database
      .prepare('SELECT * FROM braid_journal_events ORDER BY storage_id')
      .all() as readonly SqliteEventRow[]
    const cursors = this.database
      .prepare('SELECT * FROM braid_run_cursors ORDER BY run_id')
      .all() as readonly CursorRow[]
    return projectionFromRows(rows, cursors)
  }

  writeProjection(projection: ProjectionSnapshot): void {
    const base = { ...this.projectionMetadata(projection), checksum: projection.checksum }
    this.database
      .prepare(
        `INSERT INTO braid_projection_state(projection_name, revision, checksum, state_json)
       VALUES ('canonical', ?, ?, ?)
       ON CONFLICT(projection_name) DO UPDATE SET revision = excluded.revision, checksum = excluded.checksum, state_json = excluded.state_json`,
      )
      .run(projection.revision, projection.checksum, canonicalJson(base))
  }

  projectionMetadata(projection: ProjectionSnapshot): {
    readonly schemaVersion: number
    readonly eventCount: number
    readonly revision: number
    readonly eventIdsDigest: string
    readonly runsDigest: string
  } {
    let eventIdsDigest = PROJECTION_EVENT_DIGEST_SEED
    for (const eventId of projection.eventIds) {
      eventIdsDigest = appendProjectionEventDigest(eventIdsDigest, eventId)
    }
    return {
      schemaVersion: projection.schemaVersion,
      eventCount: projection.eventCount,
      revision: projection.revision,
      eventIdsDigest,
      runsDigest: projectionRunDigest(projection.runs),
    }
  }

  storedProjectionChecksum(): string {
    const row = this.database
      .prepare('SELECT checksum FROM braid_projection_state WHERE projection_name = ?')
      .get('canonical') as { readonly checksum?: unknown } | undefined
    if (!row) throw new StorageError('PROJECTION_CHECKSUM_MISMATCH', 'Projection state is missing')
    return asString(row.checksum, 'projection.checksum')
  }

  advanceIncrementalProjection(eventIds: readonly EventId[]): void {
    if (eventIds.length === 0) return
    const row = this.database
      .prepare('SELECT revision, state_json FROM braid_projection_state WHERE projection_name = ?')
      .get('canonical') as
      | { readonly revision?: unknown; readonly state_json?: unknown }
      | undefined
    if (!row) throw new StorageError('PROJECTION_CHECKSUM_MISMATCH', 'Projection state is missing')
    let state: Record<string, JsonValue>
    try {
      const parsed = JSON.parse(asString(row.state_json, 'state_json')) as unknown
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !isJsonValue(parsed)
      ) {
        throw new Error('projection state is not an object')
      }
      state = parsed as Record<string, JsonValue>
    } catch (error) {
      throw new StorageError('PROJECTION_CHECKSUM_MISMATCH', 'Projection state is invalid', {
        cause: error,
      })
    }
    let eventIdsDigest =
      typeof state.eventIdsDigest === 'string' ? state.eventIdsDigest : PROJECTION_EVENT_DIGEST_SEED
    for (const eventId of eventIds)
      eventIdsDigest = appendProjectionEventDigest(eventIdsDigest, eventId)
    const runs = this.database
      .prepare('SELECT * FROM braid_run_cursors ORDER BY run_id')
      .all() as readonly CursorRow[]
    const projectionRuns = runs.map((cursor) => ({
      runId: parseRunId(cursor.run_id),
      conversationId: parseConversationId(cursor.conversation_id),
      lastSequence: cursor.last_sequence,
      lastCursor: cursor.last_cursor,
      missingFrom: cursor.missing_from,
      missingTo: cursor.missing_to,
      terminal: cursor.terminal === 1,
    }))
    const eventCount =
      typeof state.eventCount === 'number' ? state.eventCount + eventIds.length : eventIds.length
    const revision = asNumber(row.revision, 'projection.revision') + eventIds.length
    const checksum = projectionChecksum({
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      eventCount,
      revision,
      eventIdsDigest,
      runsDigest: projectionRunDigest(projectionRuns),
    })
    const next = {
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      eventCount,
      revision,
      eventIdsDigest,
      runsDigest: projectionRunDigest(projectionRuns),
      checksum,
    }
    this.database
      .prepare(
        `UPDATE braid_projection_state
         SET revision = ?, checksum = ?, state_json = ?
         WHERE projection_name = 'canonical'`,
      )
      .run(revision, checksum, canonicalJson(next))
  }

  upsertCursor(input: {
    readonly runId: RunId
    readonly conversationId: ConversationId
    readonly lastSequence: number
    readonly lastCursor: string | null
    readonly missingFrom: number | null
    readonly missingTo: number | null
    readonly terminal: boolean
  }): void {
    this.database
      .prepare(
        `INSERT INTO braid_run_cursors(run_id, conversation_id, last_sequence, last_cursor, missing_from, missing_to, terminal)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET conversation_id = excluded.conversation_id,
       last_sequence = excluded.last_sequence, last_cursor = excluded.last_cursor,
       missing_from = excluded.missing_from, missing_to = excluded.missing_to, terminal = excluded.terminal`,
      )
      .run(
        input.runId,
        input.conversationId,
        input.lastSequence,
        input.lastCursor,
        input.missingFrom,
        input.missingTo,
        input.terminal ? 1 : 0,
      )
  }

  refreshCursor(input: {
    readonly runId: RunId
    readonly conversationId: ConversationId
    readonly sequence: number
    readonly terminal: boolean
  }): CursorRow {
    const previous = this.database
      .prepare(
        'SELECT last_sequence, last_cursor, missing_to FROM braid_run_cursors WHERE run_id = ?',
      )
      .get(input.runId) as
      | {
          readonly last_sequence?: unknown
          readonly last_cursor?: unknown
          readonly missing_to?: unknown
        }
      | undefined
    let contiguous = previous ? asNumber(previous.last_sequence, 'last_sequence') : 0
    let lastCursor =
      previous?.last_cursor === null || previous?.last_cursor === undefined
        ? null
        : asString(previous.last_cursor, 'last_cursor')
    const maximum = Math.max(
      input.sequence,
      previous?.missing_to === null || previous?.missing_to === undefined
        ? contiguous
        : asNumber(previous.missing_to, 'missing_to'),
    )
    while (true) {
      const next = this.database
        .prepare('SELECT cursor FROM braid_journal_events WHERE run_id = ? AND run_sequence = ?')
        .get(input.runId, contiguous + 1) as { readonly cursor?: unknown } | undefined
      if (!next) break
      contiguous += 1
      lastCursor =
        next.cursor === null || next.cursor === undefined ? null : asString(next.cursor, 'cursor')
    }
    const missingFrom = contiguous < maximum ? contiguous + 1 : null
    const missingTo = contiguous < maximum ? maximum : null
    this.upsertCursor({
      runId: input.runId,
      conversationId: input.conversationId,
      lastSequence: contiguous,
      lastCursor,
      missingFrom,
      missingTo,
      terminal: input.terminal,
    })
    return {
      run_id: input.runId,
      conversation_id: input.conversationId,
      last_sequence: contiguous,
      last_cursor: lastCursor,
      missing_from: missingFrom,
      missing_to: missingTo,
      terminal: input.terminal ? 1 : 0,
    }
  }
}
