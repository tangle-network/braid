import { canonicalDigest } from './canonical.js'
import type {
  GraphEdgeKind,
  GraphEdgeRecord,
  GraphNodeRecord,
  GraphNodeReference,
  GraphProvenance,
} from './entities.js'
import { createGraphEdgeId, createGraphNodeId, type GraphNodeId } from './ids.js'

export function graphNodeId(reference: GraphNodeReference): GraphNodeId {
  return createGraphNodeId(`node-${canonicalDigest(reference).slice(0, 32)}`)
}

export function graphNode(
  reference: GraphNodeReference,
  at: string,
  title?: string,
): GraphNodeRecord {
  return {
    id: graphNodeId(reference),
    reference,
    ...(title === undefined ? {} : { title }),
    createdAt: at,
    updatedAt: at,
  }
}

export function graphEdge(input: {
  readonly kind: GraphEdgeKind
  readonly source: GraphNodeReference
  readonly destination: GraphNodeReference
  readonly at: string
  readonly provenance?: GraphProvenance
}): GraphEdgeRecord {
  const source = graphNodeId(input.source)
  const destination = graphNodeId(input.destination)
  return {
    id: createGraphEdgeId(
      `edge-${canonicalDigest({
        kind: input.kind,
        source,
        destination,
        provenance: input.provenance ?? {},
      }).slice(0, 32)}`,
    ),
    kind: input.kind,
    source,
    destination,
    provenance: input.provenance ?? {},
    createdAt: input.at,
  }
}
