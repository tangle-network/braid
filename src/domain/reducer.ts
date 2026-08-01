import type { AgentTaskStatus } from '@tangle-network/agent-runtime'
import type { BraidEventEnvelope } from './events.js'
import type { BraidMessage, BraidRun, BraidState, MessageStatus, RunStatus } from './state.js'

function assertNextEnvelope(state: BraidState, envelope: BraidEventEnvelope): void {
  if (envelope.sequence !== state.sequence + 1) {
    throw new Error(`Event sequence ${envelope.sequence} does not follow ${state.sequence}`)
  }
  if (envelope.revision !== state.revision + 1) {
    throw new Error(`Event revision ${envelope.revision} does not follow ${state.revision}`)
  }
}

function terminalStatus(status: AgentTaskStatus): {
  message: MessageStatus
  run: RunStatus
} {
  switch (status) {
    case 'completed':
      return { message: 'complete', run: 'completed' }
    case 'failed':
      return { message: 'failed', run: 'failed' }
    case 'aborted':
      return { message: 'aborted', run: 'aborted' }
    case 'blocked':
      return { message: 'blocked', run: 'blocked' }
    default:
      throw new Error(`Unknown terminal status: ${status}`)
  }
}

export function reduceEvent(state: BraidState, envelope: BraidEventEnvelope): BraidState {
  assertNextEnvelope(state, envelope)
  const base = { revision: envelope.revision, sequence: envelope.sequence }
  const event = envelope.event

  switch (event.kind) {
    case 'workspace.opened':
      return { ...state, ...base, workspace: event.workspace }
    case 'draft.changed':
      return { ...state, ...base, draft: event.text }
    case 'run.requested': {
      if (state.activeRunId) throw new Error(`Run ${state.activeRunId} is already active`)
      const userMessage: BraidMessage = {
        id: event.userMessageId,
        role: 'user',
        text: event.text,
        status: 'complete',
        runId: event.runId,
      }
      const assistantMessage: BraidMessage = {
        id: event.assistantMessageId,
        role: 'assistant',
        text: '',
        status: 'streaming',
        runId: event.runId,
      }
      const run: BraidRun = {
        id: event.runId,
        turnId: event.turnId,
        operationId: event.operationId,
        status: 'streaming',
        inputTokens: 0,
        outputTokens: 0,
      }
      return {
        ...state,
        ...base,
        draft: '',
        activeRunId: event.runId,
        lastError: null,
        messages: [...state.messages, userMessage, assistantMessage],
        runs: [...state.runs, run],
      }
    }
    case 'run.text.delta': {
      if (state.activeRunId !== event.runId) {
        throw new Error(`Text arrived for inactive run ${event.runId}`)
      }
      return {
        ...state,
        ...base,
        messages: state.messages.map((message) =>
          message.runId === event.runId && message.role === 'assistant'
            ? { ...message, text: message.text + event.text }
            : message,
        ),
      }
    }
    case 'run.finished': {
      const statuses = terminalStatus(event.status)
      const runExists = state.runs.some((run) => run.id === event.runId)
      if (!runExists) throw new Error(`Result arrived for unknown run ${event.runId}`)
      return {
        ...state,
        ...base,
        activeRunId: state.activeRunId === event.runId ? null : state.activeRunId,
        lastError: event.error ?? null,
        messages: state.messages.map((message) =>
          message.runId === event.runId && message.role === 'assistant'
            ? {
                ...message,
                text: event.finalText || message.text,
                status: statuses.message,
              }
            : message,
        ),
        runs: state.runs.map((run) =>
          run.id === event.runId
            ? {
                ...run,
                status: statuses.run,
                inputTokens: event.usage.input,
                outputTokens: event.usage.output,
                ...(event.usage.costUsd === undefined ? {} : { costUsd: event.usage.costUsd }),
                ...(event.usage.model === undefined ? {} : { model: event.usage.model }),
                ...(event.error === undefined ? {} : { error: event.error }),
              }
            : run,
        ),
      }
    }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

export function replayEvents(
  initial: BraidState,
  events: readonly BraidEventEnvelope[],
): BraidState {
  return events.reduce(reduceEvent, initial)
}
