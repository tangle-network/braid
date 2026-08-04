import type { MessageRecord, RunRecord, TurnRecord } from './entities.js'
import { graphEdge, graphNode } from './graph-records.js'
import type { BraidState } from './state.js'
import { find, upsert } from './reducer-helpers.js'

export function attachRequestedRunToConversation(
  state: BraidState,
  input: {
    readonly run: RunRecord
    readonly turn: TurnRecord
    readonly userMessage: MessageRecord
    readonly assistantMessage: MessageRecord
    readonly at: string
  },
): BraidState {
  const branch = find(state.branches, input.run.branchId, 'Branch')
  const conversation = find(state.conversations, input.run.conversationId, 'Conversation')
  const branchReference = { kind: 'branch' as const, id: branch.id }
  const turnReference = { kind: 'turn' as const, id: input.turn.id }
  const userReference = { kind: 'message' as const, id: input.userMessage.id }
  const runReference = { kind: 'run' as const, id: input.run.id }
  const assistantReference = { kind: 'message' as const, id: input.assistantMessage.id }
  const nodes = [
    graphNode(turnReference, input.at, 'Turn'),
    graphNode(userReference, input.at, 'User message'),
    graphNode(runReference, input.at, 'Run'),
    graphNode(assistantReference, input.at, 'Assistant message'),
  ]
  const provenance = { operationId: input.run.operationId }
  const edges = [
    graphEdge({
      kind: 'continued',
      source: branchReference,
      destination: turnReference,
      at: input.at,
      provenance,
    }),
    graphEdge({
      kind: 'attached',
      source: turnReference,
      destination: userReference,
      at: input.at,
      provenance,
    }),
    graphEdge({
      kind: 'attached',
      source: turnReference,
      destination: runReference,
      at: input.at,
      provenance,
    }),
    graphEdge({
      kind: 'attached',
      source: runReference,
      destination: assistantReference,
      at: input.at,
      provenance,
    }),
  ]
  return {
    ...state,
    branches: upsert(state.branches, {
      ...branch,
      tipMessageId: input.assistantMessage.id,
      updatedAt: input.at,
    }),
    conversations: upsert(state.conversations, {
      ...conversation,
      activeBranchId: branch.id,
      updatedAt: input.at,
    }),
    graphNodes: nodes.reduce(upsert, state.graphNodes),
    graphEdges: edges.reduce(upsert, state.graphEdges),
  }
}
