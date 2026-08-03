import type { BraidEventEnvelope } from '../../domain/events.js'
import type { BraidState } from '../../domain/state.js'
import type {
  ActivityItemView,
  GraphNodeView,
  HeadlessState,
  MessageView,
  RunView,
  TranscriptPartView,
  ViewStatus,
} from '../../views/shared/models.js'
import type { UiEvent } from '../../views/shared/intents.js'
import { freezeView } from '../../views/shared/models.js'
import { redactStructuredValue } from '../../views/shared/sanitize.js'
import { boundVisibleText, sanitizeTerminalText } from '../../views/shared/sanitize.js'

export const MAX_VISIBLE_MESSAGES = 200
export const MAX_VISIBLE_RUNS = 500

export function statusFor(state: BraidState): ViewStatus {
  if (state.activeRunId) {
    const active = state.runs.find((run) => run.id === state.activeRunId)
    return active?.status === 'cancelling' ? 'cancelling' : 'running'
  }
  const status = state.runs.at(-1)?.status
  if (!status) return state.messages.length === 0 ? 'empty' : 'ready'
  switch (status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'cancelled'
    case 'blocked':
      return 'waiting'
    case 'streaming':
      return 'running'
    case 'cancelling':
      return 'cancelling'
    case 'unknown':
      return 'unknown'
    default:
      return 'unknown'
  }
}

function statusForRun(state: BraidState, run: BraidState['runs'][number]): ViewStatus {
  if (state.activeRunId === run.id) return run.status === 'cancelling' ? 'cancelling' : 'running'
  switch (run.status) {
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'cancelled'
    case 'blocked':
      return 'waiting'
    case 'streaming':
      return 'running'
    default:
      return 'unknown'
  }
}

function partFor(message: BraidState['messages'][number]): TranscriptPartView[] {
  const text = boundVisibleText(message.text)
  if (!text) return []
  return [
    Object.freeze({
      id: `${message.id}:text`,
      kind: 'text' as const,
      text,
      status: message.status === 'streaming' ? ('running' as const) : ('complete' as const),
    }),
  ]
}

function messagesFor(state: BraidState): MessageView[] {
  return state.messages.slice(-MAX_VISIBLE_MESSAGES).map((message) =>
    Object.freeze({
      id: message.id,
      role: message.role,
      text: sanitizeTerminalText(boundVisibleText(message.text)),
      status:
        message.status === 'aborted'
          ? ('cancelled' as const)
          : message.status === 'incomplete'
            ? ('incomplete' as const)
            : message.status,
      ...(message.runId ? { runId: message.runId } : {}),
      parts: Object.freeze(partFor(message)),
    }),
  )
}

export function runViews(state: BraidState): RunView[] {
  return state.runs.slice(-MAX_VISIBLE_RUNS).map((run) =>
    Object.freeze({
      id: run.id,
      turnId: run.turnId,
      operationId: run.operationId,
      status: statusForRun(state, run),
      ...(run.error ? { error: sanitizeTerminalText(run.error) } : {}),
      ...(run.costUsd === undefined && run.model === undefined
        ? {}
        : {
            usage: {
              ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
              ...(run.model === undefined ? {} : { model: run.model }),
            },
          }),
      completeness: run.status === 'streaming' ? ('incomplete' as const) : ('unavailable' as const),
    }),
  )
}

export function activityFor(state: BraidState): ActivityItemView[] {
  return state.runs.slice(-MAX_VISIBLE_RUNS).map((run) => ({
    id: `activity:${run.id}`,
    kind: 'run' as const,
    title: `run ${run.id}`,
    status: statusForRun(state, run),
    ...(run.error ? { detail: sanitizeTerminalText(run.error) } : {}),
  }))
}

export function graphFor(state: BraidState): GraphNodeView[] {
  const nodes: GraphNodeView[] = [
    {
      id: state.conversationId,
      type: 'conversation',
      title: state.conversationId,
      status: statusFor(state),
      depth: 0,
    },
    {
      id: state.branchId,
      type: 'branch',
      title: state.branchId,
      status: statusFor(state),
      depth: 0,
    },
  ]
  for (const run of state.runs.slice(-MAX_VISIBLE_RUNS)) {
    nodes.push({
      id: run.id,
      type: 'run',
      title: `run ${run.id}`,
      status: statusForRun(state, run),
      depth: 0,
    })
  }
  return nodes
}

export function toHeadlessState(state: BraidState): HeadlessState {
  return freezeView({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    sequence: state.sequence,
    workspace: state.workspace ? sanitizeTerminalText(state.workspace) : null,
    conversationId: state.conversationId,
    branchId: state.branchId,
    profile: redactStructuredValue(state.profile) as Readonly<Record<string, unknown>>,
    draft: sanitizeTerminalText(state.draft),
    messages: state.messages.slice(-MAX_VISIBLE_MESSAGES).map((message) => ({
      id: message.id,
      role: message.role,
      text: sanitizeTerminalText(boundVisibleText(message.text)),
      status: message.status,
      ...(message.runId ? { runId: message.runId } : {}),
    })),
    runs: state.runs.slice(-MAX_VISIBLE_RUNS).map((run) => ({
      id: run.id,
      turnId: run.turnId,
      operationId: run.operationId,
      status: run.status,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      ...(run.costUsd === undefined ? {} : { costUsd: run.costUsd }),
      ...(run.model === undefined ? {} : { model: sanitizeTerminalText(run.model) }),
      ...(run.error === undefined ? {} : { error: sanitizeTerminalText(run.error) }),
    })),
    activeRunId: state.activeRunId,
    lastError: state.lastError ? sanitizeTerminalText(state.lastError) : null,
  })
}

export function toEvent(envelope: BraidEventEnvelope): UiEvent {
  const payload = redactStructuredValue(envelope.event) as Readonly<Record<string, unknown>>
  return freezeView({
    sequence: envelope.sequence,
    revision: envelope.revision,
    kind: envelope.event.kind,
    payload: Object.freeze(payload),
  })
}

export { messagesFor }
