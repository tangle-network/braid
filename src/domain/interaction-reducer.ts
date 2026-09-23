import type {
  AutomationRuleRecord,
  InteractionEventEnvelope,
  InteractionQueueState,
  InteractionRecord,
} from './interaction-state.js'
import { eventIdentity } from './events.js'
import { canonicalDigest } from './canonical.js'
import { answerSpecContainsSecret } from './interaction.js'
import {
  interactionKey,
  initialInteractionState,
  interactionStatusIsUncertain,
} from './interaction-state.js'
import { assertResolvedInteractionEvent } from './interaction-event-validation.js'

function upsertInteraction(
  interactions: readonly InteractionRecord[],
  value: InteractionRecord,
): readonly InteractionRecord[] {
  const existing = interactions.findIndex((item) => item.key === value.key)
  if (existing < 0) return [...interactions, value]
  return interactions.map((item, index) => (index === existing ? value : item))
}

function upsertRule(
  rules: readonly AutomationRuleRecord[],
  value: AutomationRuleRecord,
): readonly AutomationRuleRecord[] {
  const existing = rules.findIndex((item) => item.id === value.id)
  if (existing < 0) return [...rules, value]
  return rules.map((item, index) => (index === existing ? value : item))
}

function queueFor(interactions: readonly InteractionRecord[]): readonly string[] {
  return interactions
    .filter((interaction) => interaction.status === 'pending')
    .sort((left, right) => left.arrivalSequence - right.arrivalSequence)
    .map((interaction) => interaction.key)
}

function assertNext(state: InteractionQueueState, envelope: InteractionEventEnvelope): void {
  if (envelope.sequence !== state.sequence + 1) {
    throw new Error(
      `Interaction event sequence ${envelope.sequence} does not follow ${state.sequence}`,
    )
  }
  if (envelope.revision !== state.revision + 1) {
    throw new Error(
      `Interaction event revision ${envelope.revision} does not follow ${state.revision}`,
    )
  }
}

export function reduceInteractionEvent(
  state: InteractionQueueState,
  envelope: InteractionEventEnvelope,
): InteractionQueueState {
  const identity = eventIdentity(envelope.event, envelope.eventId)
  if (identity && state.appliedEventIds.includes(identity)) return state
  assertNext(state, envelope)
  const base = {
    sequence: envelope.sequence,
    revision: envelope.revision,
    appliedEventIds: identity ? [...state.appliedEventIds, identity] : state.appliedEventIds,
  }
  const event = envelope.event
  switch (event.kind) {
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
      if (state.interactions.some((item) => item.key === event.interaction.key)) {
        return { ...state, ...base }
      }
      const interactions = upsertInteraction(state.interactions, event.interaction)
      return { ...state, ...base, interactions, queue: queueFor(interactions) }
    }
    case 'interaction.response.requested': {
      if (event.containsSecret && event.publicData !== undefined) {
        throw new Error('Secret interaction responses cannot contain public data')
      }
      const interaction = state.interactions.find((item) => item.key === event.key)
      if (!interaction) throw new Error(`Interaction ${event.key} is unknown`)
      if (interaction.status !== 'pending') {
        throw new Error(`Interaction ${event.key} is not pending`)
      }
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
      const next: InteractionRecord = {
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
          ...(event.profileDigest === undefined ? {} : { profileDigest: event.profileDigest }),
          ...(event.connectionId === undefined ? {} : { connectionId: event.connectionId }),
          ...(event.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
          ...(event.conversationId === undefined ? {} : { conversationId: event.conversationId }),
          ...(event.branchId === undefined ? {} : { branchId: event.branchId }),
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.runner === undefined ? {} : { runner: event.runner }),
        },
      }
      const interactions = upsertInteraction(state.interactions, next)
      return { ...state, ...base, interactions, queue: queueFor(interactions) }
    }
    case 'interaction.resolved': {
      const interaction = state.interactions.find((item) => item.key === event.key)
      if (!interaction) throw new Error(`Interaction ${event.key} is unknown`)
      assertResolvedInteractionEvent(interaction, event)
      if (event.resolution?.containsSecret && event.resolution.publicData !== undefined) {
        throw new Error('Secret interaction resolution cannot contain public data')
      }
      const next: InteractionRecord = interactionStatusIsUncertain(event.status)
        ? {
            ...interaction,
            status: event.status,
            updatedAt: envelope.occurredAt,
            ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
          }
        : (() => {
            const { pendingResponse: _pendingResponse, ...withoutPendingResponse } = interaction
            return {
              ...withoutPendingResponse,
              status: event.status,
              updatedAt: envelope.occurredAt,
              ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
            }
          })()
      const interactions = upsertInteraction(state.interactions, next)
      return { ...state, ...base, interactions, queue: queueFor(interactions) }
    }
    case 'automation.rule.created': {
      return { ...state, ...base, rules: upsertRule(state.rules, event.rule) }
    }
    case 'automation.rule.updated': {
      return { ...state, ...base, rules: upsertRule(state.rules, event.rule) }
    }
    case 'automation.rule.disabled': {
      const rules = state.rules.map((rule) =>
        rule.id === event.ruleId ? { ...rule, enabled: false } : rule,
      )
      return { ...state, ...base, rules }
    }
    case 'automation.rule.deleted':
      return { ...state, ...base, rules: state.rules.filter((rule) => rule.id !== event.ruleId) }
    case 'automation.command.recorded':
      return { ...state, ...base }
    case 'automation.rule.used': {
      const rules = state.rules.map((rule) =>
        rule.id === event.ruleId ? { ...rule, uses: rule.uses + 1 } : rule,
      )
      return { ...state, ...base, rules }
    }
    case 'automation.rule.applied': {
      if (event.audit.ruleId !== event.ruleId || event.audit.outcome !== 'applied') {
        throw new Error('Automation applied event identity does not match its audit')
      }
      const rules = state.rules.map((rule) =>
        rule.id === event.ruleId ? { ...rule, uses: rule.uses + 1 } : rule,
      )
      return { ...state, ...base, rules, audits: [...state.audits, event.audit] }
    }
    case 'automation.audit.recorded':
      return { ...state, ...base, audits: [...state.audits, event.audit] }
    case 'feedback.decision.recorded':
      return { ...state, ...base, feedbackDecisions: [...state.feedbackDecisions, event.decision] }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

export function replayInteractionEvents(
  events: readonly InteractionEventEnvelope[],
): InteractionQueueState {
  return events.reduce(reduceInteractionEvent, initialInteractionState())
}
