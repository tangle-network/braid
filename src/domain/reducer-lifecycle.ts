import type { RunRecord, TurnRecord } from './entities.js'
import type { BraidEvent } from './events.js'
import {
  parseBranchId,
  parseConversationId,
  parseDigestValue,
  parseMessageId,
  parseOperationId,
  parseRunId,
  parseTurnId,
} from './ids.js'
import { createAdmissionReceipt } from './receipts.js'
import { legacyMessage, legacyTextPart, upsert } from './reducer-helpers.js'
import { attachRequestedRunToConversation } from './reducer-run-graph.js'
import {
  activity,
  addActivity,
  findRun,
  isCancellationConfirmedReconciliation,
  type ReducerBase,
  TERMINAL_RUN_STATES,
  terminalMessageStatus,
  terminalPartStatus,
  updateMessage,
  updateRun,
  upsertPart,
} from './reducer-support.js'
import { LEGACY_RUN_CAPABILITIES } from './runtime-projection.js'
import { activeRunForBranch, type BraidState } from './state.js'

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
    case 'run.control.requested': {
      const runId = parseRunId(event.runId)
      findRun(state, runId)
      const operationId = parseOperationId(event.operationId)
      const existing = state.operations.find((operation) => operation.id === operationId)
      const operation =
        existing ??
        ({
          id: operationId,
          kind: event.control === 'cancel' ? 'cancel-run' : 'custom',
          requestDigest: parseDigestValue(event.digest),
          status: 'pending',
          target: { kind: 'run', id: runId },
          createdAt: occurredAt,
          updatedAt: occurredAt,
        } as const)
      return {
        ...state,
        ...base,
        operations: upsert(state.operations, operation),
        runs: updateRun(state, event.runId, (candidate) =>
          addActivity(
            {
              ...candidate,
              status:
                event.control === 'cancel' && !TERMINAL_RUN_STATES.includes(candidate.status)
                  ? 'cancelling'
                  : candidate.status,
            },
            activity(event, 'control', event.control, event.text ?? event.reason),
          ),
        ),
      }
    }
    case 'run.control.acknowledged': {
      findRun(state, event.runId)
      const operationId = parseOperationId(event.operationId)
      const operation = state.operations.find((candidate) => candidate.id === operationId)
      const status =
        event.outcome === 'accepted'
          ? 'acknowledged'
          : event.outcome === 'already-applied'
            ? 'terminal'
            : event.outcome === 'rejected'
              ? 'failed'
              : 'unknown'
      return {
        ...state,
        ...base,
        ...(operation === undefined
          ? {}
          : {
              operations: upsert(state.operations, {
                ...operation,
                status,
                result: {
                  control: event.control,
                  outcome: event.outcome,
                  ...(event.detail === undefined ? {} : { detail: event.detail }),
                },
                updatedAt: occurredAt,
                ...(event.outcome === 'accepted' || event.outcome === 'already-applied'
                  ? { acknowledgedAt: occurredAt }
                  : {}),
              }),
            }),
        runs: updateRun(state, event.runId, (run) =>
          addActivity(run, activity(event, 'control.ack', event.control, event.outcome)),
        ),
      }
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
            ...(event.conversationId === undefined ? {} : { conversationId: event.conversationId }),
            ...(event.branchId === undefined ? {} : { branchId: event.branchId }),
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
        focusedRunId: event.runId,
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
      const correction = isCancellationConfirmedReconciliation(event, state, current.status)
      if (event.correction !== undefined && !correction)
        throw new Error(`Run ${event.runId} has invalid cancellation reconciliation evidence`)
      if (
        ['completed', 'failed', 'aborted', 'cancelled', 'blocked', 'expired'].includes(
          current.status,
        ) &&
        !correction
      )
        throw new Error(`Run ${event.runId} cannot be reconciled after a proven terminal state`)
      const from = event.from ?? current.status
      const to = event.to ?? event.status
      if (correction && (to === 'cancelled' || to === 'aborted')) {
        const hasMissingHistory = state.missingHistory.some((range) => range.runId === event.runId)
        const messageStatus = hasMissingHistory ? 'incomplete' : terminalMessageStatus(to)
        return {
          ...state,
          ...base,
          lastError: null,
          messages: updateMessage(state, event.runId, (message) => ({
            ...message,
            status: messageStatus,
            complete: !hasMissingHistory,
            parts: message.parts.map((part) =>
              part.status === 'running' ? { ...part, status: terminalPartStatus(to) } : part,
            ),
          })),
          runs: updateRun(state, event.runId, (run) => {
            const { error: _error, terminalReason: _terminalReason, ...withoutFailure } = run
            return addActivity(
              {
                ...withoutFailure,
                status: to,
                ...(event.detail === undefined ? {} : { terminalReason: event.detail }),
                complete: !hasMissingHistory,
              },
              activity(event, 'reconciliation', `${from} → ${to}`, event.detail),
            )
          }),
        }
      }
      return {
        ...state,
        ...base,
        ...(isTerminalStatus(to) ? {} : { focusedRunId: event.runId }),
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
        messages: state.messages.map((message) =>
          message.runId === event.runId && message.role === 'assistant'
            ? {
                ...withPendingText(message, event.runId, event.pendingText),
                status: 'incomplete',
                complete: false,
              }
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

function withPendingText(
  message: import('./state.js').BraidMessage,
  runId: string,
  pendingText: string | undefined,
): import('./state.js').BraidMessage {
  if (pendingText === undefined || pendingText.length === 0) return message
  const textPart = message.parts.find((part) => part.kind === 'text')
  return upsertPart(message, {
    id: textPart?.id ?? `${runId}:text`,
    kind: 'text',
    text: `${message.text}${pendingText}`,
  })
}

function reduceRequestedRun(
  state: BraidState,
  event: Extract<BraidEvent, { kind: 'run.requested' }>,
  base: ReducerBase,
  occurredAt: string,
): BraidState {
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
  const conversationId = parseConversationId(receipt.conversationId)
  const branchId = parseBranchId(receipt.branchId)
  const existing = activeRunForBranch(state, conversationId, branchId)
  if (existing) throw new Error(`Run ${existing.id} is already active on branch ${branchId}`)
  const userMessage = legacyMessage(
    state,
    userMessageId,
    'user',
    event.text,
    runId,
    turnId,
    'complete',
    occurredAt,
    { conversationId, branchId },
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
      { conversationId, branchId },
    ),
    parts: [],
  }
  const turn: TurnRecord = {
    id: turnId,
    conversationId,
    branchId,
    userMessageId,
    runIds: [runId],
    status: 'running',
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
  const connectionId = state.connections.find(
    (connection) => connection.id === receipt.requested.connectionId,
  )?.id
  const environmentId = state.environments.find(
    (environment) => environment.id === receipt.environmentId,
  )?.id
  const run: RunRecord = {
    id: runId,
    conversationId,
    branchId,
    turnId,
    operationId: event.operationId,
    status: 'streaming' as const,
    receipt,
    capabilities: receipt.capabilities,
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(environmentId === undefined ? {} : { environmentId }),
    ...(receipt.requested.model === undefined ? {} : { model: receipt.requested.model }),
    ...(receipt.providerSessionId === undefined
      ? {}
      : { providerSessionId: receipt.providerSessionId }),
    inputTokens: 0,
    outputTokens: 0,
    tokensKnown: false,
    usdKnown: false,
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
      draft: state.branchId === branchId ? '' : state.draft,
      drafts: state.drafts.map((draft) =>
        draft.branchId === branchId ? { ...draft, text: '', updatedAt: occurredAt } : draft,
      ),
      focusedRunId: event.runId,
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
    status === 'expired' ||
    status === 'unknown'
  )
}
