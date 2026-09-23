import type { AgentTaskStatus } from '@tangle-network/agent-runtime'
import { eventIdentity, type BraidEventEnvelope } from './events.js'
import type { BraidMessage, BraidRun, BraidState, MessageStatus, RunStatus } from './state.js'
import { answerSpecContainsSecret } from './interaction.js'
import { appendUtf8Bounded, boundedText, redactSensitiveText } from './bounds.js'
import { canonicalDigest } from './canonical.js'
import { interactionKey, interactionStatusIsUncertain } from './interaction-state.js'
import { assertResolvedInteractionEvent } from './interaction-event-validation.js'

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
  const identity = eventIdentity(envelope.event, envelope.eventId)
  if (identity !== undefined && state.appliedEventIds.includes(identity)) return state
  assertNextEnvelope(state, envelope)
  const base = {
    revision: envelope.revision,
    sequence: envelope.sequence,
    appliedEventIds:
      identity === undefined ? state.appliedEventIds : [...state.appliedEventIds, identity],
  }
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
        ...(event.requestDigest === undefined ? {} : { requestDigest: event.requestDigest }),
        ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
        ...(event.conversationId === undefined ? {} : { conversationId: event.conversationId }),
        ...(event.branchId === undefined ? {} : { branchId: event.branchId }),
        ...(event.model === undefined ? {} : { model: event.model }),
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
            ? { ...message, text: appendUtf8Bounded(message.text, event.text) }
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
        lastError: event.error === undefined ? null : redactSensitiveText(event.error),
        messages: state.messages.map((message) =>
          message.runId === event.runId && message.role === 'assistant'
            ? {
                ...message,
                text: event.finalText ? boundedText(event.finalText) : message.text,
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
                ...(event.error === undefined ? {} : { error: redactSensitiveText(event.error) }),
              }
            : run,
        ),
      }
    }
    case 'run.session.bound':
      return {
        ...state,
        ...base,
        runs: state.runs.map((run) =>
          run.id === event.runId ? { ...run, providerSessionId: event.providerSessionId } : run,
        ),
      }
    case 'interaction.requested': {
      if (
        event.interaction.key !==
        interactionKey(event.interaction.runId, event.interaction.interactionId)
      ) {
        throw new Error('Interaction key does not match its typed identity')
      }
      if (
        answerSpecContainsSecret(event.interaction.request.answerSpec) &&
        event.interaction.request.default?.data !== undefined
      ) {
        throw new Error('Secret interaction requests cannot contain default answer data')
      }
      if (state.interactions.some((interaction) => interaction.key === event.interaction.key)) {
        return { ...state, ...base }
      }
      return {
        ...state,
        ...base,
        interactions: [...state.interactions, event.interaction],
      }
    }
    case 'interaction.response.requested': {
      if (event.containsSecret && event.publicData !== undefined) {
        throw new Error('Secret interaction responses cannot contain public data')
      }
      const interaction = state.interactions.find((item) => item.key === event.key)
      if (!interaction) throw new Error(`Interaction ${event.key} is unknown`)
      const requestDigest = interaction.requestDigest ?? canonicalDigest(interaction.request)
      if (
        interaction.runId !== event.runId ||
        interaction.interactionId !== event.interactionId ||
        event.requestDigest !== requestDigest ||
        interaction.requestRevision !== event.requestRevision ||
        (interaction.providerSessionId ?? undefined) !== (event.providerSessionId ?? undefined) ||
        (interaction.profileDigest ?? undefined) !== (event.profileDigest ?? undefined) ||
        (interaction.connectionId ?? undefined) !== (event.connectionId ?? undefined) ||
        (interaction.workspaceId ?? undefined) !== (event.workspaceId ?? undefined) ||
        (interaction.conversationId ?? undefined) !== (event.conversationId ?? undefined) ||
        (interaction.branchId ?? undefined) !== (event.branchId ?? undefined) ||
        (interaction.model ?? undefined) !== (event.model ?? undefined) ||
        (interaction.runner ?? undefined) !== (event.runner ?? undefined)
      ) {
        throw new Error('Interaction response identity does not match the request')
      }
      return {
        ...state,
        ...base,
        interactions: state.interactions.map((interaction) =>
          interaction.key === event.key
            ? {
                ...interaction,
                status: 'responding',
                updatedAt: envelope.occurredAt,
                pendingResponse: {
                  operationId: event.operationId,
                  outcome: event.outcome,
                  requestDigest,
                  responseDigest:
                    event.responseDigest ??
                    event.dataDigest ??
                    canonicalDigest({ outcome: event.outcome, data: event.publicData ?? {} }),
                  ...(event.requestRevision === undefined
                    ? {}
                    : { requestRevision: event.requestRevision }),
                  ...(event.providerSessionId === undefined
                    ? {}
                    : { providerSessionId: event.providerSessionId }),
                  ...(event.profileDigest === undefined
                    ? {}
                    : { profileDigest: event.profileDigest }),
                  ...(event.connectionId === undefined ? {} : { connectionId: event.connectionId }),
                  ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
                  ...(event.conversationId === undefined
                    ? {}
                    : { conversationId: event.conversationId }),
                  ...(event.branchId === undefined ? {} : { branchId: event.branchId }),
                  ...(event.model === undefined ? {} : { model: event.model }),
                  ...(event.runner === undefined ? {} : { runner: event.runner }),
                },
              }
            : interaction,
        ),
      }
    }
    case 'interaction.resolved': {
      if (event.resolution?.containsSecret && event.resolution.publicData !== undefined) {
        throw new Error('Secret interaction resolution cannot contain public data')
      }
      const interaction = state.interactions.find((item) => item.key === event.key)
      if (!interaction) throw new Error(`Interaction ${event.key} is unknown`)
      assertResolvedInteractionEvent(interaction, event)
      return {
        ...state,
        ...base,
        interactions: state.interactions.map((interaction) => {
          if (interaction.key !== event.key) return interaction
          if (interactionStatusIsUncertain(event.status)) {
            return {
              ...interaction,
              status: event.status,
              updatedAt: envelope.occurredAt,
              ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
            }
          }
          const { pendingResponse: _pendingResponse, ...withoutPendingResponse } = interaction
          return {
            ...withoutPendingResponse,
            status: event.status,
            updatedAt: envelope.occurredAt,
            ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
          }
        }),
      }
    }
    case 'automation.rule.created':
      return { ...state, ...base, rules: [...state.rules, event.rule] }
    case 'automation.rule.updated':
      return {
        ...state,
        ...base,
        rules: state.rules.some((rule) => rule.id === event.rule.id)
          ? state.rules.map((rule) => (rule.id === event.rule.id ? event.rule : rule))
          : [...state.rules, event.rule],
      }
    case 'automation.rule.disabled':
      return {
        ...state,
        ...base,
        rules: state.rules.map((rule) =>
          rule.id === event.ruleId ? { ...rule, enabled: false } : rule,
        ),
      }
    case 'automation.rule.deleted':
      return { ...state, ...base, rules: state.rules.filter((rule) => rule.id !== event.ruleId) }
    case 'automation.command.recorded':
      return { ...state, ...base }
    case 'automation.rule.used':
      return {
        ...state,
        ...base,
        rules: state.rules.map((rule) =>
          rule.id === event.ruleId ? { ...rule, uses: rule.uses + 1 } : rule,
        ),
      }
    case 'automation.rule.applied':
      if (event.audit.ruleId !== event.ruleId || event.audit.outcome !== 'applied') {
        throw new Error('Automation applied event identity does not match its audit')
      }
      return {
        ...state,
        ...base,
        rules: state.rules.map((rule) =>
          rule.id === event.ruleId ? { ...rule, uses: rule.uses + 1 } : rule,
        ),
        automationAudits: [...state.automationAudits, event.audit],
      }
    case 'automation.audit.recorded':
      return { ...state, ...base, automationAudits: [...state.automationAudits, event.audit] }
    case 'feedback.decision.recorded':
      return { ...state, ...base, feedbackDecisions: [...state.feedbackDecisions, event.decision] }
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
