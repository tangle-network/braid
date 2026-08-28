import type {
  BraidEvent,
  BraidEventEnvelope,
  ProviderEventMeta,
  RunTerminalStatus,
} from './events.js'
import type { BraidInteraction } from './runtime-projection.js'
import type {
  BraidActivity,
  BraidMessage,
  BraidMessagePart,
  BraidRun,
  BraidState,
  MessagePartSource,
  MessageStatus,
  RunStatus,
} from './state.js'

export const TERMINAL_RUN_STATES: readonly RunStatus[] = [
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'blocked',
  'expired',
  'unknown',
]

export const MAX_RUN_PARTS = 512
export const MAX_RUN_ACTIVITY_ITEMS = 512
export const MAX_RUN_EVENT_DETAILS = 512
export const MAX_RUN_INTERACTIONS = 256

export function assertNextEnvelope(state: BraidState, envelope: BraidEventEnvelope): void {
  if (envelope.sequence !== state.sequence + 1) {
    throw new Error(`Event sequence ${envelope.sequence} does not follow ${state.sequence}`)
  }
  if (envelope.revision !== state.revision + 1) {
    throw new Error(`Event revision ${envelope.revision} does not follow ${state.revision}`)
  }
}

export function sourceFromProvider(
  provider: ProviderEventMeta | undefined,
): MessagePartSource | undefined {
  if (!provider) return undefined
  return {
    eventId: provider.eventId,
    sequence: provider.providerSequence,
    ...(provider.cursor === undefined ? {} : { cursor: provider.cursor }),
    ...(provider.occurredAt === undefined ? {} : { occurredAt: provider.occurredAt }),
  }
}

export function activity(
  event: BraidEvent,
  type: string,
  label: string,
  detail?: string,
  source?: MessagePartSource,
): BraidActivity {
  const runId = 'runId' in event && event.runId ? event.runId : 'run-unknown'
  return {
    id: `${runId}:${type}:${source?.eventId ?? 'local'}:${label}`,
    runId,
    type,
    label,
    ...(detail === undefined ? {} : { detail }),
    ...(source === undefined ? {} : { source }),
  }
}

export function terminalMessageStatus(status: RunTerminalStatus): MessageStatus {
  switch (status) {
    case 'completed':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'aborted'
    case 'cancelled':
      return 'cancelled'
    case 'blocked':
      return 'blocked'
    case 'expired':
      return 'expired'
    case 'unknown':
      return 'unknown'
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

export function terminalPartStatus(
  status: RunTerminalStatus,
): NonNullable<BraidMessagePart['status']> {
  switch (status) {
    case 'completed':
      return 'complete'
    case 'failed':
      return 'failed'
    case 'aborted':
    case 'cancelled':
      return 'cancelled'
    case 'blocked':
    case 'expired':
    case 'unknown':
      return 'unknown'
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

export function findRun(state: BraidState, runId: string): BraidRun {
  const run = state.runs.find((candidate) => candidate.id === runId)
  if (!run) throw new Error(`Run ${runId} is unknown`)
  return run
}

export function updateRun(
  state: BraidState,
  runId: string,
  update: (run: BraidRun) => BraidRun,
): readonly BraidRun[] {
  return state.runs.map((run) => (run.id === runId ? update(run) : run))
}

export function updateMessage(
  state: BraidState,
  runId: string,
  update: (message: BraidMessage) => BraidMessage,
): readonly BraidMessage[] {
  return state.messages.map((message) =>
    message.runId === runId && message.role === 'assistant' ? update(message) : message,
  )
}

export function upsertPart(
  message: BraidMessage,
  part: BraidMessagePart,
  delta?: string,
): BraidMessage {
  const existing = message.parts.find((candidate) => candidate.id === part.id)
  const nextPart: BraidMessagePart =
    existing && delta !== undefined
      ? {
          ...part,
          text:
            part.text === `${existing.text ?? ''}${delta}`
              ? part.text
              : `${existing.text ?? ''}${delta}`,
        }
      : part
  const updatedParts = existing
    ? message.parts.map((candidate) => (candidate.id === part.id ? nextPart : candidate))
    : [...message.parts, nextPart]
  const partsTruncated = updatedParts.length > MAX_RUN_PARTS
  const parts = partsTruncated ? updatedParts.slice(-MAX_RUN_PARTS) : updatedParts
  const nextText =
    nextPart.kind === 'text'
      ? delta === undefined
        ? (nextPart.text ?? message.text)
        : `${message.text}${delta}`
      : message.text
  return {
    ...message,
    text: nextText,
    parts,
    ...(partsTruncated ? { partsTruncated: true } : {}),
  }
}

export function withProviderProgress(
  run: BraidRun,
  provider: ProviderEventMeta | undefined,
): BraidRun {
  if (!provider) return run
  if (provider.providerSequence <= run.lastProviderSequence) return run
  const missingSequence =
    provider.providerSequence > run.lastProviderSequence + 1
      ? { from: run.lastProviderSequence + 1, to: provider.providerSequence - 1 }
      : undefined
  return {
    ...run,
    lastProviderSequence: provider.providerSequence,
    eventCount: run.eventCount + 1,
    ...(provider.cursor === undefined ? {} : { lastCursor: provider.cursor }),
    ...(missingSequence === undefined ? {} : { missingSequence }),
  }
}

export function addActivity(run: BraidRun, item: BraidActivity): BraidRun {
  const activity = [...run.activity, item]
  return {
    ...run,
    activity: activity.slice(-MAX_RUN_ACTIVITY_ITEMS),
    ...(activity.length > MAX_RUN_ACTIVITY_ITEMS ? { activityTruncated: true } : {}),
  }
}

/**
 * Keep pending interaction identity separate from the bounded display list.
 * An absent index on a truncated legacy run means pending state is unknown.
 */
export function withPendingInteractionIndex(
  run: BraidRun,
  interactions: readonly BraidInteraction[],
): BraidRun {
  const pending = pendingInteractionIds(run, interactions)
  return {
    ...run,
    interactions,
    ...(pending === undefined ? {} : { pendingInteractionIds: pending }),
  }
}

function pendingInteractionIds(
  run: BraidRun,
  interactions: readonly BraidInteraction[],
): readonly string[] | undefined {
  if (run.pendingInteractionIds === undefined && run.interactionsTruncated) return undefined
  const values = new Set(run.pendingInteractionIds ?? [])
  for (const interaction of interactions) {
    if (interaction.status === 'pending') values.add(interaction.request.id)
    else values.delete(interaction.request.id)
  }
  return [...values]
}

export function assertTerminalTransition(current: RunStatus, next: RunStatus): void {
  if (TERMINAL_RUN_STATES.includes(current) && current !== next) {
    throw new Error(`Run cannot transition from terminal ${current} to ${next}`)
  }
}

export function isCancellationConfirmedReconciliation(
  event: Extract<BraidEvent, { readonly kind: 'run.reconciled' }>,
  state: BraidState,
  current: RunStatus,
): boolean {
  const operation =
    event.operationId === undefined
      ? undefined
      : state.operations.find((candidate) => candidate.id === event.operationId)
  return (
    event.correction === 'cancellation-confirmed' &&
    operation?.kind === 'cancel-run' &&
    operation.target?.kind === 'run' &&
    operation.target.id === event.runId &&
    event.from === current &&
    event.to !== undefined &&
    event.to === event.status &&
    (current === 'failed' || current === 'unknown') &&
    (event.to === 'cancelled' || event.to === 'aborted')
  )
}

export type ReducerBase = Pick<BraidState, 'revision' | 'sequence'>
