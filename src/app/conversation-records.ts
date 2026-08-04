import type { ReasoningEffort } from '@tangle-network/agent-interface'
import type {
  BranchBoundary,
  BranchRecord,
  ConversationRecord,
  DraftRecord,
  GraphEdgeKind,
  GraphEdgeRecord,
  GraphNodeRecord,
  QueueRecord,
  RunOverrides,
} from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import type {
  BranchId,
  ConnectionId,
  ConversationId,
  DraftId,
  OperationId,
  ProfileId,
  QueueId,
  WorkspaceId,
} from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { BuiltConversation } from './conversation-types.js'
import { AppError } from './errors.js'

const EFFORTS = new Set<ReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultracode',
])

export function runOverrides(input: {
  readonly runner?: string
  readonly model?: string
  readonly effort?: string
  readonly inherited?: RunOverrides
}): RunOverrides {
  let effort: ReasoningEffort | undefined
  if (input.effort !== undefined) {
    if (!EFFORTS.has(input.effort as ReasoningEffort)) {
      throw new AppError('INVALID_EFFORT', `Unknown reasoning effort ${input.effort}`)
    }
    effort = input.effort as ReasoningEffort
  }
  return {
    ...(input.inherited ?? {}),
    ...(input.runner === undefined ? {} : { runner: redactSensitiveText(input.runner, 256) }),
    ...(input.model === undefined ? {} : { model: redactSensitiveText(input.model, 512) }),
    ...(effort === undefined ? {} : { effort }),
  }
}

export function draftRecord(id: DraftId, branchId: BranchId, at: string, text = ''): DraftRecord {
  return { id, branchId, text: redactSensitiveText(text), updatedAt: at }
}

export function queueRecord(id: QueueId, branchId: BranchId, at: string): QueueRecord {
  return { id, branchId, entryIds: [], createdAt: at, updatedAt: at }
}

export function conversationBundle(input: {
  readonly workspaceId: WorkspaceId
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly draftId: DraftId
  readonly queueId: QueueId
  readonly title: string
  readonly at: string
  readonly operationId: OperationId
  readonly profileId?: ProfileId
  readonly connectionId?: ConnectionId
  readonly source?: BranchBoundary
  readonly sourceNode?: GraphNodeRecord['reference']
  readonly sourceEdgeKind?: GraphEdgeKind
  readonly overrides?: RunOverrides
  readonly environmentId?: BranchRecord['environmentId']
}): BuiltConversation {
  const conversation: ConversationRecord = {
    id: input.conversationId,
    workspaceId: input.workspaceId,
    title: input.title,
    activeBranchId: input.branchId,
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    createdAt: input.at,
    updatedAt: input.at,
    archived: false,
    retention: {},
  }
  const branch: BranchRecord = {
    id: input.branchId,
    conversationId: input.conversationId,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
    ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
    overrides: input.overrides ?? {},
    ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
    draftId: input.draftId,
    queueId: input.queueId,
    status: 'active',
    createdAt: input.at,
    updatedAt: input.at,
  }
  const draft = draftRecord(input.draftId, input.branchId, input.at)
  const queue = queueRecord(input.queueId, input.branchId, input.at)
  const workspaceNode = graphNode({ kind: 'workspace', id: input.workspaceId }, input.at)
  const conversationNode = graphNode(
    { kind: 'conversation', id: input.conversationId },
    input.at,
    input.title,
  )
  const branchNode = graphNode({ kind: 'branch', id: input.branchId }, input.at, 'Main')
  const graphEdges: GraphEdgeRecord[] = [
    graphEdge({
      kind: 'attached',
      source: workspaceNode.reference,
      destination: conversationNode.reference,
      at: input.at,
      provenance: { operationId: input.operationId },
    }),
    graphEdge({
      kind: 'attached',
      source: conversationNode.reference,
      destination: branchNode.reference,
      at: input.at,
      provenance: { operationId: input.operationId },
    }),
  ]
  const graphNodes = [workspaceNode, conversationNode, branchNode]
  if (input.sourceNode !== undefined && input.sourceEdgeKind !== undefined) {
    const sourceNode = graphNode(input.sourceNode, input.at)
    graphNodes.push(sourceNode)
    graphEdges.push(
      graphEdge({
        kind: input.sourceEdgeKind,
        source: sourceNode.reference,
        destination: conversationNode.reference,
        at: input.at,
        provenance: { operationId: input.operationId },
      }),
    )
  }
  return { conversation, branch, draft, queue, graphNodes, graphEdges }
}
