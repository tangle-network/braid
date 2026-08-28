import type { ProviderEventMeta } from '../domain/events.js'
import type { RuntimeEventEnvelope } from '../domain/runtime-events.js'
import { isCanonicalIsoDateTime } from '../domain/text.js'
import type { IngestionPort, RuntimeEventIngestionResult } from './application-ports.js'
import { AppError } from './errors.js'
import { safePublicIdentifier } from './provider-values.js'
import { providerEventFor, safeProviderMeta } from './run-event-mapper.js'

export function ingestRuntimeEvent(
  context: IngestionPort,
  envelope: RuntimeEventEnvelope,
): RuntimeEventIngestionResult | Promise<RuntimeEventIngestionResult> {
  if (
    !safePublicIdentifier(envelope.eventId) ||
    !Number.isSafeInteger(envelope.sequence) ||
    envelope.sequence < 1 ||
    envelope.sequence > 1_000_000_000 ||
    !isCanonicalIsoDateTime(envelope.receivedAt) ||
    (envelope.cursor !== undefined && !safePublicIdentifier(envelope.cursor)) ||
    (envelope.occurredAt !== undefined && !isCanonicalIsoDateTime(envelope.occurredAt))
  )
    throw new AppError('INVALID_PROVIDER_EVENT', 'Provider event identity or timestamp is invalid')
  const key = `${envelope.runId}:${envelope.eventId}`
  if (context.ledger.hasProviderEvent(key)) return { accepted: false, duplicate: true }
  const run = context.findRun(envelope.runId)
  const expected = run.lastProviderSequence + 1
  if (envelope.sequence < expected) {
    const isMissing = context
      .currentState()
      .missingHistory.some(
        (range) =>
          range.runId === run.id &&
          envelope.sequence >= range.fromSequence &&
          envelope.sequence <= (range.toSequence ?? range.fromSequence),
      )
    if (!isMissing) return { accepted: false, duplicate: true }
    return afterCommit(context, envelope, commitEnvelope(context, envelope), {
      accepted: true,
      duplicate: false,
    })
  }
  if (envelope.sequence > expected) {
    const gap = { from: expected, to: envelope.sequence - 1 }
    const commits: Array<void | Promise<void>> = []
    if (
      !context
        .currentState()
        .missingHistory.some(
          (range) =>
            range.runId === run.id &&
            range.fromSequence <= gap.to &&
            (range.toSequence ?? range.fromSequence) >= gap.from,
        )
    )
      commits.push(
        context.commitAndWait({
          kind: 'history.missing',
          range: { runId: run.id, fromSequence: gap.from, toSequence: gap.to, reason: 'gap' },
        }),
      )
    if (run.status !== 'reconnecting')
      commits.push(
        context.commitAndWait({
          kind: 'run.reconnecting',
          runId: run.id,
          ...(run.lastCursor === undefined ? {} : { after: run.lastCursor }),
        }),
      )
    return afterCommits(commits, { accepted: false, duplicate: false, sequenceGap: gap })
  }
  return afterCommit(context, envelope, commitEnvelope(context, envelope), {
    accepted: true,
    duplicate: false,
  })
}

function afterCommit(
  context: IngestionPort,
  envelope: RuntimeEventEnvelope,
  commit: void | Promise<void>,
  result: RuntimeEventIngestionResult,
): RuntimeEventIngestionResult | Promise<RuntimeEventIngestionResult> {
  if (isPromiseLike(commit))
    return commit.then(() => {
      if (envelope.event.type === 'final') context.streamSanitizer.reset(envelope.runId)
      return result
    })
  if (envelope.event.type === 'final') context.streamSanitizer.reset(envelope.runId)
  return result
}

function commitEnvelope(
  context: IngestionPort,
  envelope: RuntimeEventEnvelope,
): void | Promise<void> {
  const event = eventFromEnvelope(context, envelope)
  if (
    event.kind !== 'run.finished' ||
    envelope.event.type !== 'final' ||
    (envelope.event.text !== undefined && envelope.event.text.length > 0) ||
    event.finalText.length === 0
  )
    return context.commitAndWait(event)

  return context.commitAndWait({ ...event, finalTextMode: 'append' })
}

function afterCommits(
  commits: readonly (void | Promise<void>)[],
  result: RuntimeEventIngestionResult,
): RuntimeEventIngestionResult | Promise<RuntimeEventIngestionResult> {
  const pending = commits.filter(isPromiseLike)
  return pending.length === 0 ? result : Promise.all(pending).then(() => result)
}

function isPromiseLike(value: unknown): value is Promise<void> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

function eventFromEnvelope(context: IngestionPort, envelope: RuntimeEventEnvelope) {
  const meta: ProviderEventMeta = safeProviderMeta(
    {
      eventId: envelope.eventId,
      providerSequence: envelope.sequence,
      ...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
      ...(envelope.occurredAt === undefined ? {} : { occurredAt: envelope.occurredAt }),
      receivedAt: envelope.receivedAt,
    },
    envelope.sequence,
  )
  const event = providerEventFor(envelope.runId, envelope.event, meta, context.streamSanitizer)
  return event
}
