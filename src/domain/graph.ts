import { canonicalDigest } from './canonical.js'
import {
  type AnalysisId,
  assertIdForKind,
  type BranchId,
  type CheckpointId,
  type ConversationId,
  digest,
  type EnvironmentId,
  type EventId,
  type GraphEdgeId,
  type OperationId,
  type RunId,
  type SupervisorId,
  type TurnId,
  type WorkerId,
} from './ids.js'

export type GraphNodeKind =
  | 'conversation'
  | 'branch'
  | 'turn'
  | 'run'
  | 'analysis'
  | 'environment'
  | 'checkpoint'
  | 'supervisor'
  | 'worker'

export type GraphEntityId =
  | ConversationId
  | BranchId
  | TurnId
  | RunId
  | AnalysisId
  | EnvironmentId
  | CheckpointId
  | SupervisorId
  | WorkerId

export interface GraphNode {
  readonly id: GraphEntityId
  readonly kind: GraphNodeKind
  readonly label: string
  readonly data: Readonly<Record<string, unknown>>
}

export type GraphEdgeKind =
  | 'continued'
  | 'branched_at'
  | 'cloned_from'
  | 'retried'
  | 'handed_off'
  | 'analyzed'
  | 'compared_left'
  | 'compared_right'
  | 'checkpointed'
  | 'forked_environment'
  | 'spawned'
  | 'supervised_by'
  | 'attached'

export interface GraphProvenance {
  readonly sourceEventId: EventId
  readonly sourceDigest?: ReturnType<typeof digest>
  readonly receiptId?: string
}

export interface GraphEdge {
  readonly id: GraphEdgeId
  readonly kind: GraphEdgeKind
  readonly from: GraphEntityId
  readonly to: GraphEntityId
  readonly operationId: OperationId
  readonly at: string
  readonly provenance: GraphProvenance
}

export interface BraidGraph {
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly digest: ReturnType<typeof digest>
}

export type GraphEntity =
  | {
      readonly id: ConversationId
      readonly kind: 'conversation'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: BranchId
      readonly kind: 'branch'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: TurnId
      readonly kind: 'turn'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: RunId
      readonly kind: 'run'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: AnalysisId
      readonly kind: 'analysis'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: EnvironmentId
      readonly kind: 'environment'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: CheckpointId
      readonly kind: 'checkpoint'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: SupervisorId
      readonly kind: 'supervisor'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }
  | {
      readonly id: WorkerId
      readonly kind: 'worker'
      readonly label?: string
      readonly data?: Readonly<Record<string, unknown>>
    }

/**
 * Records read from the committed journal projection.
 *
 * Callers must not construct graph edges from a transient view: the required
 * operation, timestamp, source event, and source digest are the commit proof.
 */
export interface GraphRelation {
  readonly id: GraphEdgeId
  readonly kind: GraphEdgeKind
  readonly from: GraphEntityId
  readonly to: GraphEntityId
  readonly operationId: OperationId
  readonly at: string
  readonly provenance: GraphProvenance
}

export interface GraphInput {
  readonly entities: readonly GraphEntity[]
  readonly relations: readonly GraphRelation[]
}

/**
 * Narrow read-only projection port until the W5 journal projection is merged.
 * Its values are the exact persisted graph record shapes above; it cannot
 * admit a transient view or create an edge on behalf of a caller.
 */
export interface PersistedGraphPort {
  readGraph(): Promise<GraphInput>
}

const idKindForNode: Readonly<Record<GraphNodeKind, Parameters<typeof assertIdForKind>[0]>> = {
  conversation: 'conversation',
  branch: 'branch',
  turn: 'turn',
  run: 'run',
  analysis: 'analysis',
  environment: 'environment',
  checkpoint: 'checkpoint',
  supervisor: 'supervisor',
  worker: 'worker',
}

function assertCommittedAt(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new TypeError('Graph edge timestamp must be a committed ISO-8601 instant')
  }
  if (new Date(value).toISOString() !== value) {
    throw new TypeError('Graph edge timestamp is not a real instant')
  }
}

function assertProvenance(value: GraphProvenance): void {
  assertIdForKind('event', value.sourceEventId)
  if (value.sourceDigest !== undefined) digest(value.sourceDigest)
  if (
    value.receiptId !== undefined &&
    (typeof value.receiptId !== 'string' || value.receiptId.length === 0)
  )
    throw new TypeError('Graph edge provenance receiptId must be a non-empty string')
}

function freezeGraphValue<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  const stack: object[] = [value as object]
  const seen = new Set<object>()
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    Object.freeze(current)
    for (const child of Object.values(current as Record<string, unknown>)) {
      if (child && typeof child === 'object') stack.push(child)
    }
  }
  return value
}

export function buildBraidGraph(input: GraphInput): BraidGraph {
  const nodes = new Map<GraphEntityId, GraphNode>()
  for (const entity of input.entities) {
    assertIdForKind(idKindForNode[entity.kind], entity.id)
    if (nodes.has(entity.id)) throw new Error(`Duplicate graph node: ${entity.id}`)
    nodes.set(entity.id, {
      id: entity.id,
      kind: entity.kind,
      label: entity.label ?? entity.id,
      data: structuredClone(entity.data ?? {}),
    })
  }

  const edges = new Map<GraphEdgeId, GraphEdge>()
  for (const relation of input.relations) {
    if (!nodes.has(relation.from) || !nodes.has(relation.to)) {
      throw new Error(`Graph edge endpoint missing: ${relation.from} -> ${relation.to}`)
    }
    if (relation.from === relation.to)
      throw new Error(`Graph edge cannot point to itself: ${relation.id}`)
    assertIdForKind('graphEdge', relation.id)
    assertIdForKind('operation', relation.operationId)
    assertCommittedAt(relation.at)
    assertProvenance(relation.provenance)
    if (edges.has(relation.id)) throw new Error(`Duplicate graph edge: ${relation.id}`)
    edges.set(relation.id, structuredClone({ ...relation }))
  }

  const snapshot = {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
  }
  assertGraphAcyclic(snapshot.nodes, snapshot.edges)
  return freezeGraphValue({ ...snapshot, digest: digest(`sha256:${canonicalDigest(snapshot)}`) })
}

export async function buildBraidGraphFromPersisted(port: PersistedGraphPort): Promise<BraidGraph> {
  return buildBraidGraph(await port.readGraph())
}

export function assertGraphAcyclic(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const outgoing = new Map<GraphEntityId, GraphEntityId[]>()
  for (const node of nodes) outgoing.set(node.id, [])
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to))
      throw new Error(`Graph edge endpoint missing: ${edge.from} -> ${edge.to}`)
    if (edge.from === edge.to) throw new Error(`Graph edge cannot point to itself: ${edge.id}`)
    outgoing.get(edge.from)?.push(edge.to)
  }

  const state = new Map<GraphEntityId, 'visiting' | 'visited'>()
  for (const root of nodes) {
    if (state.get(root.id) === 'visited') continue
    state.set(root.id, 'visiting')
    const stack: Array<{ readonly id: GraphEntityId; index: number }> = [{ id: root.id, index: 0 }]
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      if (!frame) break
      const children = outgoing.get(frame.id) ?? []
      const child = children[frame.index]
      if (child === undefined) {
        state.set(frame.id, 'visited')
        stack.pop()
        continue
      }
      frame.index += 1
      const childState = state.get(child)
      if (childState === 'visiting') throw new Error(`Graph cycle detected at ${child}`)
      if (childState === 'visited') continue
      state.set(child, 'visiting')
      stack.push({ id: child, index: 0 })
    }
  }
}
