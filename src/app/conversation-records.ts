import type { ReasoningEffort } from '@tangle-network/agent-interface'
import {
  harnessTypeSchema,
  reasoningEffortSchema,
} from '../adapters/agent-interface/harness-runtime.js'
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
import { containsUnsafeControlCharacter } from '../domain/text.js'
import type { BuiltConversation } from './conversation-types.js'
import { AppError } from './errors.js'

export function runOverrides(input: {
  readonly runner?: string
  readonly model?: string
  readonly effort?: string
  readonly mode?: string
  readonly inherited?: RunOverrides
}): RunOverrides {
  const runner = parseRunner(input.runner)
  let effort: ReasoningEffort | undefined
  if (input.effort !== undefined) {
    const parsed = reasoningEffortSchema.safeParse(input.effort.trim())
    if (!parsed.success) throw new AppError('INVALID_EFFORT', 'Reasoning effort is not supported')
    effort = parsed.data
  }
  const model = parsePublicOverride(input.model, 'model', 512)
  const mode = parsePublicOverride(input.mode, 'mode', 256)
  return {
    ...(input.inherited ?? {}),
    ...(runner === undefined ? {} : { runner }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(mode === undefined ? {} : { mode }),
  }
}

function parseRunner(value: string | undefined): RunOverrides['runner'] {
  if (value === undefined) return undefined
  const parsed = harnessTypeSchema.safeParse(value.trim())
  if (!parsed.success) throw new AppError('INVALID_RUNNER', 'Runner is not supported')
  return parsed.data
}

function parsePublicOverride(
  value: string | undefined,
  label: 'model' | 'mode',
  maxBytes: number,
): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > maxBytes ||
    containsUnsafeControlCharacter(normalized) ||
    redactSensitiveText(normalized) !== normalized
  ) {
    throw new AppError(
      label === 'model' ? 'INVALID_MODEL' : 'INVALID_MODE',
      `${label === 'model' ? 'Model' : 'Mode'} must be a public identifier`,
    )
  }
  return normalized
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
