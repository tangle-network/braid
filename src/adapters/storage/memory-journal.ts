import type {
  AppendResult,
  ConversationId,
  EventId,
  JournalEvent,
  MissingHistory,
  ProjectionSnapshot,
  ReplayResult,
  RunId,
  StoredJournalEvent,
  WorkspaceId,
} from '../../ports/storage.js'
import { assertPersistablePayload, payloadChecksum } from './sqlite-crypto.js'
import { StorageError } from './sqlite-errors.js'
import { assertJournalEventInput } from './storage-validation.js'
import {
  MemoryStorageBase,
  clone,
  missing,
  projectionOf,
  refreshCursor,
  type MemoryCursor,
} from './memory-base.js'

export class MemoryJournalStorage extends MemoryStorageBase {
  async append(events: readonly JournalEvent[]): Promise<AppendResult> {
    this.assertOpen()
    const acceptedEventIds: EventId[] = []
    const duplicateEventIds: EventId[] = []
    const missingRuns = new Set<RunId>()
    for (const event of events) {
      assertJournalEventInput(event)
      assertPersistablePayload(event.payload)
      const checksum = payloadChecksum(event.payload)
      const existing = this.eventStore.find(
        (candidate) => candidate.runId === event.runId && candidate.eventId === event.eventId,
      )
      if (existing) {
        const sameImmutableInput =
          existing.workspaceId === event.workspaceId &&
          existing.conversationId === event.conversationId &&
          existing.runId === event.runId &&
          existing.eventId === event.eventId &&
          (existing.providerEventId ?? null) === (event.providerEventId ?? null) &&
          existing.sequence === event.sequence &&
          existing.kind === event.kind &&
          (existing.cursor ?? null) === (event.cursor ?? null) &&
          (existing.operationId ?? null) === (event.operationId ?? null) &&
          existing.payloadChecksum === checksum &&
          existing.occurredAt === event.occurredAt &&
          (event.receivedAt === undefined || existing.receivedAt === event.receivedAt) &&
          existing.terminal === (event.terminal === true)
        if (!sameImmutableInput) {
          throw new StorageError(
            'EVENT_ID_CONFLICT',
            `Event ${event.eventId} changed its durable input on retry`,
          )
        }
        duplicateEventIds.push(event.eventId)
        continue
      }
      const sequenceExisting = this.eventStore.find(
        (candidate) => candidate.runId === event.runId && candidate.sequence === event.sequence,
      )
      if (sequenceExisting && sequenceExisting.eventId !== event.eventId) {
        throw new StorageError(
          'SEQUENCE_CONFLICT',
          `Sequence ${event.sequence} is already assigned for run ${event.runId}`,
        )
      }
      const cursor = this.cursorStore.get(event.runId)
      const lastSequence = cursor?.lastSequence ?? 0
      if (cursor && cursor.conversationId !== event.conversationId) {
        throw new StorageError(
          'RUN_CONVERSATION_CONFLICT',
          `Run ${event.runId} belongs to another conversation`,
        )
      }
      const isMissingSequence =
        cursor?.missingFrom !== null &&
        cursor?.missingFrom !== undefined &&
        cursor?.missingTo !== null &&
        cursor?.missingTo !== undefined &&
        event.sequence >= cursor.missingFrom &&
        event.sequence <= cursor.missingTo
      if (cursor?.terminal && !isMissingSequence) {
        throw new StorageError('TERMINAL_RUN_MUTATION', `Run ${event.runId} is terminal`)
      }
      const next: MemoryCursor = cursor ?? {
        runId: event.runId,
        conversationId: event.conversationId,
        lastSequence: 0,
        lastCursor: null,
        missingFrom: null,
        missingTo: null,
        terminal: false,
      }
      const stored: StoredJournalEvent = {
        workspaceId: event.workspaceId,
        conversationId: event.conversationId,
        runId: event.runId,
        eventId: event.eventId,
        ...(event.providerEventId === undefined ? {} : { providerEventId: event.providerEventId }),
        sequence: event.sequence,
        kind: event.kind,
        payload: clone(event.payload),
        payloadState: 'available',
        payloadChecksum: checksum,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt ?? new Date().toISOString(),
        ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        terminal: event.terminal === true,
        redacted: false,
      }
      this.eventStore.push(stored)
      next.lastCursor =
        event.sequence >= lastSequence ? (event.cursor ?? next.lastCursor) : next.lastCursor
      next.terminal ||= event.terminal === true
      refreshCursor(next, this.eventStore)
      this.cursorStore.set(event.runId, next)
      if (next.missingFrom !== null) missingRuns.add(event.runId)
      acceptedEventIds.push(event.eventId)
    }
    this.projectionState = projectionOf(this.eventStore, [...this.cursorStore.values()])
    return {
      acceptedEventIds,
      duplicateEventIds,
      missingHistory: [...missingRuns]
        .map((runId) => this.cursorStore.get(runId))
        .filter((cursor): cursor is MemoryCursor => cursor !== undefined)
        .map(missing)
        .filter((range): range is MissingHistory => range !== null),
      projectionChecksum: this.projectionState.checksum,
    }
  }

  async replay(input: {
    readonly runId: RunId
    readonly afterSequence?: number
  }): Promise<ReplayResult> {
    this.assertOpen()
    const afterSequence = input.afterSequence ?? 0
    const cursor = this.cursorStore.get(input.runId)
    const events = this.eventStore
      .filter((event) => event.runId === input.runId && event.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
    const range = cursor === undefined ? null : missing(cursor)
    return {
      events: clone(events),
      complete: range === null,
      missingHistory: range === null ? [] : [range],
      lastSequence: cursor?.lastSequence ?? 0,
      ...(cursor?.lastCursor === null || cursor?.lastCursor === undefined
        ? {}
        : { lastCursor: cursor.lastCursor }),
    }
  }

  async events(
    input: {
      readonly workspaceId?: WorkspaceId
      readonly conversationId?: ConversationId
      readonly runId?: RunId
      readonly afterStorageId?: number
    } = {},
  ): Promise<readonly StoredJournalEvent[]> {
    this.assertOpen()
    return clone(
      this.eventStore.filter(
        (event) =>
          (input.workspaceId === undefined || event.workspaceId === input.workspaceId) &&
          (input.conversationId === undefined || event.conversationId === input.conversationId) &&
          (input.runId === undefined || event.runId === input.runId),
      ),
    )
  }

  async projection(): Promise<ProjectionSnapshot> {
    this.assertOpen()
    return clone(this.projectionState)
  }

  async projectionChecksum(): Promise<string> {
    this.assertOpen()
    return this.projectionState.checksum
  }
}
