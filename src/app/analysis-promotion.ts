import { validateAnalysisCitation } from '../adapters/analysis/citations.js'
import { canonicalDigest } from '../domain/canonical.js'
import type {
  AnalysisAttachmentRecord,
  AnalysisCitation,
  AnalysisFinding,
  AnalysisRecord,
} from '../domain/entities.js'
import type { BranchId, ConversationId } from '../domain/ids.js'
import { createAttachmentId } from '../domain/ids-values.js'
import { AnalysisGraphProjector } from './analysis-graph-projector.js'
import {
  analysisIdentity,
  operationResult,
  reconcileAnalysisState,
  reserveAnalysisOperation,
  updateAnalysisOperation,
} from './analysis-operation.js'
import { commitAnalysisEvent } from './analysis-persistence.js'
import { loadFrozenAnalysisSource } from './analysis-source.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

export type AnalysisPromotionAttachment = AnalysisAttachmentRecord

export interface PromoteAnalysisInput {
  readonly operationId?: string
  readonly analysis: AnalysisRecord
  readonly selectedFindingIds: readonly string[]
  readonly destinationConversationId: ConversationId
  readonly destinationBranchId: BranchId
  readonly createdAt?: string
}

function selectedFindings(
  findings: readonly AnalysisFinding[],
  ids: readonly string[],
  evidence: Parameters<typeof validateAnalysisCitation>[0],
): readonly {
  readonly id: string
  readonly text: string
  readonly citations: readonly AnalysisCitation[]
}[] {
  if (ids.length === 0) throw new Error('Analysis promotion requires at least one selected finding')
  const unique = new Set(ids)
  if (unique.size !== ids.length) {
    throw new Error('Analysis promotion contains duplicate finding ids')
  }
  return ids.map((id) => {
    const finding = findings.find((candidate) => candidate.id === id)
    if (finding === undefined) throw new Error(`Analysis finding ${id} is not present`)
    if (!finding.supported) throw new Error(`Analysis finding ${id} has no supported citations`)
    for (const citation of finding.citations) validateAnalysisCitation(evidence, citation)
    return { id: finding.id, text: finding.text, citations: finding.citations }
  })
}

export class AnalysisPromotionService {
  readonly #host: AnalysisApplicationHost
  readonly #graph: AnalysisGraphProjector
  #reconciled = false

  constructor(host: AnalysisApplicationHost) {
    this.#host = host
    this.#graph = new AnalysisGraphProjector(host)
  }

