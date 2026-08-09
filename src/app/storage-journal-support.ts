import { createHash } from 'node:crypto'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import {
  type ConversationId,
  createEventId,
  createRunId,
  createWorkspaceId,
  type OperationId,
  parseReplayCursor,
  type RunId,
  type WorkspaceId,
} from '../domain/ids.js'
import {
  createMaterializedStateSnapshot,
  isMaterializedStateSnapshot,
  restoreMaterializedState,
} from '../domain/materialized-state-snapshot.js'
import { replayEvents } from '../domain/reducer.js'
import type { BraidState } from '../domain/state.js'
import type { JsonValue, StateSnapshot, StoredJournalEvent } from '../ports/storage.js'
import { isJsonValue } from '../ports/storage.js'

export const MAX_IN_MEMORY_EVENTS = 256
export const SNAPSHOT_INTERVAL = 128

export interface PersistedEnvelope {
  readonly __braidEvent: BraidEvent
  readonly __braidEnvelope: {
    readonly sequence: number
    readonly revision: number
    readonly occurredAt: string
    readonly eventId: string
    readonly cursor?: string
  }
}

export class StorageJournalRebuildError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'StorageJournalRebuildError'
    this.code = code
  }
}

export function toJson(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new StorageJournalRebuildError('JOURNAL_PAYLOAD_INVALID', 'Journal payload is not JSON')
  }
  return value
}

export function workspaceIdForRoot(workspace: string | null): WorkspaceId {
  const digest = createHash('sha256')
    .update(workspace ?? 'uninitialized')
    .digest('hex')
    .slice(0, 24)
  return createWorkspaceId(`workspace-${digest}`)
}

export function syntheticRunId(workspaceId: WorkspaceId, conversationId: ConversationId): RunId {
  return createRunId(`run-journal-${canonicalDigest({ workspaceId, conversationId }).slice(0, 24)}`)
}

export function shouldSnapshot(state: BraidState, envelope: BraidEventEnvelope): boolean {
  return (
    state.sequence > 0 &&
    (state.sequence % SNAPSHOT_INTERVAL === 0 || envelope.event.kind === 'run.finished')
  )
}

export function snapshotForState(
  envelope: BraidEventEnvelope,
  state: BraidState,
  scopeId: string,
): StateSnapshot {
  const eventId =
    envelope.eventId ??
    createEventId(`event-${envelope.sequence}-${canonicalDigest(envelope.event).slice(0, 16)}`)
  return createMaterializedStateSnapshot({
    scopeId,
    generation: state.sequence,
    eventId,
    state,
  })
}

