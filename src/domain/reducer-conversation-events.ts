import type { BraidEvent } from './events.js'
import { find, upsert } from './reducer-helpers.js'
import type { BraidState } from './state.js'

type ConversationEvent = Extract<
  BraidEvent,
  {
    readonly kind:
      | 'conversation.created'
      | 'conversation.imported'
      | 'conversation.updated'
      | 'conversation.selected'
      | 'conversation.deleted'
      | 'branch.created'
      | 'branch.updated'
      | 'branch.selected'
  }
>

export function applyConversationEvent(state: BraidState, event: ConversationEvent): BraidState {
  switch (event.kind) {
    case 'conversation.created':
      return {
        ...state,
        conversationId: event.conversation.id,
        branchId: event.conversation.activeBranchId,
        conversations: upsert(state.conversations, event.conversation),
        ...(event.branch === undefined ? {} : { branches: upsert(state.branches, event.branch) }),
        ...(event.draft === undefined ? {} : { drafts: upsert(state.drafts, event.draft) }),
        ...(event.queue === undefined ? {} : { queues: upsert(state.queues, event.queue) }),
        graphNodes: upsertMany(state.graphNodes, event.graphNodes),
        graphEdges: upsertMany(state.graphEdges, event.graphEdges),
        ...(event.operation === undefined
          ? {}
          : { operations: upsert(state.operations, event.operation) }),
        draft: event.draft?.text ?? '',
      }
    case 'conversation.imported':
      return {
        ...state,
        conversationId: event.conversation.id,
        branchId: event.conversation.activeBranchId,
        conversations: upsert(state.conversations, event.conversation),
        branches: upsertMany(state.branches, event.branches),
        drafts: upsertMany(state.drafts, event.drafts),
        queues: upsertMany(state.queues, event.queues),
        messages: upsertMany(state.messages, event.messages),
        messageParts: upsertMany(state.messageParts, event.messageParts),
        turns: upsertMany(state.turns, event.turns),
        runs: upsertMany(state.runs, event.runs),
        analyses: upsertMany(state.analyses, event.analyses),
        graphNodes: upsertMany(state.graphNodes, event.graphNodes),
        graphEdges: upsertMany(state.graphEdges, event.graphEdges),
        feedbackDecisions: upsertMany(state.feedbackDecisions, event.feedbackDecisions),
        operations: upsert(state.operations, event.operation),
        activeRunId: null,
        queuedInputs: [],
        draft:
          event.drafts.find((draft) => draft.branchId === event.conversation.activeBranchId)
            ?.text ?? '',
      }
    case 'conversation.updated':
      return {
        ...state,
        conversations: upsert(state.conversations, event.conversation),
        ...(event.operation === undefined
          ? {}
          : { operations: upsert(state.operations, event.operation) }),
      }
    case 'conversation.selected': {
      const previous = find(state.conversations, event.conversationId, 'Conversation')
      const conversation = event.conversation ?? previous
      const branchId = event.branchId ?? conversation.activeBranchId
      find(state.branches, branchId, 'Branch')
      return {
        ...state,
        conversationId: event.conversationId,
        branchId,
        conversations: upsert(state.conversations, conversation),
        draft: state.drafts.find((draft) => draft.branchId === branchId)?.text ?? '',
        ...(event.operation === undefined
          ? {}
          : { operations: upsert(state.operations, event.operation) }),
      }
    }
    case 'conversation.deleted':
      return applyConversationDeletion(state, event)
    case 'branch.created':
      return {
        ...state,
        branchId: event.branch.id,
        conversationId: event.branch.conversationId,
        branches: upsert(state.branches, event.branch),
        ...(event.conversation === undefined
          ? {}
          : { conversations: upsert(state.conversations, event.conversation) }),
        ...(event.draft === undefined ? {} : { drafts: upsert(state.drafts, event.draft) }),
        ...(event.queue === undefined ? {} : { queues: upsert(state.queues, event.queue) }),
        graphNodes: upsertMany(state.graphNodes, event.graphNodes),
        graphEdges: upsertMany(state.graphEdges, event.graphEdges),
        ...(event.operation === undefined
          ? {}
          : { operations: upsert(state.operations, event.operation) }),
        draft: event.draft?.text ?? '',
      }
    case 'branch.updated':
      return { ...state, branches: upsert(state.branches, event.branch) }
    case 'branch.selected':
      find(state.branches, event.branchId, 'Branch')
      return {
        ...state,
        conversationId: event.conversationId,
        branchId: event.branchId,
        draft: state.drafts.find((draft) => draft.branchId === event.branchId)?.text ?? '',
        ...(event.operation === undefined
          ? {}
          : { operations: upsert(state.operations, event.operation) }),
      }
  }
}

