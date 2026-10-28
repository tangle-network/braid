import { isAbsolute } from 'node:path'
import { canonicalDigest } from '../domain/canonical.js'
import type {
  FrozenAnalysisSource,
  MessagePartRecord,
  MessageRecord,
  MissingHistoryRange,
  RunRecord,
} from '../domain/entities.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
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
  type AnalysisApplicationHost,
  AnalysisSourceError,
  type AnalysisSourceRequest,
  type FrozenAnalysisEvent,
  type FrozenAnalysisEvidence,
  type RuntimeRunEvidence,
} from './analysis-types.js'
import { messagesVisibleOnBranch } from './conversation-context.js'

export interface FreezeAnalysisSourceInput extends AnalysisSourceRequest {
  readonly state: BraidState
  readonly events: readonly BraidEventEnvelope[]
  readonly runtime?: RuntimeRunEvidence
}

export type AnalysisSourceKind = 'run' | 'branch' | 'runtime'

export interface AnalysisSourceReference {
  readonly kind: AnalysisSourceKind
  readonly id: string
}

export interface AnalysisSourceProjection {
  readonly reference: AnalysisSourceReference
  readonly request: AnalysisSourceRequest
}

async function loadAnalysisSourceEvents(
  host: AnalysisApplicationHost,
  source: AnalysisSourceRequest,
): Promise<readonly BraidEventEnvelope[]> {
  return host.loadEventHistory === undefined ? host.eventHistory() : host.loadEventHistory(source)
}

/** Loads exact persisted history without crossing the captured state revision. */
export async function loadFrozenAnalysisSources(
  host: AnalysisApplicationHost,
  state: BraidState,
  sources: readonly AnalysisSourceRequest[],
): Promise<readonly FrozenAnalysisEvidence[]> {
  const histories = await Promise.all(
    sources.map(async (source) => {
      if (source.runtimeRun !== undefined) {
        if (host.loadRuntimeRun === undefined) {
          throw new AnalysisSourceError('This Braid host cannot read Runtime runs')
        }
        return { events: [], runtime: await host.loadRuntimeRun(source.runtimeRun) }
      }
      const events = await loadAnalysisSourceEvents(host, source)
      return { events: events.filter((envelope) => envelope.sequence <= state.sequence) }
    }),
  )
  return sources.map((source, index) =>
    freezeAnalysisSource({ ...source, state, ...(histories[index] ?? { events: [] }) }),
  )
}

export async function loadFrozenAnalysisSource(
  host: AnalysisApplicationHost,
  state: BraidState,
  source: AnalysisSourceRequest,
): Promise<FrozenAnalysisEvidence> {
  const evidence = await loadFrozenAnalysisSources(host, state, [source])
  const captured = evidence[0]
  if (captured === undefined) throw new AnalysisSourceError('Analysis source was not captured')
  return captured
}

/** Parses the stable command token without resolving it against current state. */
export function parseAnalysisSourceReference(value: string): AnalysisSourceReference | undefined {
  const normalized = value.trim()
  for (const kind of ['run', 'branch', 'runtime'] as const) {
    const prefix = `${kind}:`
    if (!normalized.startsWith(prefix)) continue
    const id = normalized.slice(prefix.length).trim()
    return id.length === 0 ? undefined : { kind, id }
  }
  return undefined
}

/** `runtime:<runId>@<runDir>` names a Runtime durable run; Braid verifies the pair when it reads. */
function runtimeProjection(reference: AnalysisSourceReference): AnalysisSourceProjection {
  const separator = reference.id.indexOf('@')
  const runId = reference.id.slice(0, separator)
  const runDir = reference.id.slice(separator + 1)
  if (separator <= 0 || !isAbsolute(runDir)) {
    throw new AnalysisSourceError('A Runtime source is runtime:<runId>@<absolute runDir>')
  }
  return { reference, request: { runtimeRun: { runId, runDir } } }
}

/** Resolves one command source and retains whether the user named a run or branch. */
export function projectAnalysisSource(
  state: BraidState,
  value: string,
): AnalysisSourceProjection | undefined {
  const normalized = value.trim()
  if (normalized === 'active' || normalized === 'last') {
    const run = [...state.runs]
      .reverse()
      .find(
        (candidate) =>
          candidate.branchId === state.branchId &&
          candidate.complete &&
          (candidate.status === 'completed' || candidate.status === 'failed'),
      )
    return run === undefined ? undefined : projectionForRun(run)
  }

  const parsed = parseAnalysisSourceReference(normalized)
  if (parsed?.kind === 'runtime') return runtimeProjection(parsed)
  if (parsed?.kind === 'run') {
    const run = state.runs.find((candidate) => String(candidate.id) === parsed.id)
    return run === undefined ? undefined : projectionForRun(run)
  }
  if (parsed?.kind === 'branch') {
    const branch = state.branches.find((candidate) => String(candidate.id) === parsed.id)
    return branch === undefined ? undefined : projectionForBranch(branch)
  }

  const run = state.runs.find((candidate) => String(candidate.id) === normalized)
  if (run !== undefined) return projectionForRun(run)
  const branch = state.branches.find((candidate) => String(candidate.id) === normalized)
  return branch === undefined ? undefined : projectionForBranch(branch)
}

