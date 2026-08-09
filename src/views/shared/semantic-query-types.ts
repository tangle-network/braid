import type { GraphEdgeKind, GraphProvenance } from '../../domain/entities.js'
import type { ActivityItemView, ViewStatus } from './models.js'

export const SEMANTIC_NODE_TYPES = [
  'conversation',
  'branch',
  'turn',
  'run',
  'analysis',
  'environment',
  'checkpoint',
  'supervisor',
  'worker',
] as const

export type SemanticNodeType = (typeof SEMANTIC_NODE_TYPES)[number]

export interface SemanticGraphNode {
  readonly id: string
  readonly type: SemanticNodeType
  readonly title: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly depth: number
  readonly runner?: string
  readonly elapsedMs?: number
  readonly costUsd?: number
}

export interface SemanticGraphEdge {
  readonly id: string
  readonly kind: GraphEdgeKind
  readonly source: string
  readonly destination: string
  readonly sourceType: SemanticNodeType
  readonly destinationType: SemanticNodeType
  readonly sourceNodeId: string
  readonly destinationNodeId: string
  readonly provenance: GraphProvenance
  readonly createdAt: string
}

export interface GraphQueryResult {
  readonly query: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly nodes: readonly SemanticGraphNode[]
  readonly edges: readonly SemanticGraphEdge[]
}

export interface SemanticActivityItem {
  readonly id: string
  readonly kind: ActivityItemView['kind']
  readonly title: string
  readonly status: string
  readonly occurredAt: string
  readonly detail?: string
  readonly sourceEventId?: string
  readonly runId?: string
  readonly entityType?: SemanticNodeType
  readonly entityId?: string
  readonly elapsedMs?: number
}

export interface ActivityQueryResult {
  readonly conversationId?: string
  readonly branchId?: string
  readonly runId?: string
  readonly activity: readonly SemanticActivityItem[]
}

export interface SemanticDetailField {
  readonly label: string
  readonly value: string
}

export interface DetailsQueryResult {
  readonly entityType: SemanticNodeType
  readonly entityId: string
  readonly title: string
  readonly status: string
  readonly fields: readonly SemanticDetailField[]
  readonly data: Readonly<Record<string, unknown>>
  readonly edges: readonly SemanticGraphEdge[]
}

export function viewStatusForSemanticStatus(status: string): ViewStatus | 'complete' {
  switch (status) {
    case 'starting':
      return 'starting'
    case 'running':
    case 'streaming':
      return 'running'
    case 'waiting':
    case 'blocked':
      return 'waiting'
    case 'cancelling':
      return 'cancelling'
    case 'completed':
    case 'complete':
    case 'active':
    case 'ready':
    case 'bound':
    case 'requested':
    case 'preparing':
      return 'complete'
    case 'cancelled':
    case 'aborted':
      return 'cancelled'
    case 'failed':
    case 'failed-preparation':
      return 'failed'
    case 'expired':
      return 'expired'
    case 'unknown':
    case 'deleted':
    case 'destroyed':
      return 'unknown'
    default:
      return 'complete'
  }
}
