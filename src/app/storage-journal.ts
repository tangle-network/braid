import { canonicalDigest } from '../domain/canonical.js'
import {
  type BraidEvent,
  type BraidEventEnvelope,
  eventRunId,
  providerMetaForEvent,
} from '../domain/events.js'
import {
  type ConversationId,
  createEventId,
  parseReplayCursor,
  type RunId,
  type WorkspaceId,
} from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import type { Clock } from '../ports/clock.js'
import type { EffectRecord, EffectStoragePort, JournalPort } from '../ports/effect-storage.js'
import {
  canAppendAfterTerminal,
  type JournalEvent,
  type StateSnapshot,
  type StoragePort,
  type StoredJournalEvent,
} from '../ports/storage.js'
import { createInMemoryOperationFingerprint } from './operation-fingerprint.js'
import {
  conversationIdForEvent,
  envelopesFromStored,
  MAX_IN_MEMORY_EVENTS,
  type PersistedEnvelope,
  replaySnapshotTail,
  restoreSnapshot,
  runOperationId,
  StorageJournalRebuildError,
  shouldSnapshot,
  snapshotForState,
  syntheticRunId,
  toJson,
  workspaceIdForRoot,
} from './storage-journal-support.js'

interface EnvelopeContext {
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
}

/**
 * Bridges the application controller to asynchronous SQLite storage.
 * An event is exposed to the application journal only after SQLite confirms the
 * transaction, so a failed write cannot advance the in-memory projection.
 */
export class StorageJournal implements JournalPort, EffectStoragePort {
  readonly asynchronous = true
  runOwnership?: JournalPort['runOwnership']
  readonly #storage: StoragePort & EffectStoragePort
  readonly #clock: Clock
  readonly #events: BraidEventEnvelope[]
  readonly #contexts = new Map<string, EnvelopeContext>()
  readonly #runSequences = new Map<RunId, number>()
  /** Runs whose terminal event is durable; storage refuses their further output. */
  readonly #terminalRuns = new Set<RunId>()
  readonly #fallbackFingerprint = createInMemoryOperationFingerprint()
  readonly #initialState: BraidState | undefined
  #replayEvents: readonly BraidEventEnvelope[] | undefined
  #pending: Promise<void> = Promise.resolve()
  #failure: unknown
  #storageId = 0
  readonly #ownEvents = new Set<string>()

  private constructor(
    storage: StoragePort & EffectStoragePort,
    clock: Clock,
    events: readonly BraidEventEnvelope[],
    options: {
      readonly initialState?: BraidState
      readonly replayEvents?: readonly BraidEventEnvelope[]
    } = {},
  ) {
    this.#storage = storage
    this.#clock = clock
    this.#events = events.slice(-MAX_IN_MEMORY_EVENTS).map((event) => structuredClone(event))
    this.#initialState =
      options.initialState === undefined ? undefined : structuredClone(options.initialState)
    this.#replayEvents =
      options.replayEvents === undefined
        ? undefined
        : options.replayEvents.map((event) => structuredClone(event))
  }

  static async fromStorage(
    storage: StoragePort & EffectStoragePort,
    clock: Clock,
    options: {
      readonly workspaceId?: WorkspaceId
      readonly runOwnership?: JournalPort['runOwnership']
    } = {},
  ): Promise<StorageJournal> {
    let initialState: BraidState | undefined
    let stored: readonly StoredJournalEvent[] | undefined
    let events: readonly BraidEventEnvelope[] | undefined
    const snapshot = await storage.latestStateSnapshot?.()
    if (snapshot !== null && snapshot !== undefined) {
      try {
        initialState = restoreSnapshot(snapshot)
        stored = await storage.events({ ...options, afterStorageId: snapshot.storageId })
        events = envelopesFromStored(stored)
        if (events[0] !== undefined && events[0].sequence !== initialState.sequence + 1) {
          throw new StorageJournalRebuildError(
            'JOURNAL_SNAPSHOT_TAIL_GAP',
            `Snapshot at sequence ${initialState.sequence} is not followed by a contiguous journal tail`,
          )
        }
        // Validate the same path used by the application before handing it the snapshot.
        replaySnapshotTail(initialState, events)
      } catch {
        initialState = undefined
        stored = undefined
        events = undefined
      }
    }
    if (stored === undefined || events === undefined) {
      stored = await storage.events(options)
      events = envelopesFromStored(stored)
    }
    const journal = new StorageJournal(storage, clock, events, {
      ...(initialState === undefined ? {} : { initialState }),
      replayEvents: events,
    })
    journal.runOwnership = options.runOwnership
    journal.#storageId = stored?.at(-1)?.storageId ?? snapshot?.storageId ?? 0
    const cursors = storage.runSequences === undefined ? [] : await storage.runSequences()
    for (const cursor of cursors) {
      journal.#runSequences.set(cursor.runId, cursor.lastSequence)
      if (cursor.terminal) journal.#terminalRuns.add(cursor.runId)
    }
    if (cursors.length === 0) {
      for (const event of stored) {
        const runId = event.runId
        journal.#runSequences.set(
          runId,
          Math.max(journal.#runSequences.get(runId) ?? 0, event.sequence),
        )
        if (event.terminal === true) journal.#terminalRuns.add(runId)
      }
    }
    return journal
  }

