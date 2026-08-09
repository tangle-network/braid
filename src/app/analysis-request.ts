import { type AnalysisIdentity, analysisIdentity } from './analysis-operation.js'
import { freezeAnalysisSource } from './analysis-source.js'
import type {
  AnalysisApplicationHost,
  AnalysisRequest,
  FrozenAnalysisEvidence,
} from './analysis-types.js'

export interface PreparedAnalysisRequest {
  readonly evidence: FrozenAnalysisEvidence
  readonly identity: AnalysisIdentity
}

function requestForDigest(request: AnalysisRequest): Readonly<Record<string, unknown>> {
  return {
    question: request.question,
    recipe: request.recipe ?? 'ask',
    analystIds: request.analystIds,
    analystProfileId: request.analystProfileId,
    analystProfileDigest: request.analystProfileDigest,
    budgetUsd: request.budgetUsd,
    totalTimeoutMs: request.totalTimeoutMs,
  }
}

export function prepareAnalysisRequest(
  host: AnalysisApplicationHost,
  request: AnalysisRequest,
): PreparedAnalysisRequest {
  const evidence = freezeAnalysisSource({
    ...request,
    state: host.currentState(),
    events: host.eventHistory(),
  })
  return {
    evidence,
    identity: analysisIdentity({
      kind: 'analysis',
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      sourceDigests: [String(evidence.source.digest)],
      request: requestForDigest(request),
    }),
  }
}
