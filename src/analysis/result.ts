import type { ExactAnalystRunResult } from '@tangle-network/agent-eval'

import { canonicalDigest } from '../domain/canonical.js'
import { analystIdForKind } from './analysts.js'
import type { CitationValidation } from './citations.js'
import {
  type AnalysisError,
  type AnalysisProgress,
  type AnalysisRecord,
  type AnalysisRequest,
  AnalysisServiceError,
  type AnalysisTelemetry,
} from './model.js'
import { toJsonValue } from './serialization.js'
import { AnalysisSourceCaptureError, type FrozenAnalysisSourceHandle } from './source.js'
import { diagnosticFor, sanitizeRegistryValue } from './diagnostics.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function failureCode(error: unknown, aborted: boolean): AnalysisError['code'] {
  if (aborted || isAbortError(error)) return 'CANCELLED'
  if (error instanceof AnalysisSourceCaptureError) return error.code
  if (error instanceof AnalysisServiceError) return error.code
  if (errorMessage(error).includes('source changed')) return 'SOURCE_CHANGED'
  return 'UNKNOWN'
}

export function telemetryFor(result: ExactAnalystRunResult): AnalysisTelemetry {
  const raw = result as ExactAnalystRunResult
  const values = raw.per_analyst
  const known = (value: number | null | undefined): value is number =>
    value !== null && value !== undefined && Number.isFinite(value)
  const sum = (items: readonly (number | null | undefined)[]): number | null =>
    items.length > 0 && items.every(known) ? items.reduce((total, value) => total + value, 0) : null
  const rows = Object.fromEntries(values.map((item) => [item.analyst_id, toJsonValue(item)]))
  const inputTokens = sum(values.map((item) => item.usage.tokens?.input ?? null))
  const outputTokens = sum(values.map((item) => item.usage.tokens?.output ?? null))
  const totalTokens =
    inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens
  const calls = sum(values.map((item) => item.usage.calls))
  const latencyMs = values.length === 0 ? null : sum(values.map((item) => item.latency_ms))
  const costUnknown = raw.total_cost_provenance?.kind === 'uncaptured'
  return {
    totalCostUsd: costUnknown || !raw.total_cost_provenance ? null : raw.total_cost_usd,
    costProvenance: raw.total_cost_provenance ? toJsonValue(raw.total_cost_provenance) : null,
    latencyMs,
    calls,
    inputTokens,
    outputTokens,
    totalTokens,
    perAnalyst: rows,
  }
}

export function completeAnalysisRecord(input: {
  readonly request: AnalysisRequest
  readonly source: FrozenAnalysisSourceHandle
  readonly analystIds: readonly string[]
  readonly result: ExactAnalystRunResult
  readonly citations: CitationValidation
  readonly progress: readonly AnalysisProgress[]
  readonly startedAt: string
  readonly endedAt: string
}): AnalysisRecord {
  const { request, source, analystIds, result, citations } = input
  if (!source.source.complete || source.source.completeness === 'failed')
    throw new AnalysisServiceError(
      'SOURCE_INCOMPLETE',
      'A complete analysis cannot be built from an incomplete source',
    )
  if (source.source.completeness !== undefined && source.source.completeness !== 'complete')
    throw new AnalysisServiceError(
      'SOURCE_INCOMPLETE',
      'A complete analysis requires an explicitly complete source',
    )
  if (result.completion.status !== 'complete')
    throw new AnalysisServiceError(
      'ANALYST_FAILED',
      'A complete analysis requires a complete analyst run',
    )
  if (result.per_analyst.some((analyst) => analyst.status !== 'ok'))
    throw new AnalysisServiceError(
      'ANALYST_FAILED',
      'A complete analysis cannot contain a failed analyst',
    )
  if (!citations.valid)
    throw new AnalysisServiceError(
      'CITATION_UNRESOLVED',
      'A complete analysis requires valid citations',
    )
  return {
    analysisId: request.analysisId,
    operationId: request.operationId,
    sourceId: source.source.sourceId,
    sourceDigest: source.source.digest,
    source: source.source,
    kind: request.kind,
    ...(request.question ? { question: request.question } : {}),
    analystIds,
    budget: request.budget ?? null,
    registryRun: sanitizeRegistryValue(result),
    telemetry: telemetryFor(result),
    findings: result.findings,
    citations,
    progress: [...input.progress, { type: 'persisted', at: input.endedAt }],
    status: 'complete',
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  }
}

export function failedAnalysisRecord(input: {
  readonly request: AnalysisRequest
  readonly source: FrozenAnalysisSourceHandle | undefined
  readonly progress: readonly AnalysisProgress[]
  readonly code: AnalysisError['code']
  readonly error: unknown
  readonly failedAt: string
  readonly startedAt: string
  readonly endedAt: string
}): AnalysisRecord {
  const diagnostic = diagnosticFor(input.error, input.code)
  const { request, source, progress, code } = input
  return {
    analysisId: request.analysisId,
    operationId: request.operationId,
    sourceId: request.sourceId,
    sourceDigest: source?.source.digest ?? 'unavailable',
    source: source?.source ?? null,
    kind: request.kind,
    ...(request.question ? { question: request.question } : {}),
    analystIds: request.analystIds ?? [analystIdForKind(request.kind)],
    budget: request.budget ?? null,
    findings: [],
    citations: null,
    progress: [
      ...progress,
      { type: 'failed', code, message: diagnostic.message, at: input.failedAt },
    ],
    status:
      code === 'CANCELLED'
        ? 'cancelled'
        : code === 'OPERATION_UNKNOWN'
          ? 'unknown'
          : code === 'SOURCE_INCOMPLETE'
            ? 'partial'
            : 'failed',
    error: {
      code,
      message: diagnostic.message,
      ...(diagnostic.details ? { details: diagnostic.details } : {}),
    },
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  }
}

export function unknownAnalysisRecord(
  request: AnalysisRequest,
  message: string,
  now: string,
): AnalysisRecord {
  const safeMessage = diagnosticFor({ message }, 'OPERATION_UNKNOWN').message
  return {
    analysisId: request.analysisId,
    operationId: request.operationId,
    sourceId: request.sourceId,
    sourceDigest: 'unavailable',
    source: null,
    kind: request.kind,
    ...(request.question ? { question: request.question } : {}),
    analystIds: request.analystIds ?? [analystIdForKind(request.kind)],
    budget: request.budget ?? null,
    findings: [],
    citations: null,
    progress: [{ type: 'failed', code: 'OPERATION_UNKNOWN', message: safeMessage, at: now }],
    status: 'unknown',
    error: { code: 'OPERATION_UNKNOWN', message: safeMessage },
    startedAt: now,
    endedAt: now,
  }
}

export function analysisDigest(record: AnalysisRecord): string {
  return `sha256:${canonicalDigest({ analysisId: record.analysisId, sourceDigest: record.sourceDigest, analystIds: record.analystIds, findings: record.findings, telemetry: record.telemetry ?? null, status: record.status })}`
}
