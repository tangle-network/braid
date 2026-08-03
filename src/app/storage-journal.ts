import { createHash } from 'node:crypto'
import { canonicalDigest } from '../domain/canonical.js'
import { type BraidEvent, type BraidEventEnvelope, eventRunId } from '../domain/events.js'
import {
  type ConversationId,
  createEventId,
  createRunId,
  createWorkspaceId,
  type OperationId,
  type RunId,
  type WorkspaceId,
} from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { EffectRecord, EffectStoragePort, JournalPort } from '../ports/effect-storage.js'
import type { JournalEvent, StoragePort, StoredJournalEvent } from '../ports/storage.js'

interface EnvelopeContext {
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
}

interface PersistedEnvelope {
  readonly __braidEvent: BraidEvent
  readonly __braidEnvelope: {
    readonly sequence: number
    readonly revision: number
    readonly occurredAt: string
    readonly eventId: string
    readonly cursor?: string
  }
}

function isPersistedEnvelope(value: unknown): value is PersistedEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const event = candidate.__braidEvent
  const metadata = candidate.__braidEnvelope
  if (
    event !== undefined &&
    event !== null &&
    typeof event === 'object' &&
    !Array.isArray(event) &&
    metadata !== null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata)
  ) {
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
      typeof (event as Record<string, unknown>).kind === 'string'
    )
  }
  return false
}

export function workspaceIdForRoot(workspace: string | null): WorkspaceId {
  const digest = createHash('sha256')
    .update(workspace ?? 'uninitialized')
    .digest('hex')
    .slice(0, 24)
  return createWorkspaceId(`workspace-${digest}`)
}

function syntheticRunId(workspaceId: WorkspaceId): RunId {
  return createRunId(`run-journal-${workspaceId.slice('workspace-'.length)}`)
}

function toJson(value: unknown): import('../ports/storage.js').JsonValue {
  return value as import('../ports/storage.js').JsonValue
}

/**
 * Bridges the synchronous application controller to the asynchronous SQLite
 * storage port. Journal writes are queued and `flush` is awaited immediately
 * before a provider stream can start.
 */
export class StorageJournal implements JournalPort, EffectStoragePort {
  readonly #storage: StoragePort & EffectStoragePort
  readonly #clock: Clock
  readonly #events: BraidEventEnvelope[]
  readonly #contexts = new Map<string, EnvelopeContext>()
  readonly #runSequences = new Map<RunId, number>()
  #pending: Promise<void> = Promise.resolve()
  #failure: unknown

  private constructor(
    storage: StoragePort & EffectStoragePort,
    clock: Clock,
    events: readonly BraidEventEnvelope[],
  ) {
    this.#storage = storage
    this.#clock = clock
    this.#events = events.map((event) => structuredClone(event))
  }

  static async fromStorage(
    storage: StoragePort & EffectStoragePort,
    clock: Clock,
    options: { readonly workspaceId?: WorkspaceId } = {},
  ): Promise<StorageJournal> {
    const stored = await storage.events(options)
    const events = stored.map((event, index) => {
      if (event.payloadState === 'content-key-unavailable') {
        throw new StorageJournalRebuildError(
          'CONTENT_KEY_UNAVAILABLE',
          `Cannot rebuild the application journal from ${event.payloadState} content for ${event.conversationId}`,
        )
      }
      const envelope = toEnvelope(event, index + 1)
      if (!envelope) {
        throw new StorageJournalRebuildError(
          'JOURNAL_EVENT_UNRECOGNIZED',
          `Persisted journal event ${event.eventId} does not contain a Braid event envelope`,
        )
      }
      return envelope
    })
    const journal = new StorageJournal(storage, clock, events)
    for (const event of stored) {
      const runId = event.runId
      journal.#runSequences.set(
        runId,
        Math.max(journal.#runSequences.get(runId) ?? 0, event.sequence),
      )
    }
    return journal
  }

