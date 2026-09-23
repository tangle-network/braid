import type { AnalysisRecord } from '../analysis/model.js'
import {
  runW11Evaluation,
  type W11EvaluationInput,
  type W11EvaluationResult,
  type W11Judge,
} from '../evaluation/w11-runner.js'

export interface FrozenApplicationAnalysisIdentity {
  readonly analysisId: string
  readonly operationId: string
  readonly sourceId: string
  readonly sourceDigest: string
  readonly sourceRevision: string
  readonly conversationId: string
  readonly branchId: string
  readonly runId: string
  readonly runtime: string
  readonly profileDigest: string
  readonly model: string
  readonly receiptId: string
}

export interface ApplicationEvaluationInput extends W11EvaluationInput {
  readonly analysisId: string
  readonly operationId: string
  readonly sourceId: string
  readonly sourceDigest: string
  readonly sourceRevision: string
  readonly conversationId: string
  readonly branchId: string
  readonly runId: string
  readonly runtime: string
  readonly profileDigest: string
  readonly model: string
  readonly receiptId: string
}

export interface ApplicationEvaluationResult {
  readonly identity: FrozenApplicationAnalysisIdentity
  readonly evaluation: W11EvaluationResult
}

function identityFor(record: AnalysisRecord): FrozenApplicationAnalysisIdentity {
  if (record.status !== 'complete' || !record.source)
    throw new Error('Evaluation requires a complete application analysis')
  const source = record.source
  if (!source.runtime || !source.receiptId)
    throw new Error('Evaluation source is missing runtime or receipt identity')
  return {
    analysisId: record.analysisId,
    operationId: record.operationId,
    sourceId: source.sourceId,
    sourceDigest: source.digest,
    sourceRevision: source.sourceRevision,
    conversationId: source.conversationId,
    branchId: source.branchId,
    runId: source.runId,
    runtime: source.runtime,
    profileDigest: source.profileDigest,
    model: source.model,
    receiptId: source.receiptId,
  }
}

function assertInputIdentity(
  input: ApplicationEvaluationInput,
  identity: FrozenApplicationAnalysisIdentity,
): void {
  const fields: readonly (keyof FrozenApplicationAnalysisIdentity)[] = [
    'analysisId',
    'operationId',
    'sourceId',
    'sourceDigest',
    'sourceRevision',
    'conversationId',
    'branchId',
    'runId',
    'runtime',
    'profileDigest',
    'model',
    'receiptId',
  ]
  for (const field of fields) {
    if (input[field] !== identity[field])
      throw new Error(`Evaluation input is not bound to ${field}`)
  }
}

export async function evaluateApplicationAnalysis(input: {
  readonly record: AnalysisRecord
  readonly judge: W11Judge
  readonly evaluationInputs: readonly ApplicationEvaluationInput[]
}): Promise<ApplicationEvaluationResult> {
  const identity = identityFor(input.record)
  for (const evaluationInput of input.evaluationInputs)
    assertInputIdentity(evaluationInput, identity)
  return {
    identity,
    evaluation: await runW11Evaluation(input.judge, input.evaluationInputs),
  }
}
