import type { GraphEdgeKind } from '../../domain/entities.js'
import { graphEdge, graphNodeId } from '../../domain/graph-records.js'
import type { BraidState } from '../../domain/state.js'
import { compareSemanticText } from './semantic-graph-filters.js'
import { type NodeDescriptor, semanticNodeKey, semanticReference } from './semantic-graph-nodes.js'
import {
  SEMANTIC_NODE_TYPES,
  type SemanticGraphEdge,
  type SemanticNodeType,
} from './semantic-query-types.js'

interface ReferenceParts {
  readonly type: SemanticNodeType
  readonly id: string
}

function outputEdge(
  edge: ReturnType<typeof graphEdge>,
  source: ReferenceParts,
  destination: ReferenceParts,
): SemanticGraphEdge {
  return {
    id: edge.id,
    kind: edge.kind,
    source: source.id,
    destination: destination.id,
    sourceType: source.type,
    destinationType: destination.type,
    sourceNodeId: edge.source,
    destinationNodeId: edge.destination,
    provenance: edge.provenance,
    createdAt: edge.createdAt,
  }
}

function compareEdges(left: SemanticGraphEdge, right: SemanticGraphEdge): number {
  const dates = Date.parse(left.createdAt) - Date.parse(right.createdAt)
  if (Number.isFinite(dates) && dates !== 0) return dates
  const kinds = compareSemanticText(left.kind, right.kind)
  if (kinds !== 0) return kinds
  const sources = compareSemanticText(
    `${left.sourceType}:${left.source}`,
    `${right.sourceType}:${right.source}`,
  )
  if (sources !== 0) return sources
  const destinations = compareSemanticText(
    `${left.destinationType}:${left.destination}`,
    `${right.destinationType}:${right.destination}`,
  )
  if (destinations !== 0) return destinations
  return compareSemanticText(left.id, right.id)
}