function projectionForRun(run: RunRecord): AnalysisSourceProjection {
  return {
    reference: { kind: 'run', id: String(run.id) },
    request: { conversationId: run.conversationId, branchId: run.branchId, runId: run.id },
  }
}

function projectionForBranch(branch: BraidState['branches'][number]): AnalysisSourceProjection {
  return {
    reference: { kind: 'branch', id: String(branch.id) },
    request: { conversationId: branch.conversationId, branchId: branch.id },
  }
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
  return sourceDigest(evidence.source, evidence)
}

/** Braid-only sources keep the digest shape they had before Runtime sources existed. */
function sourceDigest(
  source: Omit<FrozenAnalysisSource, 'digest' | 'trace'>,
  evidence: Omit<FrozenAnalysisEvidence, 'source'>,
): Digest {
  return canonicalDigest({
    conversationId: source.conversationId,
    branchId: source.branchId,
    runId: source.runId,
    ...(source.runtimeRun === undefined ? {} : { runtimeRun: source.runtimeRun }),
    throughMessageId: source.throughMessageId,
    evidenceDigest: canonicalDigest({
      run: evidence.run,
      events: evidence.events,
      messages: evidence.messages,
      messageParts: evidence.messageParts,
      ...(evidence.runtime === undefined ? {} : { runtime: evidence.runtime }),
    }),
    complete: source.complete,
    missingHistory: source.missingHistory,
  })
}

export function freezeAnalysisSource(input: FreezeAnalysisSourceInput): FrozenAnalysisEvidence {
  const conversationId = input.conversationId ?? input.state.conversationId
  const branchId = input.branchId ?? input.state.branchId
  if (conversationId === null || branchId === null) {
    throw new AnalysisSourceError('Analysis requires an open conversation and branch')
  }
  if (input.runtime !== undefined)
    return freezeRuntimeSource(conversationId, branchId, input.runtime)

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
  const evidence = {
    ...(run === undefined ? {} : { run: redactedClone(run) }),
    events: sourceEvents(input.events, run?.id),
    messages,
    messageParts: messageParts(input.state, messages),
  }
  const complete =
    missingHistory === undefined &&
    (run === undefined ||
      (run.complete && (throughMessageId === undefined || throughSequence !== undefined)))
  const unsigned = {
    conversationId,
    branchId,
    ...(run === undefined ? {} : { runId: run.id }),
    ...(throughMessageId === undefined ? {} : { throughMessageId }),
    complete,
    ...(missingHistory === undefined ? {} : { missingHistory }),
  }
  return signedEvidence(
    unsigned,
    evidence,
    run === undefined ? undefined : { id: String(run.id), reference: `braid://run/${run.id}` },
  )
}

/** A Runtime run is analyzed in the open Braid conversation's journal scope, never as a Braid run. */
function freezeRuntimeSource(
  conversationId: ConversationId,
  branchId: BranchId,
  runtime: RuntimeRunEvidence,
): FrozenAnalysisEvidence {
  return signedEvidence(
    {
      conversationId,
      branchId,
      runtimeRun: { runId: runtime.runId, runDir: runtime.runDir },
      complete: runtime.settled,
    },
    { runtime: cloneAndFreeze(runtime), events: [], messages: [], messageParts: [] },
    {
      id: `runtime-${runtime.runId}`,
      reference: `runtime-run://${encodeURIComponent(runtime.runId)}`,
    },
  )
}

function signedEvidence(
  unsigned: Omit<FrozenAnalysisSource, 'digest' | 'trace'>,
  evidence: Omit<FrozenAnalysisEvidence, 'source'>,
  trace: { readonly id: string; readonly reference: string } | undefined,
): FrozenAnalysisEvidence {
  const digest = sourceDigest(unsigned, evidence)
  const source = cloneAndFreeze({
    ...unsigned,
    ...(trace === undefined
      ? {}
      : {
          trace: {
            id: createTraceId(`trace-${trace.id.replace(/[^A-Za-z0-9._:-]/gu, '-')}`),
            provider: 'runtime' as const,
            reference: trace.reference,
            digest,
          },
        }),
    digest,
  })
  return cloneAndFreeze({ source, ...evidence })
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
