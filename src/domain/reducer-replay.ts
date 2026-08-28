import { canonicalDigest } from './canonical.js'
import {
  type BraidEvent,
  type BraidEventEnvelope,
  type DomainBraidEventMap,
  eventRunId,
} from './events.js'
import { createEventId, type EventId, parseReplayCursor } from './ids.js'
import { assertBraidState, DomainInvariantError } from './invariants.js'
import { canonicalProjectionChecksum } from './projection-checksum.js'
import { applyDomainEvent } from './reducer-domain-events.js'
import {
  DuplicateEventConflictError,
  SequenceGapError,
  upsert,
  upsertBy,
  withHealth,
} from './reducer-helpers.js'
import { reduceLegacyEvent } from './reducer-legacy.js'
import { isRuntimeEvent, reduceRuntimeEvent } from './reducer-runtime.js'
import { normalizeActiveRuns, type BraidState, initialState } from './state.js'
import { isCanonicalIsoDateTime } from './text.js'

export const MAX_APPLIED_EVENT_HISTORY = 256

function boundedAppliedEvents(
  events: readonly BraidState['appliedEvents'][number][],
): BraidState['appliedEvents'] {
  return events.slice(-MAX_APPLIED_EVENT_HISTORY)
}

function applyEnvelopeMetadata(
  envelope: BraidEventEnvelope,
  reduced: BraidState,
  eventId: EventId,
  digest: ReturnType<typeof canonicalDigest>,
  options: {
    readonly appliedEvents?: BraidState['appliedEvents']
    readonly finalize?: boolean
  } = {},
): BraidState {
  let next: BraidState = normalizeActiveRuns({
    ...reduced,
    revision: envelope.revision,
    sequence: envelope.sequence,
    appliedEvents:
      options.appliedEvents ??
      boundedAppliedEvents([
        ...reduced.appliedEvents,
        { id: eventId, sequence: envelope.sequence, revision: envelope.revision, digest },
      ]),
  })
  const runId = eventRunId(envelope.event)
  if (envelope.cursor !== undefined && runId !== undefined) {
    const cursor = parseReplayCursor(envelope.cursor)
    const run = next.runs.find((entry) => entry.id === runId)
    next = {
      ...next,
      replayCursors: upsertBy(next.replayCursors, (entry) => entry.runId, {
        runId,
        cursor,
        committedSequence: envelope.sequence,
      }),
      ...(run === undefined
        ? {}
        : {
            runs: upsert(next.runs, {
              ...run,
              replayCursor: cursor,
              updatedAt: envelope.occurredAt,
            }),
          }),
    }
  }
  if (options.finalize !== false) {
    next = finalizeReducedState(next)
  } else {
    assertBraidState(next)
  }
  return next
}

function finalizeReducedState(state: BraidState): BraidState {
  const healthy = withHealth(normalizeActiveRuns(state))
  const finalized = {
    ...healthy,
    projectionChecksum: canonicalProjectionChecksum(healthy),
  }
  assertBraidState(finalized)
  return finalized
}

const LEGACY_EVENT_KINDS = [
  'workspace.opened',
  'draft.changed',
  'run.requested',
  'run.text.delta',
  'run.cancel.requested',
  'run.finished',
  'application.shutdown.requested',
] as const

type LegacyEventKind = (typeof LEGACY_EVENT_KINDS)[number]

function isLegacyEvent(
  event: BraidEvent,
): event is Extract<BraidEvent, { readonly kind: LegacyEventKind }> {
  return (LEGACY_EVENT_KINDS as readonly string[]).includes(event.kind)
}

export function reduceEvent(state: BraidState, envelope: BraidEventEnvelope): BraidState {
  if (!isCanonicalIsoDateTime(envelope.occurredAt)) {
    throw new DomainInvariantError('Event occurredAt is not a canonical ISO date')
  }
  const eventId = envelope.eventId ?? createEventId(`event-${envelope.sequence}`)
  const digest = canonicalDigest({
    event: envelope.event,
    cursor: envelope.cursor ?? null,
    occurredAt: envelope.occurredAt,
  })
  if (envelope.sequence !== state.sequence + 1 || envelope.revision !== state.revision + 1) {
    const applied = state.appliedEvents.find((entry) => entry.id === eventId)
    if (applied !== undefined) {
      if (
        applied.sequence !== envelope.sequence ||
        applied.revision !== envelope.revision ||
        applied.digest !== digest
      ) {
        throw new DuplicateEventConflictError(eventId)
      }
      return state
    }
    throw new SequenceGapError(state, envelope)
  }
  const reduced = isRuntimeEvent(envelope.event)
    ? reduceRuntimeEvent(state, envelope)
    : isLegacyEvent(envelope.event)
      ? reduceLegacyEvent(state, envelope.event, envelope)
      : applyDomainEvent(state, envelope.event, envelope.occurredAt)
  return applyEnvelopeMetadata(envelope, reduced, eventId, digest)
}

export function replayEvents(
  initial: BraidState,
  events: readonly BraidEventEnvelope[],
): BraidState {
  if (events.length === 0) return initial
  const appliedById = new Map(initial.appliedEvents.map((entry) => [entry.id, entry]))
  const appended: BraidState['appliedEvents'][number][] = []
  let state = initial
  for (const envelope of events) {
    if (!isCanonicalIsoDateTime(envelope.occurredAt)) {
      throw new DomainInvariantError('Event occurredAt is not a canonical ISO date')
    }
    const eventId = envelope.eventId ?? createEventId(`event-${envelope.sequence}`)
    const digest = canonicalDigest({
      event: envelope.event,
      cursor: envelope.cursor ?? null,
      occurredAt: envelope.occurredAt,
    })
    const applied = appliedById.get(eventId)
    if (applied !== undefined) {
      if (
        applied.sequence !== envelope.sequence ||
        applied.revision !== envelope.revision ||
        applied.digest !== digest
      ) {
        throw new DuplicateEventConflictError(eventId)
      }
      continue
    }
    if (envelope.sequence !== state.sequence + 1 || envelope.revision !== state.revision + 1) {
      throw new SequenceGapError(state, envelope)
    }
    const reduced = isRuntimeEvent(envelope.event)
      ? reduceRuntimeEvent(state, envelope)
      : isLegacyEvent(envelope.event)
        ? reduceLegacyEvent(state, envelope.event, envelope)
        : applyDomainEvent(state, envelope.event, envelope.occurredAt)
    const record = {
      id: eventId,
      sequence: envelope.sequence,
      revision: envelope.revision,
      digest,
    }
    appended.push(record)
    appliedById.set(eventId, record)
    state = applyEnvelopeMetadata(envelope, reduced, eventId, digest, {
      appliedEvents: initial.appliedEvents,
      finalize: false,
    })
  }
  return finalizeReducedState({
    ...state,
    appliedEvents: boundedAppliedEvents([...initial.appliedEvents, ...appended]),
  })
}

export function replayJournal(
  initial: BraidState,
  events: readonly BraidEventEnvelope[],
): BraidState {
  return replayEvents(initial, events)
}

export function initialDomainState(
  profile: Readonly<import('@tangle-network/agent-interface').AgentProfile>,
): BraidState {
  return initialState(profile)
}

export type DomainEventPayload<K extends keyof DomainBraidEventMap> = DomainBraidEventMap[K]
