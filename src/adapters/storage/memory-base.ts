import { createHash } from 'node:crypto'
import { canonicalDigest, canonicalJson } from '../../domain/canonical.js'
import type {
  ConversationId,
  JsonValue,
  MissingHistory,
  OperationId,
  OperationRecord,
  ProjectionRun,
  ProjectionSnapshot,
  RunId,
  StoredJournalEvent,
} from '../../ports/storage.js'
import { PROJECTION_SCHEMA_VERSION } from '../../ports/storage.js'
import { StorageError } from './sqlite-errors.js'

export interface MemoryCursor {
  readonly runId: RunId
  readonly conversationId: ConversationId
  lastSequence: number
  lastCursor: string | null
  missingFrom: number | null
  missingTo: number | null
  terminal: boolean
}

export interface MemorySnapshot {
  readonly events: readonly StoredJournalEvent[]
  readonly cursors: readonly MemoryCursor[]
  readonly operations: readonly OperationRecord[]
  readonly effects: readonly [string, import('../../ports/effect-storage.js').EffectRecord[]][]
}

export function clone<T>(value: T): T {
  return structuredClone(value)
}

export function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue
}

export function missing(cursor: MemoryCursor): MissingHistory | null {
  if (cursor.missingFrom === null || cursor.missingTo === null) return null
  return { runId: cursor.runId, fromSequence: cursor.missingFrom, toSequence: cursor.missingTo }
}

export function refreshCursor(cursor: MemoryCursor, events: readonly StoredJournalEvent[]): void {
  const runEvents = events
    .filter((event) => event.runId === cursor.runId)
    .sort((left, right) => left.sequence - right.sequence)
  const sequences = runEvents.map((event) => event.sequence)
  const maximum = Math.max(...sequences, 0)
  const present = new Set(sequences)
  let contiguous = 0
  while (present.has(contiguous + 1)) contiguous += 1
  const contiguousEvent = runEvents.find((event) => event.sequence === contiguous)
  cursor.lastSequence = contiguous
  cursor.lastCursor = contiguousEvent?.cursor ?? null
  cursor.missingFrom = contiguous < maximum ? contiguous + 1 : null
  cursor.missingTo = contiguous < maximum ? maximum : null
}

export function projectionOf(
  events: readonly StoredJournalEvent[],
  cursors: readonly MemoryCursor[],
): ProjectionSnapshot {
  const runs: ProjectionRun[] = cursors
    .map((cursor) => ({
      runId: cursor.runId,
      conversationId: cursor.conversationId,
      lastSequence: cursor.lastSequence,
      lastCursor: cursor.lastCursor,
      missingFrom: cursor.missingFrom,
      missingTo: cursor.missingTo,
      terminal: cursor.terminal,
    }))
    .sort((left, right) => left.runId.localeCompare(right.runId))
  const base = {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    eventCount: events.length,
    revision: events.length,
    eventIds: events.map((event) => event.eventId),
    runs,
  }
  let eventIdsDigest = createHash('sha256').update('braid-projection-events-v1').digest('hex')
  for (const eventId of base.eventIds) {
    eventIdsDigest = createHash('sha256').update(`${eventIdsDigest}\u0000${eventId}`).digest('hex')
  }
  const runsDigest = (() => {
    const aggregate = Buffer.alloc(32)
    for (const run of base.runs) {
      const digest = Buffer.from(canonicalDigest(run), 'hex')
      for (let index = 0; index < aggregate.length; index += 1) {
        aggregate[index] = (aggregate[index] ?? 0) ^ (digest[index] ?? 0)
      }
    }
    return aggregate.toString('hex')
  })()
  return {
    ...base,
    checksum: canonicalDigest({
      schemaVersion: base.schemaVersion,
      eventCount: base.eventCount,
      revision: base.revision,
      eventIdsDigest,
      runsDigest,
    }),
  }
}

export class MemoryStorageBase {
  protected readonly eventStore: StoredJournalEvent[] = []
  protected readonly cursorStore = new Map<RunId, MemoryCursor>()
  protected readonly operationStore = new Map<OperationId, OperationRecord>()
  protected readonly snapshotStore = new Map<string, MemorySnapshot>()
  protected readonly effectStore = new Map<
    string,
    import('../../ports/effect-storage.js').EffectRecord[]
  >()
  protected projectionState: ProjectionSnapshot = projectionOf([], [])
  protected isClosed = false

  protected snapshot(): MemorySnapshot {
    return {
      events: clone(this.eventStore),
      cursors: clone([...this.cursorStore.values()]),
      operations: clone([...this.operationStore.values()]),
      effects: clone([...this.effectStore.entries()]),
    }
  }

  protected restoreSnapshot(snapshot: MemorySnapshot): void {
    this.eventStore.splice(0, this.eventStore.length, ...clone(snapshot.events))
    this.cursorStore.clear()
    for (const cursor of snapshot.cursors) this.cursorStore.set(cursor.runId, clone(cursor))
    this.operationStore.clear()
    for (const operation of snapshot.operations)
      this.operationStore.set(operation.operationId, clone(operation))
    this.effectStore.clear()
    for (const [operationId, records] of snapshot.effects)
      this.effectStore.set(operationId, clone(records))
    this.projectionState = projectionOf(this.eventStore, [...this.cursorStore.values()])
  }

  protected assertOpen(): void {
    if (this.isClosed) throw new StorageError('STORAGE_CLOSED', 'Memory storage is closed')
  }
}
