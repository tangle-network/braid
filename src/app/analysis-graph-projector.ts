import type { AnalysisAttachmentRecord, AnalysisRecord } from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import { commitAnalysisEvent } from './analysis-persistence.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

export class AnalysisGraphProjector {
  readonly #host: AnalysisApplicationHost

  constructor(host: AnalysisApplicationHost) {
    this.#host = host
  }

  async project(analysis: AnalysisRecord): Promise<void> {
    const sourceReference =
      analysis.source.runId === undefined
        ? { kind: 'branch' as const, id: analysis.source.branchId }
        : { kind: 'run' as const, id: analysis.source.runId }
    const analysisReference = { kind: 'analysis' as const, id: analysis.id }
    const provenance = {
      ...(analysis.operationId === undefined ? {} : { operationId: analysis.operationId }),
      sourceDigest: analysis.source.digest,
    }
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.node.upserted',
      node: graphNode(sourceReference, analysis.createdAt),
    })
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.node.upserted',
      node: graphNode(analysisReference, analysis.createdAt),
    })
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.edge.upserted',
      edge: graphEdge({
        kind: 'analyzed',
        source: sourceReference,
        destination: analysisReference,
        at: analysis.createdAt,
        provenance,
      }),
    })
  }

  async projectAttachment(attachment: AnalysisAttachmentRecord): Promise<void> {
    const analysisReference = { kind: 'analysis' as const, id: attachment.analysisId }
    const branchReference = { kind: 'branch' as const, id: attachment.destinationBranchId }
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.node.upserted',
      node: graphNode(analysisReference, attachment.createdAt),
    })
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.node.upserted',
      node: graphNode(branchReference, attachment.createdAt),
    })
    await commitAnalysisEvent(this.#host, {
      kind: 'graph.edge.upserted',
      edge: graphEdge({
        kind: 'attached',
        source: branchReference,
        destination: analysisReference,
        at: attachment.createdAt,
        provenance: {
          operationId: attachment.operationId,
          sourceDigest: attachment.sourceDigest,
        },
      }),
    })
  }
}
