import type { TraceAnalysisStore } from '@tangle-network/agent-eval'
import { AnalysisSourceCaptureError, type SourceTraceReference } from './source.js'
import { ANALYSIS_LIMITS } from './bounded-copy.js'
import { FrozenTraceStore, type FrozenTrace } from './frozen-trace-store.js'
import { assertTraceId, isBoundedSpanId } from './trace-validation.js'

/** Materializes the exact referenced rows from a live trace store. */
export async function snapshotTraceStore(
  store: TraceAnalysisStore,
  references: readonly SourceTraceReference[],
  signal?: AbortSignal,
): Promise<FrozenTraceStore> {
  if (!Array.isArray(references) || references.length > ANALYSIS_LIMITS.maxTraces)
    throw new AnalysisSourceCaptureError('Frozen trace count exceeds its limit')
  let requestedSpans = 0
  for (const reference of references) {
    assertTraceReference(reference)
    requestedSpans += reference.spanIds.length
    if (requestedSpans > ANALYSIS_LIMITS.maxSpans)
      throw new AnalysisSourceCaptureError('Frozen span count exceeds its limit')
  }
  const context = signal ? { signal } : undefined
  const traces: FrozenTrace[] = []
  for (const reference of references) {
    const result = await store.viewSpans(
      { trace_id: reference.traceId, span_ids: reference.spanIds },
      context,
    )
    if (
      result.spans.length > ANALYSIS_LIMITS.maxSpans ||
      result.missing_span_ids.length > ANALYSIS_LIMITS.maxItems
    )
      throw new AnalysisSourceCaptureError('Frozen trace response exceeds its limits')
    const expected = new Set(reference.spanIds)
    const spans = result.spans.filter(
      (span) => span.trace_id === reference.traceId && expected.has(span.span_id),
    )
    if (result.missing_span_ids.length > 0 || spans.length !== expected.size)
      throw new AnalysisSourceCaptureError(
        `Frozen source is missing spans: ${reference.traceId}:${result.missing_span_ids.join(',')}`,
      )
    traces.push({ traceId: reference.traceId, spans })
  }
  return new FrozenTraceStore(traces)
}

function assertTraceReference(reference: SourceTraceReference): void {
  assertTraceId(reference.traceId)
  if (
    !Array.isArray(reference.spanIds) ||
    reference.spanIds.length > ANALYSIS_LIMITS.maxSpans ||
    new Set(reference.spanIds).size !== reference.spanIds.length ||
    reference.spanIds.some((spanId) => !isBoundedSpanId(spanId))
  )
    throw new AnalysisSourceCaptureError('Frozen source reference exceeds its limit')
}