  async promote(input: PromoteAnalysisInput): Promise<AnalysisPromotionAttachment> {
    if (!this.#reconciled) {
      await reconcileAnalysisState(this.#host)
      this.#reconciled = true
    }
    const state = this.#host.currentState()
    const persisted = state.analyses.find((candidate) => candidate.id === input.analysis.id)
    if (persisted === undefined) {
      throw new Error(`Analysis ${String(input.analysis.id)} is not durably persisted`)
    }
    if (canonicalDigest(persisted) !== canonicalDigest(input.analysis)) {
      throw new Error(`Analysis ${String(input.analysis.id)} does not match its persisted record`)
    }
    const analysis = persisted
    const destinationBranch = state.branches.find(
      (candidate) => candidate.id === input.destinationBranchId,
    )
    if (destinationBranch === undefined) {
      throw new Error(`Destination branch ${String(input.destinationBranchId)} does not exist`)
    }
    if (destinationBranch.conversationId !== input.destinationConversationId) {
      throw new Error(
        `Destination branch ${String(input.destinationBranchId)} does not belong to conversation ${String(input.destinationConversationId)}`,
      )
    }
    if (analysis.status !== 'completed') {
      throw new Error(`Analysis ${String(analysis.id)} is not completed`)
    }
    if (!analysis.source.complete) {
      throw new Error(`Analysis ${String(analysis.id)} has incomplete source history`)
    }
    const sourceRequest = {
      conversationId: analysis.source.conversationId,
      branchId: analysis.source.branchId,
      ...(analysis.source.runId === undefined ? {} : { runId: analysis.source.runId }),
      ...(analysis.source.throughMessageId === undefined
        ? {}
        : { throughMessageId: analysis.source.throughMessageId }),
    }
    const current = await loadFrozenAnalysisSource(this.#host, state, sourceRequest)
    if (current.source.digest !== analysis.source.digest) {
      throw new Error(
        `Analysis source changed before promotion: expected ${String(analysis.source.digest)}, received ${String(current.source.digest)}`,
      )
    }
    const request = {
      analysisId: analysis.id,
      selectedFindingIds: input.selectedFindingIds,
      destinationConversationId: input.destinationConversationId,
      destinationBranchId: input.destinationBranchId,
    }
    const identity = analysisIdentity({
      kind: 'promotion',
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      sourceDigests: [String(analysis.source.digest)],
      request,
    })
    const reserved = this.#host
      .currentState()
      .operations.find((operation) => operation.id === identity.operationId)
    if (
      reserved !== undefined &&
      (reserved.requestDigest !== identity.requestDigest || reserved.kind !== 'promote-analysis')
    ) {
      throw new Error(
        `Operation ${String(identity.operationId)} was already reserved for a different promotion request`,
      )
    }
    const existing = this.#host
      .currentState()
      .analysisAttachments.find((attachment) => attachment.operationId === identity.operationId)
    if (existing !== undefined) {
      await this.#graph.projectAttachment(existing)
      const operation = this.#host
        .currentState()
        .operations.find((candidate) => candidate.id === identity.operationId)
      if (operation !== undefined && operation.status !== 'terminal') {
        await updateAnalysisOperation(this.#host, operation, {
          status: 'terminal',
          terminalOutcome: 'completed',
          result: operationResult({
            attachmentId: String(existing.id),
            analysisId: String(existing.analysisId),
            sourceDigest: String(existing.sourceDigest),
          }),
        })
      }
      return existing
    }
    const selected = selectedFindings(analysis.findings, input.selectedFindingIds, current)
    const createdAt = input.createdAt ?? this.#host.now()
    const attachment: AnalysisAttachmentRecord = {
      id: createAttachmentId(
        `attachment-${canonicalDigest({ operationId: identity.operationId, request }).slice(0, 40)}`,
      ),
      operationId: identity.operationId,
      analysisId: analysis.id,
      ...(analysis.analysisRunId === undefined ? {} : { analysisRunId: analysis.analysisRunId }),
      sourceConversationId: analysis.source.conversationId,
      sourceBranchId: analysis.source.branchId,
      ...(analysis.source.runId === undefined ? {} : { sourceRunId: analysis.source.runId }),
      sourceDigest: analysis.source.digest,
      destinationConversationId: input.destinationConversationId,
      destinationBranchId: input.destinationBranchId,
      selectedFindings: selected,
      provenance: {
        analysisId: analysis.id,
        sourceDigest: analysis.source.digest,
        ...(analysis.analystProfileDigest === undefined
          ? {}
          : { analystProfileDigest: analysis.analystProfileDigest }),
        ...(analysis.provenance?.model === undefined ? {} : { model: analysis.provenance.model }),
        ...(analysis.provenance?.runner === undefined
          ? {}
          : { runner: analysis.provenance.runner }),
        ...(analysis.provenance?.agentEvalVersion === undefined
          ? {}
          : { agentEvalVersion: analysis.provenance.agentEvalVersion }),
      },
      createdAt,
    }
    const reservation = await reserveAnalysisOperation(this.#host, {
      identity,
      kind: 'promote-analysis',
      target: analysis.id,
    })
    if (!reservation.created) {
      const replay = this.#host
        .currentState()
        .analysisAttachments.find((candidate) => candidate.operationId === identity.operationId)
      if (replay !== undefined) return replay
      throw new Error(
        `Promotion operation ${String(reservation.operation.id)} is already active or unavailable`,
      )
    }
    await commitAnalysisEvent(this.#host, { kind: 'analysis.attachment.created', attachment })
    await this.#graph.projectAttachment(attachment)
    const currentOperation = this.#host
      .currentState()
      .operations.find((candidate) => candidate.id === identity.operationId)
    if (currentOperation !== undefined) {
      await updateAnalysisOperation(this.#host, currentOperation, {
        status: 'terminal',
        terminalOutcome: 'completed',
        result: operationResult({
          attachmentId: String(attachment.id),
          analysisId: String(attachment.analysisId),
          sourceDigest: String(attachment.sourceDigest),
        }),
      })
    }
    return attachment
  }
}
