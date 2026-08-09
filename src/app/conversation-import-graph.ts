import { canonicalDigest } from '../domain/canonical.js'
import type {
  BranchRecord,
  ConversationRecord,
  GraphEdgeKind,
  GraphEdgeRecord,
  GraphNodeRecord,
  GraphNodeReference,
} from '../domain/entities.js'
import { graphEdge, graphNode, graphNodeId } from '../domain/graph-records.js'
import type { Digest } from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'
import type { ConversationImportIds } from './conversation-import-values.js'
import {
  importRecord,
  importRecords,
  oneOf,
  optionalString,
  requiredString,
} from './conversation-import-values.js'
import { AppError } from './errors.js'

const GRAPH_EDGE_KINDS = [
  'continued',
  'branched_at',
  'cloned_from',
  'retried',
  'handed_off',
  'analyzed',
  'compared_left',
  'compared_right',
  'checkpointed',
  'forked_environment',
  'spawned',
  'supervised_by',
  'attached',
] as const

export function importConversationGraph(input: {
  readonly state: BraidState
  readonly content: Readonly<Record<string, unknown>>
  readonly ids: ConversationImportIds
  readonly workspaceId: NonNullable<BraidState['workspaceId']>
  readonly conversation: ConversationRecord
  readonly branches: readonly BranchRecord[]
  readonly analyses: readonly BraidState['analyses'][number][]
  readonly sourceContentDigest: Digest
  readonly at: string
}): { readonly nodes: readonly GraphNodeRecord[]; readonly edges: readonly GraphEdgeRecord[] } {
  const sourceNodes = importRecords(input.content.graphNodes, 'graphNode', 'content.graphNodes')
  const nodeBySourceId = new Map<string, GraphNodeRecord>()
  const nodes: GraphNodeRecord[] = []
  for (const [index, record] of sourceNodes.entries()) {
    const label = `content.graphNodes[${index}]`
    const sourceId = requiredString(record.id, `${label}.id`)
    const reference = importGraphReference(input.ids, record.reference, `${label}.reference`)
    const node: GraphNodeRecord = {
      id: graphNodeId(reference),
      reference,
      ...optionalField('title', optionalString(record.title, `${label}.title`)),
      ...optionalField('status', optionalString(record.status, `${label}.status`)),
      createdAt: requiredString(record.createdAt, `${label}.createdAt`),
      updatedAt: requiredString(record.updatedAt, `${label}.updatedAt`),
    }
    if (nodes.some((candidate) => candidate.id === node.id)) {
      throw new AppError('IMPORT_INVALID', `${label} duplicates an imported graph reference`)
    }
    nodeBySourceId.set(sourceId, node)
    nodes.push(node)
  }
  const requiredNodes = [
    graphNode(
      { kind: 'conversation', id: input.conversation.id },
      input.at,
      input.conversation.title,
    ),
    ...input.branches.map((branch) => graphNode({ kind: 'branch', id: branch.id }, input.at)),
    ...input.analyses.map((analysis) => graphNode({ kind: 'analysis', id: analysis.id }, input.at)),
  ]
  for (const node of requiredNodes) addUnique(nodes, node)
  const workspaceReference = { kind: 'workspace' as const, id: input.workspaceId }
  const workspaceNode =
    input.state.graphNodes.find((node) => node.id === graphNodeId(workspaceReference)) ??
    graphNode(workspaceReference, input.at, input.state.workspace ?? undefined)
  addUnique(nodes, workspaceNode)

  const edges: GraphEdgeRecord[] = []
  const sourceEdges = importRecords(input.content.graphEdges, 'graphEdge', 'content.graphEdges')
  for (const [index, record] of sourceEdges.entries()) {
    const label = `content.graphEdges[${index}]`
    const sourceEdgeId = requiredString(record.id, `${label}.id`)
    const source = nodeBySourceId.get(requiredString(record.source, `${label}.source`))
    const destination = nodeBySourceId.get(
      requiredString(record.destination, `${label}.destination`),
    )
    if (!source || !destination) {
      throw new AppError('IMPORT_INVALID', `${label} references a missing graph node`)
    }
    const edge = graphEdge({
      kind: oneOf(record.kind, GRAPH_EDGE_KINDS, `${label}.kind`) as GraphEdgeKind,
      source: source.reference,
      destination: destination.reference,
      at: requiredString(record.createdAt, `${label}.createdAt`),
      provenance: {
        sourceDigest: canonicalDigest({
          importDigest: input.sourceContentDigest,
          sourceEdgeId,
        }),
      },
    })
    if (edges.some((candidate) => candidate.id === edge.id)) {
      throw new AppError('IMPORT_INVALID', `${label} duplicates an imported graph edge`)
    }
    edges.push(edge)
  }

  const conversationReference = { kind: 'conversation' as const, id: input.conversation.id }
  addSemanticEdge(
    edges,
    graphEdge({
      kind: 'attached',
      source: workspaceReference,
      destination: conversationReference,
      at: input.at,
      provenance: { sourceDigest: input.sourceContentDigest },
    }),
  )
  for (const branch of input.branches) {
    addSemanticEdge(
      edges,
      graphEdge({
        kind: 'attached',
        source: conversationReference,
        destination: { kind: 'branch', id: branch.id },
        at: input.at,
        provenance: { sourceDigest: input.sourceContentDigest },
      }),
    )
  }
  return { nodes, edges }
}

function importGraphReference(
  ids: ConversationImportIds,
  value: unknown,
  label: string,
): GraphNodeReference {
  const reference = importRecord(value, label)
  const kind = oneOf(
    reference.kind,
    ['conversation', 'branch', 'turn', 'run', 'message', 'analysis'] as const,
    `${label}.kind`,
  )
  switch (kind) {
    case 'conversation':
      return { kind, id: ids.id(kind, reference.id, `${label}.id`) }
    case 'branch':
      return { kind, id: ids.id(kind, reference.id, `${label}.id`) }
    case 'turn':
      return { kind, id: ids.id(kind, reference.id, `${label}.id`) }
    case 'run':
      return { kind, id: ids.id(kind, reference.id, `${label}.id`) }
    case 'message':
      return { kind, id: ids.id(kind, reference.id, `${label}.id`) }
    case 'analysis':
      return { kind, id: ids.id(kind, reference.id, `${label}.id`) }
  }
}

function addUnique<T extends { readonly id: string }>(records: T[], record: T): void {
  if (!records.some((candidate) => candidate.id === record.id)) records.push(record)
}

function addSemanticEdge(records: GraphEdgeRecord[], edge: GraphEdgeRecord): void {
  const exists = records.some(
    (candidate) =>
      candidate.kind === edge.kind &&
      candidate.source === edge.source &&
      candidate.destination === edge.destination,
  )
  if (!exists) records.push(edge)
}

function optionalField<K extends string, T>(key: K, value: T | undefined): { [P in K]?: T } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: T })
}
