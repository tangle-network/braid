import type {
  AnalystRegistry,
  AnalystRunInputs,
  ExactAnalystBudgetPolicy,
  ExactAnalystRunResult,
  ExactRegistryRunOpts,
} from '@tangle-network/agent-eval'

import { analystIdForKind } from './analysts.js'
import { ANALYSIS_KINDS, MAX_QUESTION_LENGTH } from './commands.js'
import {
  type AnalysisBudget,
  type AnalysisProgress,
  type AnalysisRequest,
  AnalysisServiceError,
  type JsonObject,
} from './model.js'
import type { FrozenAnalysisSourceHandle } from './source.js'
import { sanitizeDiagnosticText, sanitizeRegistryValue } from './diagnostics.js'

export function exactBudget(
  budget: AnalysisBudget | undefined,
  analystIds: readonly string[],
): ExactAnalystBudgetPolicy | null {
  if (!budget) return null
  if (!Number.isFinite(budget.totalUsd) || budget.totalUsd < 0)
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      'The analyst budget must be finite and non-negative',
    )
  if (budget.weights !== undefined) {
    if (
      typeof budget.weights !== 'object' ||
      budget.weights === null ||
      Array.isArray(budget.weights)
    )
      throw new AnalysisServiceError('INVALID_REQUEST', 'Analyst weights must be an object')
    const keys = Object.keys(budget.weights).sort()
    const expected = [...analystIds].sort()
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
      throw new AnalysisServiceError(
        'INVALID_REQUEST',
        'Weighted budgets must name exactly the selected analysts',
      )
    const weights = Object.values(budget.weights)
    if (
      weights.some((weight) => !Number.isFinite(weight) || weight < 0) ||
      weights.every((w) => w === 0)
    )
      throw new AnalysisServiceError(
        'INVALID_REQUEST',
        'Analyst weights must be finite and include a positive weight',
      )
    return { kind: 'weighted', totalUsd: budget.totalUsd, weights: budget.weights }
  }
  if (analystIds.length === 0) throw new Error('An analyst budget requires at least one analyst')
  return { kind: 'equal', totalUsd: budget.totalUsd }
}

const RESERVED_TAGS = new Set([
  'source_id',
  'source_digest',
  'source_revision',
  'captured_at',
  'question',
])

function isReservedTag(key: string): boolean {
  return RESERVED_TAGS.has(key.toLowerCase())
}

export function validateAnalysisRequest(
  request: AnalysisRequest,
  registry: AnalystRegistry,
): readonly string[] {
  if (!request.operationId || !request.analysisId || !request.sourceId)
    throw new AnalysisServiceError('INVALID_REQUEST', 'Analysis identifiers must be non-empty')
  if (!ANALYSIS_KINDS.includes(request.kind))
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      `Unknown analysis kind: ${String(request.kind)}`,
    )
  if (
    request.question !== undefined &&
    (typeof request.question !== 'string' || request.question.length > MAX_QUESTION_LENGTH)
  )
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      `The analysis question may be at most ${MAX_QUESTION_LENGTH} characters`,
    )
  if (
    request.timeoutMs !== undefined &&
    (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)
  )
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      'Analysis timeout must be a positive safe integer',
    )
  const analystIds = request.analystIds ?? [analystIdForKind(request.kind)]
  if (
    !Array.isArray(analystIds) ||
    analystIds.length === 0 ||
    analystIds.some((analystId) => typeof analystId !== 'string' || analystId.length === 0) ||
    new Set(analystIds).size !== analystIds.length
  )
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      'Analysis analyst selection must be non-empty and unique',
    )
  const available = new Set(registry.list().map((analyst) => analyst.id))
  const missing = analystIds.filter((analystId) => !available.has(analystId))
  if (missing.length > 0)
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      `Unknown analyst selection: ${missing.join(', ')}`,
    )
  if (
    request.tags &&
    (typeof request.tags !== 'object' ||
      Array.isArray(request.tags) ||
      Object.keys(request.tags).some(isReservedTag))
  )
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      'Caller tags cannot set source provenance or question',
    )
  if (
    request.tags &&
    Object.entries(request.tags).some(
      ([key, value]) => key.length === 0 || typeof value !== 'string',
    )
  )
    throw new AnalysisServiceError(
      'INVALID_REQUEST',
      'Analysis tags must have non-empty names and string values',
    )
  exactBudget(request.budget, analystIds)
  return analystIds
}

export interface AnalysisDispatchInput {
  readonly request: AnalysisRequest
  readonly source: FrozenAnalysisSourceHandle
  readonly registry: AnalystRegistry
  readonly signal: AbortSignal
  readonly now: () => string
  readonly progress: AnalysisProgress[]
}

export interface AnalysisDispatchResult {
  readonly analystIds: readonly string[]
  readonly result: ExactAnalystRunResult
}

export async function dispatchAnalysis(
  input: AnalysisDispatchInput,
): Promise<AnalysisDispatchResult> {
  const { request, source, registry, signal, now, progress } = input
  const analystIds = validateAnalysisRequest(request, registry)
  const inputs: AnalystRunInputs = { traceStore: source.traceStore }
  const options: ExactRegistryRunOpts = {
    analystIds,
    budget: exactBudget(request.budget, analystIds),
    totalTimeoutMs: request.timeoutMs ?? null,
    signal,
    costLedger: null,
    costLedgerIdentity: null,
    costPhase: null,
    tags: {
      ...(request.tags ?? {}),
      source_id: source.source.sourceId,
      source_digest: source.source.digest,
      source_revision: source.source.sourceRevision,
      captured_at: source.source.capturedAt,
      question: request.question ?? `Analyze the ${request.kind} request.`,
    },
    priorFindings: null,
    chainFindings: false,
    missingInputMode: 'abort',
    applyRegistryHooks: false,
    useRegistryChat: false,
  }
  let result: ExactAnalystRunResult | undefined
  for await (const event of registry.runExactStream(request.analysisId, inputs, options)) {
    const safeEvent = sanitizeRegistryValue(event) as typeof event
    progress.push({ type: safeEvent.type, event: safeEvent, at: now() } as AnalysisProgress)
    if (safeEvent.type === 'run-completed') result = safeEvent.result
  }
  if (!result)
    throw new AnalysisServiceError('ANALYST_FAILED', 'The analyst stream ended without a result')
  if (result.completion.status !== 'complete') {
    if (signal.aborted) throw new DOMException('Analysis cancelled', 'AbortError')
    const message =
      result.completion.status === 'failed'
        ? sanitizeDiagnosticText(result.completion.error.message)
        : 'The analyst stream ended with an unconfirmed completion state'
    throw new AnalysisServiceError(
      'ANALYST_FAILED',
      message,
      result.completion.status === 'failed'
        ? (sanitizeRegistryValue(result.completion.error) as JsonObject)
        : undefined,
    )
  }
  const failed = result.per_analyst.filter((analyst) => analyst.status !== 'ok')
  if (failed.length > 0)
    throw new AnalysisServiceError(
      'ANALYST_FAILED',
      `One or more analysts did not complete: ${failed.map((analyst) => analyst.analyst_id).join(', ')}`,
      { analysts: sanitizeRegistryValue(failed) as unknown as JsonObject },
    )
  return { analystIds, result: sanitizeRegistryValue(result) }
}
