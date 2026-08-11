import { analysisExecutionTargetFromState } from './analysis-execution-target.js'
import { type AnalysisIdentity, analysisIdentity } from './analysis-operation.js'
import { loadFrozenAnalysisSource } from './analysis-source.js'
import type {
  AnalysisApplicationHost,
  AnalysisExecutionTarget,
  AnalysisRequest,
  FrozenAnalysisEvidence,
} from './analysis-types.js'

export interface PreparedAnalysisRequest {
  readonly evidence: FrozenAnalysisEvidence
  readonly executionTarget: AnalysisExecutionTarget
  readonly identity: AnalysisIdentity
}

function requestForDigest(
  request: AnalysisRequest,
  executionTarget: AnalysisExecutionTarget,
): Readonly<Record<string, unknown>> {
  return {
    question: request.question,
    recipe: request.recipe ?? 'ask',
    analystIds: request.analystIds,
    analystProfileId: request.analystProfileId,
    analystProfileDigest: request.analystProfileDigest,
    budgetUsd: request.budgetUsd,
    totalTimeoutMs: request.totalTimeoutMs,
    executionTarget: {
      profileId: executionTarget.profileId,
      profileDigest: executionTarget.profileDigest,
      connectionId: executionTarget.connectionId,
      connectionDigest: executionTarget.connectionDigest,
      model: executionTarget.model,
      runner: executionTarget.runner,
    },
  }
}

export async function prepareAnalysisRequest(
  host: AnalysisApplicationHost,
  request: AnalysisRequest,
): Promise<PreparedAnalysisRequest> {
  const state = host.currentState()
  const executionTarget =
    host.analysisExecutionTarget?.(state) ?? analysisExecutionTargetFromState(state)
  const evidence = await loadFrozenAnalysisSource(host, state, request)
  return {
    evidence,
    executionTarget,
    identity: analysisIdentity({
      kind: 'analysis',
      ...(request.operationId === undefined ? {} : { operationId: request.operationId }),
      sourceDigests: [String(evidence.source.digest)],
      request: requestForDigest(request, executionTarget),
    }),
  }
}