function applyConversationDeletion(
  state: BraidState,
  event: Extract<ConversationEvent, { readonly kind: 'conversation.deleted' }>,
): BraidState {
  const conversationId = event.conversation.id
  const branchIds = new Set(
    state.branches
      .filter((branch) => branch.conversationId === conversationId)
      .map((branch) => branch.id),
  )
  const turnIds = new Set(
    state.turns.filter((turn) => turn.conversationId === conversationId).map((turn) => turn.id),
  )
  const runIds = new Set(
    state.runs.filter((run) => run.conversationId === conversationId).map((run) => run.id),
  )
  const messageIds = new Set(
    state.messages
      .filter((message) => message.conversationId === conversationId)
      .map((message) => message.id),
  )
  const analysisIds = new Set(
    state.analyses
      .filter((analysis) => analysis.source.conversationId === conversationId)
      .map((analysis) => analysis.id),
  )
  const analysisAttachmentIds = new Set(
    state.analysisAttachments
      .filter(
        (attachment) =>
          attachment.sourceConversationId === conversationId ||
          attachment.destinationConversationId === conversationId,
      )
      .map((attachment) => attachment.id),
  )
  const queueIds = new Set(
    state.queues.filter((queue) => branchIds.has(queue.branchId)).map((queue) => queue.id),
  )
  const removedNodeIds = new Set(
    state.graphNodes
      .filter((node) =>
        node.reference.kind === 'conversation'
          ? node.reference.id === conversationId
          : node.reference.kind === 'branch'
            ? branchIds.has(node.reference.id)
            : node.reference.kind === 'turn'
              ? turnIds.has(node.reference.id)
              : node.reference.kind === 'run'
                ? runIds.has(node.reference.id)
                : node.reference.kind === 'message'
                  ? messageIds.has(node.reference.id)
                  : node.reference.kind === 'analysis'
                    ? analysisIds.has(node.reference.id)
                    : false,
      )
      .map((node) => node.id),
  )
  const removedOperationIds = new Set(
    state.operations
      .filter((operation) =>
        operation.target?.kind === 'conversation'
          ? operation.target.id === conversationId
          : operation.target?.kind === 'branch'
            ? branchIds.has(operation.target.id)
            : operation.target?.kind === 'run'
              ? runIds.has(operation.target.id)
              : operation.target?.kind === 'analysis'
                ? analysisIds.has(operation.target.id)
                : false,
      )
      .map((operation) => operation.id),
  )
  const graphNodes = upsertMany(
    state.graphNodes.filter((node) => !removedNodeIds.has(node.id)),
    event.graphNodes,
  )
  const graphNodeIds = new Set(graphNodes.map((node) => node.id))
  return {
    ...state,
    conversationId: event.selectedConversation.id,
    branchId: event.selectedConversation.activeBranchId,
    conversations: upsert(
      upsert(
        state.conversations.filter(
          (conversation) => conversation.id !== event.selectedConversation.id,
        ),
        event.conversation,
      ),
      event.selectedConversation,
    ),
    branches: upsertOptional(
      state.branches.filter((branch) => !branchIds.has(branch.id)),
      event.replacementBranch,
    ),
    turns: state.turns.filter((turn) => !turnIds.has(turn.id)),
    messages: state.messages.filter((message) => !messageIds.has(message.id)),
    messageParts: state.messageParts.filter((part) => !messageIds.has(part.messageId)),
    runs: state.runs.filter((run) => !runIds.has(run.id)),
    interactions: state.interactions.filter((interaction) => !runIds.has(interaction.runId)),
    analyses: state.analyses.filter((analysis) => !analysisIds.has(analysis.id)),
    analysisAttachments: state.analysisAttachments.filter(
      (attachment) => !analysisAttachmentIds.has(attachment.id),
    ),
    drafts: upsertOptional(
      state.drafts.filter((draft) => !branchIds.has(draft.branchId)),
      event.replacementDraft,
    ),
    queues: upsertOptional(
      state.queues.filter((queue) => !branchIds.has(queue.branchId)),
      event.replacementQueue,
    ),
    queueEntries: state.queueEntries.filter((entry) => !queueIds.has(entry.queueId)),
    bindings: state.bindings.filter(
      (binding) =>
        (binding.runId === undefined || !runIds.has(binding.runId)) &&
        (binding.branchId === undefined || !branchIds.has(binding.branchId)),
    ),
    graphNodes,
    graphEdges: upsertMany(
      state.graphEdges.filter(
        (edge) =>
          !removedNodeIds.has(edge.source) &&
          !removedNodeIds.has(edge.destination) &&
          graphNodeIds.has(edge.source) &&
          graphNodeIds.has(edge.destination),
      ),
      event.graphEdges,
    ),
    operations: upsert(
      state.operations.filter((operation) => !removedOperationIds.has(operation.id)),
      event.operation,
    ),
    effects: state.effects.filter((effect) => !removedOperationIds.has(effect.operationId)),
    feedbackDecisions: state.feedbackDecisions.filter(
      (decision) => decision.conversationId !== conversationId,
    ),
    replayCursors: state.replayCursors.filter((cursor) => !runIds.has(cursor.runId)),
    missingHistory: state.missingHistory.filter((range) => !runIds.has(range.runId)),
    queuedInputs: state.queuedInputs.filter((entry) => !runIds.has(entry.runId)),
    activeRunId:
      state.activeRunId !== null && runIds.has(state.activeRunId) ? null : state.activeRunId,
    draft:
      event.replacementDraft?.text ??
      state.drafts.find((draft) => draft.branchId === event.selectedConversation.activeBranchId)
        ?.text ??
      '',
  }
}

function upsertMany<T extends { readonly id: string }>(
  current: readonly T[],
  incoming: readonly T[] | undefined,
): readonly T[] {
  return incoming?.reduce((records, record) => upsert(records, record), current) ?? current
}

function upsertOptional<T extends { readonly id: string }>(
  current: readonly T[],
  incoming: T | undefined,
): readonly T[] {
  return incoming === undefined ? current : upsert(current, incoming)
}
