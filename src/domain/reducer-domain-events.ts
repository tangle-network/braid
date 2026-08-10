import { connectionRemovalBlockers } from './connection-removal.js'
import type { BraidEvent, DomainBraidEventMap } from './events.js'
import { DomainInvariantError } from './invariants.js'
import { applyConversationEvent } from './reducer-conversation-events.js'
import { applyExecutionObservation } from './reducer-execution-observation.js'

import { find, updateRun, upsert, upsertBy } from './reducer-helpers.js'
import { isCancellationConfirmedReconciliation } from './reducer-support.js'
import type { BraidState } from './state.js'

export function applyDomainEvent(
  state: BraidState,
  event: Extract<BraidEvent, { readonly kind: keyof DomainBraidEventMap }>,
  at: string,
): BraidState {
  switch (event.kind) {
    case 'workspace.recorded':
      return {
        ...state,
        workspace: event.workspace.root,
        workspaceId: event.workspace.id,
        workspaces: upsert(state.workspaces, event.workspace),
      }
    case 'profile.registered':
      return { ...state, profiles: upsert(state.profiles, event.profile) }
    case 'profile.selected': {
      const profile = find(state.profiles, event.profileId, 'Profile')
      return { ...state, selectedProfileId: event.profileId, profile: profile.profile }
    }
    case 'profile.snapshot.created':
      return { ...state, profileSnapshots: upsert(state.profileSnapshots, event.snapshot) }
    case 'credential.reference.created':
      return { ...state, credentials: upsert(state.credentials, event.credential) }
    case 'connection.upserted':
      return { ...state, connections: upsert(state.connections, event.connection) }
    case 'connection.selected':
      find(state.connections, event.connectionId, 'Connection')
      return { ...state, selectedConnectionId: event.connectionId }
    case 'connection.removed': {
      const connection = find(state.connections, event.connectionId, 'Connection')
      if (
        event.operation.status !== 'acknowledged' ||
        event.operation.target?.kind !== 'connection' ||
        event.operation.target.id !== connection.id
      ) {
        throw new DomainInvariantError(
          `Connection removal operation ${event.operation.id} does not acknowledge ${connection.id}`,
        )
      }
      const blockers = connectionRemovalBlockers(state, connection.id)
      if (blockers.length > 0) {
        throw new DomainInvariantError(
          `Connection ${connection.id} cannot be removed while ${blockers
            .map((blocker) => `${blocker.kind} ${blocker.id}`)
            .join(', ')} remains`,
        )
      }
      return {
        ...state,
        connections: state.connections.filter((candidate) => candidate.id !== connection.id),
        operations: upsert(state.operations, event.operation),
      }
    }
    case 'conversation.created':
    case 'conversation.imported':
    case 'conversation.updated':
    case 'conversation.selected':
    case 'conversation.deleted':
    case 'branch.created':
    case 'branch.updated':
    case 'branch.selected':
      return applyConversationEvent(state, event)
    case 'turn.created':
      return { ...state, turns: upsert(state.turns, event.turn) }
    case 'turn.updated':
      return { ...state, turns: upsert(state.turns, event.turn) }
    case 'message.created':
      return { ...state, messages: upsert(state.messages, event.message) }
    case 'message.part.updated': {
      const message = find(state.messages, event.part.messageId, 'Message')
      const partIds = message.partIds.includes(event.part.id)
        ? message.partIds
        : [...message.partIds, event.part.id]
      const text = event.part.kind === 'text' ? event.part.text : message.text
      return {
        ...state,
        messages: upsert(state.messages, { ...message, partIds, text, updatedAt: at }),
        messageParts: upsert(state.messageParts, event.part),
      }
    }
    case 'run.bound': {
      const run = find(state.runs, event.runId, 'Run')
      return {
        ...state,
        runs: upsert(state.runs, { ...run, bindingId: event.bindingId, updatedAt: at }),
      }
    }
    case 'run.status.changed': {
      const run = find(state.runs, event.runId, 'Run')
      return updateRun(
        state,
        {
          ...run,
          status: event.status,
          ...(event.error === undefined ? {} : { error: event.error }),
        },
        at,
      )
    }
    case 'run.reconciled': {
      const run = find(state.runs, event.runId, 'Run')
      const correction = isCancellationConfirmedReconciliation(event, state, run.status)
      if (event.correction !== undefined && !correction)
        throw new DomainInvariantError(
          `Run ${run.id} has invalid cancellation reconciliation evidence`,
        )
      if (run.status !== 'unknown' && !correction)
        throw new DomainInvariantError(`Run ${run.id} is not awaiting reconciliation`)
      return updateRun(state, { ...run, status: event.to ?? event.status }, at)
    }
    case 'run.environment.observed':
      return applyExecutionObservation(state, event, at)
    case 'history.missing': {
      const run = find(state.runs, event.range.runId, 'Run')
      const messages = state.messages.map((message) =>
        message.runId === run.id
          ? {
              ...message,
              complete: false,
              status: 'incomplete' as const,
              missingHistory: event.range,
            }
          : message,
      )
      return {
        ...state,
        runs: upsert(state.runs, { ...run, complete: false, updatedAt: at }),
        messages,
        missingHistory: [...state.missingHistory, event.range],
      }
    }
    case 'interaction.requested':
      return { ...state, interactions: upsert(state.interactions, event.interaction) }
    case 'interaction.response.requested': {
      const interaction = find(state.interactions, event.response.interactionId, 'Interaction')
      if (interaction.status !== 'pending' && interaction.status !== 'responding')
        throw new DomainInvariantError(`Interaction ${interaction.id} is not pending`)
      return {
        ...state,
        interactions: upsert(state.interactions, {
          ...interaction,
          status: 'responding',
          updatedAt: at,
        }),
      }
    }
    case 'interaction.resolved': {
      const interaction = find(state.interactions, event.interactionId, 'Interaction')
      if (event.resolution === undefined)
        throw new DomainInvariantError(`Interaction ${interaction.id} has no resolution`)
      const status = event.resolution.outcome === 'accepted' ? 'resolved' : event.resolution.outcome
      return {
        ...state,
        interactions: upsert(state.interactions, {
          ...interaction,
          resolution: event.resolution,
          status,
          updatedAt: at,
        }),
      }
    }
    case 'interaction.cancelled': {
      const interaction = find(state.interactions, event.interactionId, 'Interaction')
      return {
        ...state,
        interactions: upsert(state.interactions, {
          ...interaction,
          status: 'cancelled',
          updatedAt: at,
        }),
      }
    }
    case 'interaction.expired': {
      const interaction = find(state.interactions, event.interactionId, 'Interaction')
      return {
        ...state,
        interactions: upsert(state.interactions, {
          ...interaction,
          status: 'expired',
          updatedAt: at,
        }),
      }
    }
    case 'analysis.created':
    case 'analysis.updated':
    case 'analysis.completed':
      return { ...state, analyses: upsert(state.analyses, event.analysis) }
    case 'analysis.attachment.created':
      return {
        ...state,
        analysisAttachments: upsert(state.analysisAttachments, event.attachment),
      }
    case 'environment.upserted':
      return { ...state, environments: upsert(state.environments, event.environment) }
    case 'checkpoint.upserted':
      return { ...state, checkpoints: upsert(state.checkpoints, event.checkpoint) }
    case 'supervisor.upserted':
      return { ...state, supervisors: upsert(state.supervisors, event.supervisor) }
    case 'worker.upserted':
      return { ...state, workers: upsert(state.workers, event.worker) }
    case 'draft.recorded':
      return {
        ...state,
        drafts: upsert(state.drafts, event.draft),
        draft: event.draft.branchId === state.branchId ? event.draft.text : state.draft,
        ...(event.operation === undefined
          ? {}
          : { operations: upsert(state.operations, event.operation) }),
      }
    case 'queue.upserted':
      return { ...state, queues: upsert(state.queues, event.queue) }
    case 'queue.entry.upserted': {
      const queue = find(state.queues, event.entry.queueId, 'Queue')
      const entryIds = queue.entryIds.includes(event.entry.id)
        ? queue.entryIds
        : [...queue.entryIds, event.entry.id]
      return {
        ...state,
        queues: upsert(state.queues, { ...queue, entryIds, updatedAt: at }),
        queueEntries: upsert(state.queueEntries, event.entry),
      }
    }
    case 'rule.upserted':
      return {
        ...state,
        rules: upsert(state.rules, event.rule),
        ...(event.operation === undefined
          ? {}
          : { operations: upsert(state.operations, event.operation) }),
      }
    case 'rule.deleted':
      return {
        ...state,
        rules: state.rules.filter((rule) => rule.id !== event.ruleId),
        operations: upsert(state.operations, event.operation),
      }
    case 'interaction.automation.audited':
      return state
    case 'binding.upserted':
      return { ...state, bindings: upsert(state.bindings, event.binding) }
    case 'graph.node.upserted':
      return { ...state, graphNodes: upsert(state.graphNodes, event.node) }
    case 'graph.edge.upserted':
      return { ...state, graphEdges: upsert(state.graphEdges, event.edge) }
    case 'operation.requested':
    case 'operation.updated':
      return { ...state, operations: upsert(state.operations, event.operation) }
    case 'effect.upserted':
      return { ...state, effects: upsert(state.effects, event.effect) }
    case 'feedback.decision.recorded':
      return { ...state, feedbackDecisions: upsert(state.feedbackDecisions, event.decision) }
    case 'content.unavailable':
      return state
    case 'replay.cursor.advanced': {
      const run = find(state.runs, event.runId, 'Run')
      const cursor = {
        runId: event.runId,
        cursor: event.cursor,
        committedSequence: state.sequence + 1,
      }
      return {
        ...state,
        replayCursors: upsertBy(state.replayCursors, (entry) => entry.runId, cursor),
        runs: upsert(state.runs, { ...run, replayCursor: event.cursor, updatedAt: at }),
      }
    }
    case 'unknown.event':
      return { ...state, unknownEvents: upsert(state.unknownEvents, event.unknown) }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}