export function relationEdges(
  state: BraidState,
  nodes: ReadonlyMap<string, NodeDescriptor>,
): SemanticGraphEdge[] {
  const nodeByGraphId = new Map<string, ReferenceParts>()
  for (const node of nodes.values()) {
    nodeByGraphId.set(graphNodeId(semanticReference(node.type, node.id)), {
      type: node.type,
      id: node.id,
    })
  }
  for (const graphNode of state.graphNodes) {
    if (!(SEMANTIC_NODE_TYPES as readonly string[]).includes(graphNode.reference.kind)) continue
    const type = graphNode.reference.kind as SemanticNodeType
    if (nodes.has(semanticNodeKey(type, graphNode.reference.id))) {
      nodeByGraphId.set(graphNode.id, { type, id: graphNode.reference.id })
    }
  }

  const output: SemanticGraphEdge[] = []
  const workersById = new Map(state.workers.map((worker) => [String(worker.id), worker] as const))
  for (const edge of state.graphEdges) {
    const source = nodeByGraphId.get(edge.source)
    const destination = nodeByGraphId.get(edge.destination)
    if (source === undefined || destination === undefined) continue
    if (edge.kind === 'spawned' && destination.type === 'worker') {
      const worker = workersById.get(destination.id)
      if (worker !== undefined) {
        if (worker.parentRuntimeRef !== undefined && worker.parentWorkerId === undefined) continue
        const expected =
          worker.parentWorkerId === undefined
            ? { type: 'supervisor', id: String(worker.supervisorId) }
            : { type: 'worker', id: String(worker.parentWorkerId) }
        if (source.type !== expected.type || source.id !== expected.id) continue
      }
    }
    output.push({
      id: edge.id,
      kind: edge.kind,
      source: source.id,
      destination: destination.id,
      sourceType: source.type,
      destinationType: destination.type,
      sourceNodeId: edge.source,
      destinationNodeId: edge.destination,
      provenance: edge.provenance,
      createdAt: edge.createdAt,
    })
  }

  const known = new Set(
    output.map(
      (edge) =>
        `${edge.kind}:${edge.sourceType}:${edge.source}:${edge.destinationType}:${edge.destination}`,
    ),
  )
  const add = (
    kind: GraphEdgeKind,
    source: ReferenceParts,
    destination: ReferenceParts,
    at: string,
  ): void => {
    if (
      !nodes.has(semanticNodeKey(source.type, source.id)) ||
      !nodes.has(semanticNodeKey(destination.type, destination.id))
    )
      return
    const relationKey = `${kind}:${source.type}:${source.id}:${destination.type}:${destination.id}`
    if (known.has(relationKey)) return
    known.add(relationKey)
    const edge = graphEdge({
      kind,
      source: semanticReference(source.type, source.id),
      destination: semanticReference(destination.type, destination.id),
      at,
    })
    output.push(outputEdge(edge, source, destination))
  }

  for (const branch of state.branches) {
    add(
      'attached',
      { type: 'conversation', id: branch.conversationId },
      { type: 'branch', id: branch.id },
      branch.createdAt,
    )
    if (branch.environmentId !== undefined) {
      add(
        'attached',
        { type: 'branch', id: branch.id },
        { type: 'environment', id: branch.environmentId },
        branch.updatedAt,
      )
    }
  }
  for (const turn of state.turns) {
    add(
      'continued',
      { type: 'branch', id: turn.branchId },
      { type: 'turn', id: turn.id },
      turn.createdAt,
    )
    for (const runId of turn.runIds) {
      add('attached', { type: 'turn', id: turn.id }, { type: 'run', id: runId }, turn.createdAt)
    }
  }
  for (const run of state.runs) {
    add('attached', { type: 'turn', id: run.turnId }, { type: 'run', id: run.id }, run.startedAt)
    if (run.environmentId !== undefined) {
      add(
        'attached',
        { type: 'run', id: run.id },
        { type: 'environment', id: run.environmentId },
        run.startedAt,
      )
    }
  }
  for (const analysis of state.analyses) {
    add(
      'analyzed',
      analysis.source.runId === undefined
        ? { type: 'branch', id: analysis.source.branchId }
        : { type: 'run', id: analysis.source.runId },
      { type: 'analysis', id: analysis.id },
      analysis.createdAt,
    )
  }
  for (const checkpoint of state.checkpoints) {
    add(
      'checkpointed',
      { type: 'environment', id: checkpoint.sourceEnvironmentId },
      { type: 'checkpoint', id: checkpoint.id },
      checkpoint.createdAt,
    )
    if (checkpoint.sourceRunId !== undefined) {
      add(
        'checkpointed',
        { type: 'run', id: checkpoint.sourceRunId },
        { type: 'checkpoint', id: checkpoint.id },
        checkpoint.createdAt,
      )
    }
  }
  for (const binding of state.bindings) {
    if (binding.environmentId !== undefined) {
      add(
        'attached',
        { type: 'branch', id: binding.branchId },
        { type: 'environment', id: binding.environmentId },
        binding.updatedAt,
      )
      if (binding.runId !== undefined) {
        add(
          'attached',
          { type: 'run', id: binding.runId },
          { type: 'environment', id: binding.environmentId },
          binding.updatedAt,
        )
      }
    }
    if (binding.checkpointId !== undefined && binding.environmentId !== undefined) {
      add(
        'forked_environment',
        { type: 'checkpoint', id: binding.checkpointId },
        { type: 'environment', id: binding.environmentId },
        binding.createdAt,
      )
    }
  }
  for (const supervisor of state.supervisors) {
    if (supervisor.rootRunId !== undefined) {
      add(
        'supervised_by',
        { type: 'run', id: supervisor.rootRunId },
        { type: 'supervisor', id: supervisor.id },
        supervisor.createdAt,
      )
    }
  }
  for (const worker of state.workers) {
    if (worker.parentRuntimeRef !== undefined && worker.parentWorkerId === undefined) continue
    add(
      'spawned',
      worker.parentWorkerId === undefined
        ? { type: 'supervisor', id: worker.supervisorId }
        : { type: 'worker', id: worker.parentWorkerId },
      { type: 'worker', id: worker.id },
      worker.createdAt,
    )
    if (worker.runId !== undefined) {
      add(
        'attached',
        { type: 'worker', id: worker.id },
        { type: 'run', id: worker.runId },
        worker.createdAt,
      )
    }
  }
  return output.sort(compareEdges)
}
