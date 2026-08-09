import type { BraidState } from '../../domain/state.js'
import { sanitizeTerminalText } from './sanitize.js'
import { relationEdges } from './semantic-graph-edges.js'
import { compareNodes, parseGraphQuery } from './semantic-graph-filters.js'
import { descriptorsFor, type NodeDescriptor, semanticNodeKey } from './semantic-graph-nodes.js'
import {
  isInScope,
  resolveScope,
  SemanticQueryError,
  type SemanticQueryScope,
} from './semantic-query-scope.js'
import type {
  GraphQueryResult,
  SemanticGraphEdge,
  SemanticGraphNode,
  SemanticNodeType,
} from './semantic-query-types.js'

function graphDepths(
  nodes: readonly NodeDescriptor[],
  edges: readonly SemanticGraphEdge[],
): ReadonlyMap<string, number> {
  const incomingCount = new Map(nodes.map((node) => [semanticNodeKey(node.type, node.id), 0]))
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) {
    const source = semanticNodeKey(edge.sourceType, edge.source)
    const destination = semanticNodeKey(edge.destinationType, edge.destination)
    incomingCount.set(destination, (incomingCount.get(destination) ?? 0) + 1)
    const destinations = outgoing.get(source) ?? []
    destinations.push(destination)
    outgoing.set(source, destinations)
  }

  const depths = new Map<string, number>()
  const queue = [...incomingCount]
    .filter(([, count]) => count === 0)
    .map(([key]) => key)
    .sort()
  for (const root of queue) depths.set(root, 0)
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const source = queue[cursor]
    if (source === undefined) continue
    const nextDepth = (depths.get(source) ?? 0) + 1
    for (const destination of outgoing.get(source) ?? []) {
      const previous = depths.get(destination)
      if (previous !== undefined && previous <= nextDepth) continue
      depths.set(destination, nextDepth)
      queue.push(destination)
    }
  }

  // A disconnected strongly connected component has no natural root. Keeping
  // those nodes at depth zero is deterministic and avoids fabricating ancestry.
  for (const key of incomingCount.keys()) {
    if (!depths.has(key)) depths.set(key, 0)
  }
  return depths
}

function graphNodeFromDescriptor(node: NodeDescriptor, depth: number): SemanticGraphNode {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    status: node.status,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    depth,
    ...(node.runner === undefined ? {} : { runner: node.runner }),
    ...(node.elapsedMs === undefined ? {} : { elapsedMs: node.elapsedMs }),
    ...(node.costUsd === undefined ? {} : { costUsd: node.costUsd }),
  }
}

export function queryGraph(
  state: BraidState,
  input: {
    readonly conversationId?: string
    readonly branchId?: string
    readonly query?: string
  } = {},
): GraphQueryResult {
  const scope = resolveScope(state, input)
  const queryText = sanitizeTerminalText(input.query ?? '')
  const parsed = parseGraphQuery(queryText)
  const descriptors = descriptorsFor(state).filter((node) =>
    isInScope(state, node.type, node.id, scope),
  )
  const descriptorMap = new Map(
    descriptors.map((node) => [semanticNodeKey(node.type, node.id), node]),
  )
  const allEdges = relationEdges(state, descriptorMap)
  const depths = graphDepths(descriptors, allEdges)
  const edgeNodes = new Set<string>()
  if (parsed.edgeKind !== undefined) {
    for (const edge of allEdges) {
      if (edge.kind.toLowerCase() !== parsed.edgeKind) continue
      edgeNodes.add(semanticNodeKey(edge.sourceType, edge.source))
      edgeNodes.add(semanticNodeKey(edge.destinationType, edge.destination))
    }
  }
  const matching = descriptors
    .filter((node) => parsed.type === undefined || node.type === parsed.type)
    .filter((node) => parsed.status === undefined || node.status.toLowerCase() === parsed.status)
    .filter((node) => parsed.runner === undefined || node.runner?.toLowerCase() === parsed.runner)
    .filter(
      (node) => parsed.edgeKind === undefined || edgeNodes.has(semanticNodeKey(node.type, node.id)),
    )
    .filter((node) => parsed.terms.every((term) => node.searchText.includes(term)))
    .sort(compareNodes)
  const selected = new Set(matching.map((node) => semanticNodeKey(node.type, node.id)))
  const edges = allEdges.filter(
    (edge) =>
      selected.has(semanticNodeKey(edge.sourceType, edge.source)) &&
      selected.has(semanticNodeKey(edge.destinationType, edge.destination)),
  )
  return {
    query: queryText,
    ...(scope.conversationId === undefined ? {} : { conversationId: scope.conversationId }),
    ...(scope.branchId === undefined ? {} : { branchId: scope.branchId }),
    nodes: matching.map((node) =>
      graphNodeFromDescriptor(node, depths.get(semanticNodeKey(node.type, node.id)) ?? 0),
    ),
    edges,
  }
}

export function graphEdgesForEntity(
  state: BraidState,
  type: SemanticNodeType,
  id: string,
): readonly SemanticGraphEdge[] {
  return queryGraph(state).edges.filter(
    (edge) =>
      (edge.sourceType === type && edge.source === id) ||
      (edge.destinationType === type && edge.destination === id),
  )
}

export function ensureEntityExists(state: BraidState, type: SemanticNodeType, id: string): void {
  if (!queryGraph(state).nodes.some((node) => node.type === type && node.id === id)) {
    throw new SemanticQueryError('UNKNOWN_ENTITY', `The requested ${type} is unknown`)
  }
}

export type { SemanticQueryScope }