export function restoreSnapshot(value: unknown): BraidState {
  if (!isMaterializedStateSnapshot(value)) {
    throw new StorageJournalRebuildError(
      'JOURNAL_SNAPSHOT_INVALID',
      'Persisted snapshot is not a valid materialized state',
    )
  }
  try {
    return restoreMaterializedState(value)
  } catch (error) {
    throw new StorageJournalRebuildError(
      'JOURNAL_SNAPSHOT_INVALID',
      `Persisted materialized state failed domain validation: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function replaySnapshotTail(
  initial: BraidState,
  events: readonly BraidEventEnvelope[],
): BraidState {
  try {
    return replayEvents(initial, events)
  } catch (error) {
    throw new StorageJournalRebuildError(
      'JOURNAL_SNAPSHOT_TAIL_INVALID',
      `Persisted snapshot tail failed replay validation: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function envelopesFromStored(stored: readonly StoredJournalEvent[]): BraidEventEnvelope[] {
  return stored.map((event, index) => {
    const envelope = toEnvelope(event, index + 1)
    if (!envelope) {
      throw new StorageJournalRebuildError(
        'JOURNAL_EVENT_UNRECOGNIZED',
        `Persisted journal event ${event.eventId} does not contain a Braid event envelope`,
      )
    }
    return envelope
  })
}

export function runOperationId(event: BraidEvent): OperationId | undefined {
  switch (event.kind) {
    case 'run.requested':
      return event.operationId
    case 'conversation.created':
    case 'conversation.imported':
    case 'conversation.updated':
    case 'conversation.selected':
    case 'branch.created':
    case 'branch.selected':
      return event.operation?.id
    case 'conversation.deleted':
      return event.operation.id
    case 'draft.recorded':
      return event.operation?.id
    case 'operation.requested':
    case 'operation.updated':
      return event.operation.id
    default:
      return undefined
  }
}

export function conversationIdForEvent(state: BraidState, event: BraidEvent): ConversationId {
  switch (event.kind) {
    case 'conversation.created':
    case 'conversation.imported':
    case 'conversation.updated':
      return event.conversation.id
    case 'conversation.selected':
      return event.conversationId
    case 'conversation.deleted':
      return event.selectedConversation.id
    case 'branch.created':
    case 'branch.updated':
      return event.branch.conversationId
    case 'branch.selected':
      return event.conversationId
    case 'turn.created':
    case 'turn.updated':
      return event.turn.conversationId
    case 'message.created':
      return event.message.conversationId
    case 'analysis.created':
    case 'analysis.updated':
    case 'analysis.completed':
      return event.analysis.source.conversationId
    case 'analysis.attachment.created':
      return event.attachment.destinationConversationId
    case 'feedback.decision.recorded':
      return event.decision.conversationId
    case 'draft.recorded':
      return (
        state.branches.find((branch) => branch.id === event.draft.branchId)?.conversationId ??
        state.conversationId
      )
    case 'operation.requested':
    case 'operation.updated':
      return event.operation.kind !== 'conversation-delete' &&
        event.operation.target?.kind === 'conversation'
        ? event.operation.target.id
        : state.conversationId
    default:
      return state.conversationId
  }
}

function isPersistedEnvelope(value: unknown): value is PersistedEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const event = candidate.__braidEvent
  const metadata = candidate.__braidEnvelope
  if (
    event === undefined ||
    event === null ||
    typeof event !== 'object' ||
    Array.isArray(event) ||
    metadata === null ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  )
    return false
  const envelope = metadata as Record<string, unknown>
  return (
    typeof envelope.sequence === 'number' &&
    Number.isSafeInteger(envelope.sequence) &&
    envelope.sequence > 0 &&
    typeof envelope.revision === 'number' &&
    Number.isSafeInteger(envelope.revision) &&
    envelope.revision > 0 &&
    typeof envelope.occurredAt === 'string' &&
    typeof envelope.eventId === 'string' &&
    (envelope.cursor === undefined || typeof envelope.cursor === 'string') &&
    typeof (event as Record<string, unknown>).kind === 'string'
  )
}

function toEnvelope(
  event: StoredJournalEvent,
  journalSequence: number,
): BraidEventEnvelope | undefined {
  if (
    event.payloadState === 'content-key-unavailable' ||
    event.payloadState === 'deleted' ||
    event.payloadState === 'redacted'
  ) {
    return {
      eventId: event.eventId,
      sequence: journalSequence,
      revision: journalSequence,
      occurredAt: event.occurredAt,
      event: {
        kind: 'content.unavailable',
        conversationId: event.conversationId,
        originalKind: event.kind,
        reason: event.payloadState,
      },
    }
  }
  if (isPersistedEnvelope(event.payload)) {
    const metadata = event.payload.__braidEnvelope
    return {
      eventId: event.eventId,
      sequence: metadata.sequence,
      revision: metadata.revision,
      occurredAt: metadata.occurredAt,
      ...(metadata.cursor === undefined ? {} : { cursor: parseReplayCursor(metadata.cursor) }),
      event: event.payload.__braidEvent,
    }
  }
  if (
    event.payload !== null &&
    typeof event.payload === 'object' &&
    !Array.isArray(event.payload) &&
    ('__braidEvent' in event.payload || '__braidEnvelope' in event.payload)
  ) {
    return undefined
  }
  return {
    eventId: event.eventId,
    sequence: journalSequence,
    revision: journalSequence,
    occurredAt: event.occurredAt,
    ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
    event: {
      kind: 'unknown.event',
      unknown: {
        id: event.eventId,
        type: event.kind,
        namespace: 'braid.storage',
        summary: 'Stored event has no application envelope',
        sequence: event.sequence,
      },
    },
  }
}
