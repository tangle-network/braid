import type { RunRecord, TurnRecord } from './entities.js'
import type { BraidEvent, BraidEventEnvelope } from './events.js'
import { parseMessageId, parseOperationId, parseRunId, parseTurnId } from './ids.js'
import { DomainInvariantError } from './invariants.js'
import type { BraidState } from './state.js'

import {
  dateAt,
  ensureWorkspaceGraph,
  find,
  legacyMessage,
  legacyTextPart,
  operationForRun,
  updateMessageFinal,
  updateMessageText,
  updateRun,
  upsert,
} from './reducer-helpers.js'

export function reduceLegacyEvent(
  state: BraidState,
  event: Extract<
    BraidEvent,
    {
      readonly kind:
        | 'workspace.opened'
        | 'draft.changed'
        | 'run.requested'
        | 'run.text.delta'
        | 'run.finished'
    }
  >,
  envelope: BraidEventEnvelope,
): BraidState {
  const at = dateAt(envelope)
  switch (event.kind) {
    case 'workspace.opened':
      return ensureWorkspaceGraph(state, event.workspace, at)
    case 'draft.changed':
      return {
        ...state,
        draft: event.text,
        drafts: state.drafts.map((draft) =>
          draft.branchId === state.branchId ? { ...draft, text: event.text, updatedAt: at } : draft,
        ),
      }
    case 'run.requested': {
      const runId = parseRunId(event.runId)
      const turnId = parseTurnId(event.turnId)
      const operationId = parseOperationId(event.operationId)
      const userMessageId = parseMessageId(event.userMessageId)
      const assistantMessageId = parseMessageId(event.assistantMessageId)
      if (state.activeRunId !== null)
        throw new DomainInvariantError(`Run ${state.activeRunId} is already active`)
      const userMessage = legacyMessage(
        state,
        userMessageId,
        'user',
        event.text,
        runId,
        turnId,
        'complete',
        at,
      )
      const assistantMessage = legacyMessage(
        state,
        assistantMessageId,
        'assistant',
        '',
        runId,
        turnId,
        'streaming',
        at,
      )
      const turn: TurnRecord = {
        id: turnId,
        conversationId: state.conversationId,
        branchId: state.branchId,
        userMessageId,
        runIds: [runId],
        status: 'running',
        createdAt: at,
        updatedAt: at,
      }
      const run: RunRecord = {
        id: runId,
        conversationId: state.conversationId,
        branchId: state.branchId,
        turnId,
        operationId,
        status: 'streaming',
        inputTokens: 0,
        outputTokens: 0,
        complete: false,
        startedAt: at,
        updatedAt: at,
      }
      const operation = operationForRun(state, operationId, runId, event, at)
      const messageParts = [legacyTextPart(userMessage, at), legacyTextPart(assistantMessage, at)]
      return {
        ...state,
        draft: '',
        activeRunId: runId,
        lastError: null,
        messages: upsert(upsert(state.messages, userMessage), assistantMessage),
        messageParts: messageParts.reduce(upsert, state.messageParts),
        turns: upsert(state.turns, turn),
        runs: upsert(state.runs, run),
        operations: upsert(state.operations, operation),
      }
    }
    case 'run.text.delta': {
      const runId = parseRunId(event.runId)
      if (state.activeRunId !== runId)
        throw new DomainInvariantError(`Text arrived for inactive run ${runId}`)
      return updateMessageText(state, runId, event.text, at)
    }
    case 'run.finished': {
      const runId = parseRunId(event.runId)
      const run = find(state.runs, runId, 'Run')
      const status =
        event.status === 'completed'
          ? 'completed'
          : event.status === 'failed'
            ? 'failed'
            : event.status === 'aborted'
              ? 'aborted'
              : event.status === 'unknown'
                ? 'unknown'
                : 'blocked'
      const messageStatus =
        status === 'completed'
          ? 'complete'
          : status === 'failed'
            ? 'failed'
            : status === 'aborted'
              ? 'aborted'
              : status === 'unknown'
                ? 'incomplete'
                : 'blocked'
      let next = updateRun(
        state,
        {
          ...run,
          status,
          inputTokens: event.usage.input,
          outputTokens: event.usage.output,
          ...(event.usage.costUsd === undefined ? {} : { costUsd: event.usage.costUsd }),
          ...(event.usage.model === undefined ? {} : { model: event.usage.model }),
          ...(event.error === undefined ? {} : { error: event.error }),
          complete: true,
        },
        at,
      )
      next = updateMessageFinal(next, runId, event.finalText, messageStatus, at)
      const turn = next.turns.find((entry) => entry.id === run.turnId)
      if (turn)
        next = {
          ...next,
          turns: upsert(next.turns, {
            ...turn,
            status:
              status === 'completed'
                ? 'completed'
                : status === 'aborted'
                  ? 'cancelled'
                  : status === 'failed'
                    ? 'failed'
                    : 'unknown',
            selectedRunId: runId,
            updatedAt: at,
          }),
        }
      const operation = next.operations.find((entry) => entry.id === run.operationId)
      if (operation) {
        next = {
          ...next,
          operations: upsert(next.operations, {
            ...operation,
            status:
              status === 'completed' ? 'terminal' : status === 'unknown' ? 'unknown' : 'failed',
            terminalOutcome:
              status === 'aborted' ? 'cancelled' : status === 'blocked' ? 'failed' : status,
            updatedAt: at,
          }),
        }
      }
      return { ...next, lastError: event.error ?? null }
    }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
