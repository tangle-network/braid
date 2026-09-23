import { AnalysisSourceCaptureError } from './source.js'
import { ANALYSIS_LIMITS, byteLength } from './bounded-copy.js'

export function assertTraceId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    byteLength(value) > ANALYSIS_LIMITS.maxStringBytes
  )
    throw new AnalysisSourceCaptureError('Frozen trace identity exceeds its limit')
}

export function assertSpanId(value: unknown): asserts value is string {
  if (!isBoundedSpanId(value))
    throw new AnalysisSourceCaptureError('Frozen span identity exceeds its limit')
}

export function isBoundedSpanId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    byteLength(value) <= ANALYSIS_LIMITS.maxStringBytes
  )
}

export function assertPage(limit: number, offset: number | undefined): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > ANALYSIS_LIMITS.maxItems ||
    (offset !== undefined &&
      (!Number.isSafeInteger(offset) || offset < 0 || offset > ANALYSIS_LIMITS.maxItems))
  )
    throw new AnalysisSourceCaptureError('Frozen trace page exceeds its limit')
}

export function assertSpanQuery(input: {
  readonly trace_id: string
  readonly span_ids: readonly string[]
}): void {
  assertTraceId(input.trace_id)
  if (
    !Array.isArray(input.span_ids) ||
    input.span_ids.length > ANALYSIS_LIMITS.maxSpans ||
    new Set(input.span_ids).size !== input.span_ids.length ||
    input.span_ids.some((spanId) => !isBoundedSpanId(spanId))
  )
    throw new AnalysisSourceCaptureError('Frozen span query exceeds its limit')
}
