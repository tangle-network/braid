import type { AnalysisRecord } from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import { commitAnalysisEvent } from './analysis-persistence.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

export class AnalysisComparisonGraph {
  readonly #host: AnalysisApplicationHost

  constructor(host: AnalysisApplicationHost) {
    this.#host = host
  }

  async project(record: AnalysisRecord): Promise<void> {
    if (record.comparison === undefined) throw new Error('Comparison has no frozen snapshot')
    const comparisonReference = { kind: 'analysis' as const, id: record.id }
    const baselineReference = record.comparison.baseline.runId
      ? { kind: 'run' as const, id: record.comparison.baseline.runId }
      : { kind: 'branch' as const, id: record.comparison.baseline.branchId }
    const candidateReference = record.comparison.candidate.runId
      ? { kind: 'run' as const, id: record.comparison.candidate.runId }
      : { kind: 'branch' as const, id: record.comparison.candidate.branchId }
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.node.upserted',
      node: graphNode(comparisonReference, record.createdAt),
    })
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.node.upserted',
      node: graphNode(baselineReference, record.createdAt),
    })
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.node.upserted',
      node: graphNode(candidateReference, record.createdAt),
    })
    const provenance = {
      ...(record.operationId === undefined ? {} : { operationId: record.operationId }),
      sourceDigest: record.source.digest,
    }
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.edge.upserted',
      edge: graphEdge({
        kind: 'compared_left',
        source: baselineReference,
        destination: comparisonReference,
        at: record.createdAt,
        provenance,
      }),
    })
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.edge.upserted',
      edge: graphEdge({
        kind: 'compared_right',
        source: candidateReference,
        destination: comparisonReference,
        at: record.createdAt,
        provenance: { ...provenance, sourceDigest: record.comparison.candidate.digest },
      }),
    })
  }
}
