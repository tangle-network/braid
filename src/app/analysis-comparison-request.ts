import type { JsonValue } from '../domain/entities-base.js'
import type {
  CompareAnalysisInput,
  PreparedComparisonRequest,
} from './analysis-comparison-contracts.js'
import { analysisIdentity } from './analysis-operation.js'
import { freezeAnalysisSource } from './analysis-source.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

function persistedSourceRequest(
  source: CompareAnalysisInput['baseline'],
): Readonly<Record<string, JsonValue>> {
  return {
    ...(source.conversationId === undefined ? {} : { conversationId: source.conversationId }),
    ...(source.branchId === undefined ? {} : { branchId: source.branchId }),
    ...(source.runId === undefined ? {} : { runId: source.runId }),
    ...(source.throughMessageId === undefined ? {} : { throughMessageId: source.throughMessageId }),
  }
}

export function persistedComparisonRequest(input: CompareAnalysisInput): JsonValue {
  return {
    baseline: persistedSourceRequest(input.baseline),
    candidate: persistedSourceRequest(input.candidate),
    ...(input.metricNames === undefined ? {} : { metricNames: [...input.metricNames] }),
    ...(input.bootstrapSeed === undefined ? {} : { bootstrapSeed: input.bootstrapSeed }),
  }
}

export function prepareComparisonRequest(
  host: AnalysisApplicationHost,
  input: CompareAnalysisInput,
): PreparedComparisonRequest {
  const state = host.currentState()
  const events = host.eventHistory()
  const baseline = freezeAnalysisSource({ ...input.baseline, state, events })
  const candidate = freezeAnalysisSource({ ...input.candidate, state, events })
  const request = persistedComparisonRequest(input)
  return {
    baseline,
    candidate,
    identity: analysisIdentity({
      kind: 'comparison',
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      sourceDigests: [String(baseline.source.digest), String(candidate.source.digest)],
      request,
    }),
  }
}
