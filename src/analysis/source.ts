import type { TraceAnalysisStore, TraceAnalystSpan } from '@tangle-network/agent-eval'

import { canonicalDigest } from '../domain/canonical.js'
import { ANALYSIS_LIMITS } from './bounded-copy.js'

export interface SourceEventReference {
  readonly eventId: string
  readonly kind: string
  readonly excerpt?: string
}

export interface SourceTraceReference {
  readonly traceId: string
  readonly spanIds: readonly string[]
}

/** JSON-safe metadata that can be exported or encrypted by Braid storage. */
export interface AnalysisSourceRecord {
  readonly sourceId: string
  readonly sourceRevision: string
  readonly conversationId: string
  readonly branchId: string
  readonly runId: string
  readonly profileDigest: string
  readonly runner: string
  readonly model: string
  readonly connection: string
  readonly eventIds: readonly string[]
  readonly traceReferences: readonly SourceTraceReference[]
  readonly eventReferences: readonly SourceEventReference[]
  readonly metrics: Readonly<Record<string, number | null>>
  readonly artifactUris: readonly string[]
  readonly capturedAt: string
  readonly complete: boolean
  readonly missingEventIds?: readonly string[]
  readonly completeness?: 'complete' | 'partial' | 'failed' | 'unknown'
  readonly runtime?: string
  readonly receiptId?: string
  readonly experimentId?: string
  readonly arm?: string
}

/** Transient capability used only while an analyst reads the frozen source. */
export interface AnalysisSourceBinding {
  readonly source: AnalysisSourceRecord
  readonly traceStore: TraceAnalysisStore
  /** Read the journal revision without materializing trace rows. */
  readonly currentRevision: (signal?: AbortSignal) => Promise<string>
  /**
   * The durable adapter must return metadata and rows from one journal
   * revision and the returned store must be an immutable snapshot for every
   * subsequent digest and analyst read.
   */
  readonly captureAtRevision: (
    signal?: AbortSignal,
  ) => Promise<{ readonly source: AnalysisSourceRecord; readonly traceStore: TraceAnalysisStore }>
}

/** Frozen metadata persisted with an analysis. It deliberately has no store handle. */
export interface FrozenAnalysisSource extends AnalysisSourceRecord {
  readonly digest: string
}

/** Transient source plus the exact store snapshot used by the analyst. */
export interface FrozenAnalysisSourceHandle {
  readonly source: FrozenAnalysisSource
  readonly traceStore: TraceAnalysisStore
}

export interface SourceVerification {
  readonly unchanged: boolean
  readonly currentDigest: string
  readonly currentRevision: string
}

export interface SourceReplayVerification {
  readonly complete: boolean
  readonly sourceRevision: string
  readonly eventIds: readonly string[]
  readonly missingEventIds: readonly string[]
}

export class AnalysisSourceCaptureError extends Error {
  readonly code = 'SOURCE_INCOMPLETE' as const

  constructor(message: string) {
    super(message)
    this.name = 'AnalysisSourceCaptureError'
  }
}

