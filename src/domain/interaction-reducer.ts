import type {
  AutomationRuleRecord,
  InteractionEventEnvelope,
  InteractionQueueState,
  InteractionRecord,
} from './interaction-state.js'
import { answerSpecContainsSecret } from './interaction.js'
import { initialInteractionState } from './interaction-state.js'

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
  if (envelope.eventId && state.appliedEventIds.includes(envelope.eventId)) return state
  assertNext(state, envelope)
  const base = {
    sequence: envelope.sequence,
    revision: envelope.revision,
    appliedEventIds: envelope.eventId
      ? [...state.appliedEventIds, envelope.eventId]
      : state.appliedEventIds,
  }
  const event = envelope.event
  switch (event.kind) {
    case 'interaction.requested': {
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
      const next: InteractionRecord = {
        ...interaction,
        status: 'responding',
        updatedAt: envelope.occurredAt,
      }
      const interactions = upsertInteraction(state.interactions, next)
      return { ...state, ...base, interactions, queue: queueFor(interactions) }
    }
    case 'interaction.resolved': {
      const interaction = state.interactions.find((item) => item.key === event.key)
      if (!interaction) throw new Error(`Interaction ${event.key} is unknown`)
      if (event.resolution?.containsSecret && event.resolution.publicData !== undefined) {
        throw new Error('Secret interaction resolution cannot contain public data')
      }
      const next: InteractionRecord = {
        ...interaction,
        status: event.status,
        updatedAt: envelope.occurredAt,
        ...(event.resolution === undefined ? {} : { resolution: event.resolution }),
      }
      const interactions = upsertInteraction(state.interactions, next)
      return { ...state, ...base, interactions, queue: queueFor(interactions) }
    }
    case 'automation.rule.created': {
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
    case 'automation.rule.used': {
      const rules = state.rules.map((rule) =>
        rule.id === event.ruleId ? { ...rule, uses: rule.uses + 1 } : rule,
      )
      return { ...state, ...base, rules }
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
