import { canonicalDigest } from '../domain/canonical.js'
import type {
  MessagePartRecord,
  MessageRecord,
  MissingHistoryRange,
  RunRecord,
} from '../domain/entities.js'
import type { BraidEvent, BraidEventEnvelope, JournalEventEnvelope } from '../domain/events.js'
import { eventRunId } from '../domain/events.js'
import {
  type BranchId,
  type ConversationId,
  createEventId,
  createTraceId,
  type Digest,
  type EventId,
  isEventId,
  type MessageId,
  type RunId,
} from '../domain/ids.js'
import { redactBraidEvent } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import {
  AnalysisSourceError,
  type AnalysisSourceRequest,
  type FrozenAnalysisEvent,
  type FrozenAnalysisEvidence,
} from './analysis-types.js'
import { messagesVisibleOnBranch } from './conversation-context.js'

export interface FreezeAnalysisSourceInput extends AnalysisSourceRequest {
  readonly state: BraidState
  readonly events: readonly BraidEventEnvelope[]
}

function cloneAndFreeze<T>(value: T): T {
  let cloned: T
  try {
    cloned = structuredClone(value)
  } catch (error) {
    throw new AnalysisSourceError(
      `Analysis source contains a value that cannot be snapshotted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  return freezeValue(cloned)
}

function freezeValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value as Record<string, unknown>)) freezeValue(child)
  return Object.freeze(value)
}

function safeEventId(envelope: BraidEventEnvelope, event: BraidEvent): EventId {
  if (envelope.eventId !== undefined && isEventId(envelope.eventId)) return envelope.eventId
  return createEventId(
    `event-${canonicalDigest({
      sequence: envelope.sequence,
      revision: envelope.revision,
      occurredAt: envelope.occurredAt,
      event,
    }).slice(0, 40)}`,
  )
}

function redactedClone<T>(value: T): T {
  return cloneAndFreeze(redactBraidEvent(cloneAndFreeze(value)))
}

function eventMessageId(event: BraidEvent): MessageId | undefined {
  return event.kind === 'message.created' ? event.message.id : undefined
}

function branchMessages(
  state: BraidState,
  conversationId: ConversationId,
  branchId: BranchId,
  throughMessageId: MessageId | undefined,
): readonly MessageRecord[] {
  const messages = messagesVisibleOnBranch(state, branchId).filter(
    (message) => message.conversationId === conversationId,
  )
  if (throughMessageId === undefined) return messages.map(redactedClone)
  const throughIndex = messages.findIndex((message) => message.id === throughMessageId)
  if (throughIndex < 0) return messages.map(redactedClone)
  return messages.slice(0, throughIndex + 1).map(redactedClone)
}

function messageParts(
  state: BraidState,
  messages: readonly MessageRecord[],
): readonly MessagePartRecord[] {
  const messageIds = new Set(messages.map((message) => message.id))
  return state.messageParts.filter((part) => messageIds.has(part.messageId)).map(redactedClone)
}

function matchingMissingHistory(
  state: BraidState,
  runId: RunId | undefined,
): MissingHistoryRange | undefined {
  if (runId === undefined) return undefined
  return state.missingHistory.find((range) => range.runId === runId)
}

function sourceRun(state: BraidState, runId: RunId | undefined): RunRecord | undefined {
  if (runId === undefined) return undefined
  const run = state.runs.find((candidate) => candidate.id === runId)
  if (run === undefined) throw new AnalysisSourceError(`Run ${runId} is not present in Braid state`)
  return run
}

function boundarySequence(
  events: readonly BraidEventEnvelope[],
  throughMessageId: MessageId | undefined,
): number | undefined {
  if (throughMessageId === undefined) return undefined
  const boundary = events.find((envelope) => {
    if (envelope.event.kind === 'message.created') {
      return eventMessageId(envelope.event) === throughMessageId
    }
    if (envelope.event.kind === 'run.requested') {
      return (
        envelope.event.userMessageId === throughMessageId ||
        envelope.event.assistantMessageId === throughMessageId
      )
    }
    return false
  })
  return boundary?.sequence
}

function sourceEvents(
  events: readonly BraidEventEnvelope[],
  runId: RunId | undefined,
): readonly FrozenAnalysisEvent[] {
  if (runId === undefined) return []
  const matching = events
    .filter((envelope) => eventRunId(envelope.event) === runId)
    .sort((left, right) => left.sequence - right.sequence)
  const terminalSequence = matching.find((envelope) => {
    if (envelope.event.kind === 'run.finished') return true
    if (envelope.event.kind === 'run.reconciled') {
      return [
        'completed',
        'failed',
        'cancelled',
        'aborted',
        'blocked',
        'expired',
        'unknown',
      ].includes(envelope.event.status)
    }
    return (
      envelope.event.kind === 'run.status.changed' &&
      ['completed', 'failed', 'cancelled', 'aborted', 'blocked', 'expired', 'unknown'].includes(
        envelope.event.status,
      )
    )
  })?.sequence
  return matching
    .filter((envelope) => terminalSequence === undefined || envelope.sequence <= terminalSequence)
    .map((envelope) => {
      const event = redactedClone(envelope.event)
      return cloneAndFreeze({
        id: safeEventId(envelope, event),
        sequence: envelope.sequence,
        revision: envelope.revision,
        occurredAt: envelope.occurredAt,
        event,
      })
    })
}

function sourceDigestForEvidence(evidence: FrozenAnalysisEvidence): Digest {
  const evidenceDigest = digestOfEvidence({
    run: evidence.run,
    events: evidence.events,
    messages: evidence.messages,
    messageParts: evidence.messageParts,
  })
  return canonicalDigest({
    conversationId: evidence.source.conversationId,
    branchId: evidence.source.branchId,
    runId: evidence.source.runId,
    throughMessageId: evidence.source.throughMessageId,
    evidenceDigest,
    complete: evidence.source.complete,
    missingHistory: evidence.source.missingHistory,
  })
}

function digestOfEvidence(input: {
  readonly run: RunRecord | undefined
  readonly events: readonly FrozenAnalysisEvent[]
  readonly messages: readonly MessageRecord[]
  readonly messageParts: readonly MessagePartRecord[]
}): Digest {
  return canonicalDigest(input)
}

export function freezeAnalysisSource(input: FreezeAnalysisSourceInput): FrozenAnalysisEvidence {
  const conversationId = input.conversationId ?? input.state.conversationId
  const branchId = input.branchId ?? input.state.branchId
  if (conversationId === null || branchId === null) {
    throw new AnalysisSourceError('Analysis requires an open conversation and branch')
  }

  const run = sourceRun(input.state, input.runId)
  if (run !== undefined) {
    if (run.conversationId !== conversationId || run.branchId !== branchId) {
      throw new AnalysisSourceError(
        `Run ${run.id} does not belong to ${conversationId}/${branchId}`,
      )
    }
  }

  const branch = input.state.branches.find((candidate) => candidate.id === branchId)
  const throughMessageId = input.throughMessageId ?? branch?.tipMessageId
  const throughSequence = boundarySequence(input.events, throughMessageId)
  const missingHistory = matchingMissingHistory(input.state, run?.id)
  const messages = branchMessages(input.state, conversationId, branchId, throughMessageId)
  const parts = messageParts(input.state, messages)
  const events = sourceEvents(input.events, run?.id)
  const evidenceDigest = digestOfEvidence({
    run: run === undefined ? undefined : redactedClone(run),
    events,
    messages,
    messageParts: parts,
  })
  const complete =
    missingHistory === undefined &&
    (run === undefined ||
      (run.complete && (throughMessageId === undefined || throughSequence !== undefined)))
  const sourceDigest = canonicalDigest({
    conversationId,
    branchId,
    runId: run?.id,
    throughMessageId,
    evidenceDigest,
    complete,
    missingHistory,
  })
  const source = cloneAndFreeze({
    conversationId,
    branchId,
    ...(run === undefined ? {} : { runId: run.id }),
    ...(throughMessageId === undefined ? {} : { throughMessageId }),
    ...(run === undefined
      ? {}
      : {
          trace: {
            id: createTraceId(`trace-${String(run.id).replace(/[^A-Za-z0-9._:-]/gu, '-')}`),
            provider: 'runtime' as const,
            reference: `braid://run/${run.id}`,
            digest: sourceDigest,
          },
        }),
    digest: sourceDigest,
    complete,
    ...(missingHistory === undefined ? {} : { missingHistory }),
  })

  return cloneAndFreeze({
    source,
    ...(run === undefined ? {} : { run: redactedClone(run) }),
    events,
    messages,
    messageParts: parts,
  })
}

export function verifyFrozenAnalysisSource(evidence: FrozenAnalysisEvidence): void {
  const expected = sourceDigestForEvidence(evidence)
  if (expected !== evidence.source.digest) {
    throw new AnalysisSourceError(
      `Frozen analysis source digest mismatch: expected ${expected}, received ${evidence.source.digest}`,
    )
  }
  if (evidence.source.trace !== undefined && evidence.source.trace.digest !== expected) {
    throw new AnalysisSourceError('Frozen trace reference digest does not match the source digest')
  }
}

export function sourceEventForId(
  evidence: FrozenAnalysisEvidence,
  eventId: EventId,
): FrozenAnalysisEvent | undefined {
  return evidence.events.find((event) => event.id === eventId)
}

export function sourceEventIdForEnvelope(envelope: JournalEventEnvelope): EventId {
  return safeEventId(envelope, envelope.event)
}
