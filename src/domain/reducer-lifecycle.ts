import type { BraidEvent } from './events.js'
import type { RunRecord, TurnRecord } from './entities.js'
import { createAdmissionReceipt } from './receipts.js'
import type { BraidState } from './state.js'
import { parseMessageId, parseRunId, parseTurnId } from './ids.js'
import { activity, addActivity, findRun, updateRun, type ReducerBase } from './reducer-support.js'
import { legacyMessage, legacyTextPart, upsert } from './reducer-helpers.js'
import { LEGACY_RUN_CAPABILITIES } from './runtime-projection.js'
import { attachRequestedRunToConversation } from './reducer-run-graph.js'

type LifecycleEvent = Extract<
  BraidEvent,
  {
    kind:
      | 'run.requested'
      | 'run.control.requested'
      | 'run.control.acknowledged'
      | 'run.queue.added'
      | 'run.queue.removed'
      | 'run.detached'
      | 'run.reconnecting'
      | 'run.reconciled'
      | 'run.unknown'
  }
>

export function reduceLifecycleEvent(
  state: BraidState,
  event: LifecycleEvent,
  base: ReducerBase,
  occurredAt: string,
): BraidState {
  switch (event.kind) {
    case 'run.requested':
      return reduceRequestedRun(state, event, base, occurredAt)
    case 'run.control.requested':
      findRun(state, event.runId)
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (candidate) =>
          addActivity(
            { ...candidate, status: event.control === 'cancel' ? 'cancelling' : candidate.status },
            activity(event, 'control', event.control, event.text ?? event.reason),
          ),
        ),
      }
    case 'run.control.acknowledged':
      findRun(state, event.runId)
      return {
        ...state,
        ...base,
        runs: updateRun(state, event.runId, (run) =>
          addActivity(run, activity(event, 'control.ack', event.control, event.outcome)),
        ),
      }
    case 'run.queue.added':
      return {
        ...state,
        ...base,
        queuedInputs: [
          ...state.queuedInputs,
          {
            operationId: event.operationId,
            runId: event.runId,
            text: event.text,
            position: event.position,
          },
        ],
        runs: updateRun(state, event.runId, (run) =>
          addActivity(run, activity(event, 'queue', `position ${event.position}`)),
        ),
      }
    case 'run.queue.removed':
      return {
        ...state,
        ...base,
        queuedInputs: state.queuedInputs
          .filter((input) => input.operationId !== event.operationId)
          .map((input, index) => ({ ...input, position: index + 1 })),
      }
    case 'run.detached':
      return {
        ...state,
        ...base,
        activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
        runs: updateRun(state, event.runId, (run) =>
          addActivity(
            {
              ...run,
              status: 'detached',
              ...(event.cursor === undefined ? {} : { lastCursor: event.cursor }),
            },
            activity(event, 'lifecycle', 'detached', event.detail),
          ),
        ),
      }
    case 'run.reconnecting':
      return {
        ...state,
        ...base,
        activeRunId: event.runId,
        runs: updateRun(state, event.runId, (run) =>
          addActivity(
            { ...run, status: 'reconnecting' },
            activity(event, 'lifecycle', 'reconnecting', event.after),
          ),
        ),
      }
    case 'run.reconciled': {
      const current = findRun(state, event.runId)
      if (event.from !== undefined && event.from !== current.status)
        throw new Error(`Run ${event.runId} reconciliation evidence is stale`)
      if (!event.evidence)
        throw new Error(`Run ${event.runId} reconciliation requires provider evidence`)
      if (
        ['completed', 'failed', 'aborted', 'cancelled', 'blocked', 'expired'].includes(
          current.status,
        )
      )
        throw new Error(`Run ${event.runId} cannot be reconciled after a proven terminal state`)
      const from = event.from ?? current.status
      const to = event.to ?? event.status
      return {
        ...state,
        ...base,
        activeRunId:
          isTerminalStatus(to) && state.activeRunId === event.runId
            ? null
            : isTerminalStatus(to)
              ? state.activeRunId
              : event.runId,
        runs: updateRun(state, event.runId, (run) =>
          addActivity(
            { ...run, status: to },
            activity(event, 'reconciliation', `${from} → ${to}`, event.detail),
          ),
        ),
      }
    }
    case 'run.unknown':
      return {
        ...state,
        ...base,
        activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
        messages: state.messages.map((message) =>
          message.runId === event.runId && message.role === 'assistant'
            ? { ...message, status: 'incomplete', complete: false }
            : message,
        ),
        runs: updateRun(state, event.runId, (run) =>
          addActivity(
            { ...run, status: 'unknown' },
            activity(event, 'lifecycle', 'unknown', event.detail),
          ),
        ),
        lastError: event.detail,
      }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function reduceRequestedRun(
  state: BraidState,
  event: Extract<BraidEvent, { kind: 'run.requested' }>,
  base: ReducerBase,
  occurredAt: string,
): BraidState {
  if (state.activeRunId) throw new Error(`Run ${state.activeRunId} is already active`)
  const runId = parseRunId(event.runId)
  const turnId = parseTurnId(event.turnId)
  const userMessageId = parseMessageId(event.userMessageId)
  const assistantMessageId = parseMessageId(event.assistantMessageId)
  const receipt =
    event.receipt ??
    createAdmissionReceipt({
      runId: event.runId,
      turnId: event.turnId,
      operationId: event.operationId,
      conversationId: state.conversationId,
      branchId: state.branchId,
      admittedAt: occurredAt,
      profile: state.profile,
      text: event.text,
      capabilities: LEGACY_RUN_CAPABILITIES,
    })
  const userMessage = legacyMessage(
    state,
    userMessageId,
    'user',
    event.text,
    runId,
    turnId,
    'complete',
    occurredAt,
  )
  const assistantMessage = {
    ...legacyMessage(
      state,
      assistantMessageId,
      'assistant',
      '',
      runId,
      turnId,
      'streaming',
      occurredAt,
    ),
    parts: [],
  }
  const turn: TurnRecord = {
    id: turnId,
    conversationId: state.conversationId,
    branchId: state.branchId,
    userMessageId,
    runIds: [runId],
    status: 'running',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
  const run: RunRecord = {
    id: runId,
    conversationId: state.conversationId,
    branchId: state.branchId,
    turnId,
    operationId: event.operationId,
    status: 'streaming' as const,
    receipt,
    capabilities: receipt.capabilities,
    ...(receipt.providerSessionId === undefined
      ? {}
      : { providerSessionId: receipt.providerSessionId }),
    inputTokens: 0,
    outputTokens: 0,
    complete: false,
    startedAt: occurredAt,
    updatedAt: occurredAt,
    lastProviderSequence: 0,
    eventCount: 0,
    interactions: [],
    activity: [activity(event, 'admission', 'admitted', `profile ${receipt.profileDigest}`)],
    eventDetails: [],
  }
  return attachRequestedRunToConversation(
    {
      ...state,
      ...base,
      draft: '',
      drafts: state.drafts.map((draft) =>
        draft.branchId === state.branchId ? { ...draft, text: '', updatedAt: occurredAt } : draft,
      ),
      activeRunId: event.runId,
      lastError: null,
      messages: [...state.messages, userMessage, assistantMessage],
      messageParts: [
        legacyTextPart(userMessage, occurredAt),
        legacyTextPart(assistantMessage, occurredAt),
      ].reduce(upsert, state.messageParts),
      turns: upsert(state.turns, turn),
      runs: upsert(state.runs, run),
    },
    { run, turn, userMessage, assistantMessage, at: occurredAt },
  )
}

function isTerminalStatus(status: import('./state.js').RunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'aborted' ||
    status === 'cancelled' ||
    status === 'blocked' ||
    status === 'expired'
  )
}