  envelope(state: BraidState, event: BraidEvent): BraidEventEnvelope {
    if (event.kind === 'run.requested' && this.runOwnership?.claim(event.runId) === false)
      throw new Error('Another live Braid process owns this run')
    const workspaceForEvent = event.kind === 'workspace.opened' ? event.workspace : state.workspace
    const workspaceId = workspaceIdForRoot(workspaceForEvent)
    const eventId = createEventId(
      `event-${workspaceId.slice('workspace-'.length)}-${state.sequence + 1}-${canonicalDigest(event).slice(0, 16)}`,
    )
    const provider = providerMetaForEvent(event)
    const envelope: BraidEventEnvelope = {
      eventId,
      sequence: state.sequence + 1,
      revision: state.revision + 1,
      occurredAt: this.#clock.now(),
      ...(provider?.cursor === undefined ? {} : { cursor: parseReplayCursor(provider.cursor) }),
      event,
    }
    this.#contexts.set(eventId, {
      workspaceId,
      conversationId: conversationIdForEvent(state, event),
    })
    return envelope
  }

  /**
   * The first terminal outcome closes its run. A provider event or a second outcome that raced it
   * (LIVE-07: a cancellation and the stream's own end) is declined with the rule storage enforces,
   * because storage would refuse it and a refused write would latch the whole journal read-only.
   */
  declines(event: BraidEvent): boolean {
    const runId = eventRunId(event)
    return (
      runId !== undefined &&
      this.#terminalRuns.has(runId) &&
      !canAppendAfterTerminal({ kind: event.kind, terminal: event.kind === 'run.finished' })
    )
  }

  append(envelope: BraidEventEnvelope): Promise<{ readonly appended: boolean }> {
    return this.appendEnvelope(envelope)
  }

  appendWithState(
    envelope: BraidEventEnvelope,
    state: BraidState,
  ): Promise<{ readonly appended: boolean }> {
    const snapshot =
      this.#storage.appendWithSnapshot !== undefined && shouldSnapshot(state, envelope)
        ? snapshotForState(envelope, state, this.#storage.snapshotScopeId?.() ?? 'storage-default')
        : undefined
    return this.appendEnvelope(envelope, snapshot)
  }

  private appendEnvelope(
    envelope: BraidEventEnvelope,
    snapshot?: StateSnapshot,
  ): Promise<{ readonly appended: boolean }> {
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
    const runId =
      eventRunId(envelope.event) ?? syntheticRunId(context.workspaceId, context.conversationId)
    const operationId = runOperationId(envelope.event)
    const provider = providerMetaForEvent(envelope.event)
    const sequence = (this.#runSequences.get(runId) ?? 0) + 1
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
      ...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
      ...(provider === undefined ? {} : { providerEventId: provider.eventId }),
      ...(provider?.receivedAt === undefined ? {} : { receivedAt: provider.receivedAt }),
      ...(operationId === undefined ? {} : { operationId }),
      terminal: envelope.event.kind === 'run.finished',
    }
    const task = this.#pending
      .then(async () => {
        if (this.#failure !== undefined) throw this.#failure
        if (this.declines(envelope.event)) {
          this.#contexts.delete(eventId)
          return { appended: false as const }
        }
        const result =
          snapshot === undefined || this.#storage.appendWithSnapshot === undefined
            ? await this.#storage.append([record])
            : await this.#storage.appendWithSnapshot({ events: [record], snapshot })
        if (result.acceptedEventIds.length === 0) {
          this.#contexts.delete(eventId)
          return { appended: false as const }
        }
        this.#runSequences.set(runId, sequence)
        if (record.terminal === true) this.#terminalRuns.add(runId)
        if (record.terminal || envelope.event.kind === 'run.detached') this.runOwnership?.release(runId)
        this.#ownEvents.add(eventId)
        this.#events.push({ ...envelope, eventId })
        if (this.#events.length > MAX_IN_MEMORY_EVENTS) this.#events.shift()
        this.#contexts.delete(eventId)
        return { appended: true as const }
      })
      .catch((error) => {
        this.#failure = error
        throw error
      })
    this.#pending = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  async withTransition<T>(
    action: (events: readonly BraidEventEnvelope[]) => Promise<T>,
  ): Promise<T> {
    if (this.runOwnership === undefined) return action([])
    const synchronize = async () => {
      const stored = await this.#storage.events({ afterStorageId: this.#storageId })
      const foreign: BraidEventEnvelope[] = []
      for (const record of stored) {
        if (record.storageId === undefined)
          throw new Error('Shared journal requires a storage cursor')
        this.#storageId = record.storageId
        this.#runSequences.set(record.runId, record.sequence)
        if (record.terminal) this.#terminalRuns.add(record.runId)
        if (this.#ownEvents.delete(record.eventId)) continue
        const [envelope] = envelopesFromStored([record])
        if (envelope === undefined) continue
        this.#events.push(envelope)
        foreign.push(envelope)
      }
      this.#events.splice(0, Math.max(0, this.#events.length - MAX_IN_MEMORY_EVENTS))
      return action(foreign)
    }
    return this.runOwnership.transition(synchronize)
  }

  all(): readonly BraidEventEnvelope[] {
    return this.#events.map((event) => structuredClone(event))
  }

  async loadEvents(input: { readonly runId?: RunId }): Promise<readonly BraidEventEnvelope[]> {
    await this.flush()
    const stored = await this.#storage.events(input)
    return envelopesFromStored(stored).map((event) => structuredClone(event))
  }

  replay(): readonly BraidEventEnvelope[] {
    const events = this.#replayEvents ?? this.#events
    this.#replayEvents = undefined
    return events.map((event) => structuredClone(event))
  }

  initialState(): BraidState | undefined {
    return this.#initialState === undefined ? undefined : structuredClone(this.#initialState)
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
    this.runOwnership?.close()
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

  fingerprint(input: { readonly effectKind: string; readonly request: unknown }): string {
    return this.#storage.fingerprint?.(input) ?? this.#fallbackFingerprint.fingerprint(input)
  }
}