export function validateSourceRecord(source: AnalysisSourceRecord): void {
  if (!source || typeof source !== 'object')
    throw new AnalysisSourceCaptureError('Analysis source shape is invalid')
  const strings = [
    source.sourceId,
    source.sourceRevision,
    source.conversationId,
    source.branchId,
    source.runId,
    source.profileDigest,
    source.runner,
    source.model,
    source.connection,
    source.capturedAt,
  ]
  if (strings.some((value) => typeof value !== 'string' || value.length === 0))
    throw new AnalysisSourceCaptureError('Analysis source identity is invalid')
  if (
    typeof source.complete !== 'boolean' ||
    !Array.isArray(source.eventIds) ||
    !Array.isArray(source.traceReferences) ||
    !Array.isArray(source.eventReferences) ||
    !Array.isArray(source.artifactUris)
  )
    throw new AnalysisSourceCaptureError('Analysis source shape is invalid')
  if (source.missingEventIds !== undefined && !Array.isArray(source.missingEventIds))
    throw new AnalysisSourceCaptureError('Analysis source missing event IDs are invalid')
  const missing = [...new Set(source.missingEventIds ?? [])]
  if (missing.some((eventId) => typeof eventId !== 'string' || eventId.length === 0))
    throw new AnalysisSourceCaptureError('Analysis source missing event IDs are invalid')
  if (source.complete && missing.length > 0)
    throw new AnalysisSourceCaptureError('A complete source cannot contain missing event IDs')
  if (missing.some((eventId) => source.eventIds.includes(eventId)))
    throw new AnalysisSourceCaptureError(
      'An event cannot be both present and missing in an analysis source',
    )
  if (
    source.completeness !== undefined &&
    !['complete', 'partial', 'failed', 'unknown'].includes(source.completeness)
  )
    throw new AnalysisSourceCaptureError('Analysis source completeness state is invalid')
  if (missing.length !== (source.missingEventIds?.length ?? 0))
    throw new AnalysisSourceCaptureError('Analysis source contains duplicate missing event IDs')
  if (source.completeness === 'complete' && !source.complete)
    throw new AnalysisSourceCaptureError(
      'An incomplete source cannot have complete completeness state',
    )
  if (source.eventIds.length > ANALYSIS_LIMITS.maxItems)
    throw new AnalysisSourceCaptureError('Analysis source event limit exceeded')
  if (source.eventIds.some((eventId) => typeof eventId !== 'string' || eventId.length === 0))
    throw new AnalysisSourceCaptureError('Analysis source event IDs are invalid')
  if (new Set(source.eventIds).size !== source.eventIds.length)
    throw new AnalysisSourceCaptureError('Analysis source contains duplicate event IDs')
  if (source.eventReferences.length > ANALYSIS_LIMITS.maxItems)
    throw new AnalysisSourceCaptureError('Analysis source event reference limit exceeded')
  if (
    source.eventReferences.some(
      (reference) =>
        !reference ||
        typeof reference.eventId !== 'string' ||
        reference.eventId.length === 0 ||
        typeof reference.kind !== 'string' ||
        reference.kind.length === 0 ||
        (reference.excerpt !== undefined && typeof reference.excerpt !== 'string'),
    )
  )
    throw new AnalysisSourceCaptureError('Analysis source event references are invalid')
  const eventReferenceIds = source.eventReferences.map((reference) => reference.eventId)
  if (new Set(eventReferenceIds).size !== eventReferenceIds.length)
    throw new AnalysisSourceCaptureError('Analysis source contains duplicate event references')
  if (
    eventReferenceIds.length !== source.eventIds.length ||
    source.eventIds.some((eventId) => !eventReferenceIds.includes(eventId))
  )
    throw new AnalysisSourceCaptureError(
      'Analysis source event IDs and event references do not describe the same range',
    )
  if (source.traceReferences.length > ANALYSIS_LIMITS.maxTraces)
    throw new AnalysisSourceCaptureError('Analysis source trace limit exceeded')
  if (
    source.traceReferences.some(
      (trace) =>
        !trace ||
        typeof trace.traceId !== 'string' ||
        trace.traceId.length === 0 ||
        !Array.isArray(trace.spanIds) ||
        trace.spanIds.some((spanId: unknown) => typeof spanId !== 'string' || spanId.length === 0),
    )
  )
    throw new AnalysisSourceCaptureError('Analysis source trace references are invalid')
  const spanCount = source.traceReferences.reduce((total, trace) => total + trace.spanIds.length, 0)
  if (spanCount > ANALYSIS_LIMITS.maxSpans)
    throw new AnalysisSourceCaptureError('Analysis source span limit exceeded')
  for (const trace of source.traceReferences) {
    if (new Set(trace.spanIds).size !== trace.spanIds.length)
      throw new AnalysisSourceCaptureError('Analysis source contains duplicate span IDs')
  }
  if (source.artifactUris.length > ANALYSIS_LIMITS.maxItems)
    throw new AnalysisSourceCaptureError('Analysis source artifact limit exceeded')
  if (source.artifactUris.some((uri) => typeof uri !== 'string' || uri.length === 0))
    throw new AnalysisSourceCaptureError('Analysis source artifact URIs are invalid')
  if (
    !source.metrics ||
    typeof source.metrics !== 'object' ||
    Array.isArray(source.metrics) ||
    Object.values(source.metrics).some(
      (value) => value !== null && (typeof value !== 'number' || !Number.isFinite(value)),
    )
  )
    throw new AnalysisSourceCaptureError('Analysis source metrics are invalid')
  for (const value of [source.runtime, source.receiptId, source.experimentId, source.arm]) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0))
      throw new AnalysisSourceCaptureError('Analysis source optional identity is invalid')
  }
  if (source.complete && source.completeness && source.completeness !== 'complete')
    throw new AnalysisSourceCaptureError('A complete source must have complete completeness state')
}

export interface AnalysisSourcePort {
  freeze(sourceId: string, signal?: AbortSignal): Promise<FrozenAnalysisSourceHandle>
  verify(handle: FrozenAnalysisSourceHandle): Promise<SourceVerification>
  currentDigest(sourceId: string): Promise<string>
  /** Replay the frozen event range before any source-affecting promotion. */
  replay(handle: FrozenAnalysisSourceHandle): Promise<SourceReplayVerification>
}

export interface MutableAnalysisSourcePort extends AnalysisSourcePort {
  replace(binding: AnalysisSourceBinding): void
}

/**
 * Capture metadata is excluded from the digest: the digest identifies frozen
 * *content*, so re-reading the same journal revision at a later instant must
 * produce the same digest instead of a false source change.
 */
export function digestMaterial(
  source: AnalysisSourceRecord,
): Omit<AnalysisSourceRecord, 'capturedAt'> {
  const { capturedAt: _capturedAt, ...content } = source
  return content
}

export async function sourceDigest(
  source: AnalysisSourceRecord,
  traceStore: TraceAnalysisStore,
  signal?: AbortSignal,
): Promise<string> {
  validateSourceRecord(source)
  const traces: Array<{ readonly traceId: string; readonly spans: readonly TraceAnalystSpan[] }> =
    []
  for (const reference of source.traceReferences) {
    const result = await traceStore.viewSpans(
      { trace_id: reference.traceId, span_ids: reference.spanIds },
      signal ? { signal } : undefined,
    )
    const expected = new Set(reference.spanIds)
    const spans = result.spans.filter(
      (span) => span.trace_id === reference.traceId && expected.has(span.span_id),
    )
    if (result.missing_span_ids.length > 0 || spans.length !== expected.size)
      throw new AnalysisSourceCaptureError(
        `Analysis source is missing spans: ${reference.traceId}:${result.missing_span_ids.join(',')}`,
      )
    traces.push({ traceId: reference.traceId, spans })
  }
  return `sha256:${canonicalDigest({ source: digestMaterial(source), traces })}`
}

export function spanFromStoreResult(
  result: { spans: readonly TraceAnalystSpan[] },
  spanId: string,
): TraceAnalystSpan | undefined {
  return result.spans.find((span) => span.span_id === spanId)
}

export { artifactUri, eventUri, metricUri, traceSpanUri } from './source-uris.js'
export { InMemoryAnalysisSourcePort } from './source-port.js'