  envelope(state: BraidState, event: BraidEvent): BraidEventEnvelope {
    const workspaceForEvent = event.kind === 'workspace.opened' ? event.workspace : state.workspace
    const workspaceId = workspaceIdForRoot(workspaceForEvent)
    const eventId = createEventId(
      `event-${workspaceId.slice('workspace-'.length)}-${state.sequence + 1}-${canonicalDigest(event).slice(0, 16)}`,
    )
    const envelope: BraidEventEnvelope = {
      eventId,
      sequence: state.sequence + 1,
      revision: state.revision + 1,
      occurredAt: this.#clock.now(),
      event,
    }
    this.#contexts.set(eventId, {
      workspaceId,
      conversationId: state.conversationId,
    })
    return envelope
  }

  append(envelope: BraidEventEnvelope): void {
    if (this.#failure !== undefined) throw this.#failure
    const eventId =
      envelope.eventId ??
      createEventId(`event-${envelope.sequence}-${canonicalDigest(envelope.event).slice(0, 16)}`)
    const context = this.#contexts.get(eventId)
    if (!context) {
      throw new StorageJournalRebuildError(
        'JOURNAL_CONTEXT_MISSING',
        `Application event ${eventId} was not created by this storage journal`,
      )
    }
    const runId = eventRunId(envelope.event) ?? syntheticRunId(context.workspaceId)
    const operationId = runOperationId(envelope.event)
    const sequence = (this.#runSequences.get(runId) ?? 0) + 1
    this.#runSequences.set(runId, sequence)
    const payload: PersistedEnvelope = {
      __braidEvent: envelope.event,
      __braidEnvelope: {
        sequence: envelope.sequence,
        revision: envelope.revision,
        occurredAt: envelope.occurredAt,
        eventId,
        ...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
      },
    }
    const record: JournalEvent = {
      workspaceId: context.workspaceId,
      conversationId: context.conversationId,
      runId,
      eventId,
      sequence,
      kind: envelope.event.kind,
      payload: toJson(payload),
      occurredAt: envelope.occurredAt,
      ...(operationId === undefined ? {} : { operationId }),
      terminal: envelope.event.kind === 'run.finished',
    }
    this.#events.push({ ...envelope, eventId })
    this.#pending = this.#pending
      .then(async () => {
        if (this.#failure !== undefined) throw this.#failure
        await this.#storage.append([record])
      })
      .catch((error) => {
        this.#failure = error
        throw error
      })
    this.#contexts.delete(eventId)
  }

  all(): readonly BraidEventEnvelope[] {
    return this.#events.map((event) => structuredClone(event))
  }

  async flush(): Promise<void> {
    await this.#pending
    if (this.#failure !== undefined) throw this.#failure
  }

  async close(): Promise<void> {
    let failure: unknown
    try {
      await this.flush()
    } catch (error) {
      failure = error
    }
    try {
      await this.#storage.close()
    } catch (error) {
      failure ??= error
    }
    if (failure !== undefined) throw failure
  }

  current(operationId: string): EffectRecord | undefined {
    return this.#storage.current(operationId)
  }

  latest(operationId: string, requestDigest: string): EffectRecord | undefined {
    return this.#storage.latest(operationId, requestDigest)
  }

  appendEffect(record: EffectRecord): void {
    this.#storage.appendEffect(record)
  }

  reserveEffect(record: EffectRecord): {
    readonly record: EffectRecord
    readonly created: boolean
  } {
    return this.#storage.reserveEffect(record)
  }

  history(operationId: string): readonly EffectRecord[] {
    return this.#storage.history(operationId)
  }
}

function runOperationId(event: BraidEvent): OperationId | undefined {
  switch (event.kind) {
    case 'run.requested':
      return event.operationId
    default:
      return undefined
  }
}

function toEnvelope(
  event: StoredJournalEvent,
  journalSequence: number,
): BraidEventEnvelope | undefined {
  if (isPersistedEnvelope(event.payload)) {
    const metadata = event.payload.__braidEnvelope
    return {
      eventId: event.eventId,
      sequence: metadata.sequence,
      revision: metadata.revision,
      occurredAt: metadata.occurredAt,
      ...(metadata.cursor === undefined
        ? {}
        : { cursor: metadata.cursor as import('../domain/ids.js').ReplayCursor }),
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
        summary:
          event.payloadState === 'redacted'
            ? 'Event payload redacted'
            : 'Stored event has no application envelope',
        sequence: event.sequence,
      },
    },
  }
}

class StorageJournalRebuildError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'StorageJournalRebuildError'
    this.code = code
  }
}
