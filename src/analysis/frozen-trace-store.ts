import type {
  DatasetOverview,
  QueryTracesPage,
  SearchSpanResult,
  SearchTraceResult,
  TraceAnalysisStore,
  TraceAnalystFilters,
  TraceAnalystSpan,
  TraceAnalystTraceSummary,
  ViewSpansResult,
  ViewTraceResult,
} from '@tangle-network/agent-eval'

import {
  boundedMatchLimit,
  boundedSearchText,
  compileEvidencePattern,
  SearchDeadline,
} from './evidence-pattern.js'
import { AnalysisSourceCaptureError } from './source.js'
import { ANALYSIS_LIMITS, boundedCloneAndFreeze, byteLength } from './bounded-copy.js'
import { assertPage, assertSpanId, assertSpanQuery, assertTraceId } from './trace-validation.js'

export interface FrozenTrace {
  readonly traceId: string
  readonly spans: readonly TraceAnalystSpan[]
}

const EPOCH = new Date(0).toISOString()

function summary(trace: FrozenTrace): TraceAnalystTraceSummary {
  const spans = trace.spans
  const first = spans.map((span) => span.start_time).sort()[0]
  const last = spans
    .map((span) => span.end_time)
    .sort()
    .at(-1)
  return {
    trace_id: trace.traceId,
    service_name: spans[0]?.service_name ?? null,
    agent_name: spans[0]?.agent_name ?? null,
    span_count: spans.length,
    has_errors: spans.some((span) => span.status === 'ERROR'),
    start_time: first ?? EPOCH,
    end_time: last ?? EPOCH,
    duration_ms: spans.reduce((total, span) => total + span.duration_ms, 0),
    raw_jsonl_bytes: JSON.stringify(spans).length,
    models: [
      ...new Set(spans.map((span) => span.model_name).filter((name): name is string => !!name)),
    ],
    tools: [
      ...new Set(spans.map((span) => span.tool_name).filter((name): name is string => !!name)),
    ],
  }
}

function frozenRead<T>(value: T): T {
  return boundedCloneAndFreeze(value)
}

function normalizeError(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8,}\b/giu, '<hex>')
    .replace(/\b\d+\b/gu, '<n>')
    .replace(/\/[^ ]+/gu, '<path>')
}

function matchesFilters(trace: FrozenTrace, filters?: TraceAnalystFilters): boolean {
  if (!filters) return true
  const item = summary(trace)
  if (filters.has_errors !== undefined && item.has_errors !== filters.has_errors) return false
  if (
    filters.service_names &&
    !trace.spans.some(
      (span) => span.service_name && filters.service_names?.includes(span.service_name),
    )
  )
    return false
  if (
    filters.agent_names &&
    !trace.spans.some((span) => span.agent_name && filters.agent_names?.includes(span.agent_name))
  )
    return false
  if (
    filters.model_names &&
    !trace.spans.some((span) => span.model_name && filters.model_names?.includes(span.model_name))
  )
    return false
  if (
    filters.tool_names &&
    !trace.spans.some((span) => span.tool_name && filters.tool_names?.includes(span.tool_name))
  )
    return false
  if (filters.start_time_after && item.start_time <= filters.start_time_after) return false
  if (filters.start_time_before && item.start_time >= filters.start_time_before) return false
  if (filters.regex_pattern) {
    const pattern = compileEvidencePattern(filters.regex_pattern, 'u')
    if (!pattern.test(boundedSearchText(JSON.stringify(trace)))) return false
  }
  return true
}

/**
 * The immutable trace snapshot an analysis reads. Rows are copied and frozen at
 * construction, so every digest, analyst read, and citation check in one
 * analysis observes the same bytes even if the live source advances.
 */
export class FrozenTraceStore implements TraceAnalysisStore {
  readonly #traces: ReadonlyMap<string, FrozenTrace>
  readonly #now: () => number

  constructor(traces: readonly FrozenTrace[] = [], now: () => number = Date.now) {
    if (traces.length > ANALYSIS_LIMITS.maxTraces)
      throw new AnalysisSourceCaptureError('Frozen trace count exceeds its limit')
    const frozen = new Map<string, FrozenTrace>()
    let spanCount = 0
    let totalBytes = 0
    for (const trace of traces) {
      assertTraceId(trace.traceId)
      totalBytes += byteLength(trace.traceId)
      if (totalBytes > ANALYSIS_LIMITS.maxBytes)
        throw new AnalysisSourceCaptureError('Frozen trace bytes exceed its limit')
      if (frozen.has(trace.traceId))
        throw new AnalysisSourceCaptureError('Frozen trace identities must be unique')
      if (!Array.isArray(trace.spans))
        throw new AnalysisSourceCaptureError('Frozen trace spans must be an array')
      spanCount += trace.spans.length
      if (spanCount > ANALYSIS_LIMITS.maxSpans)
        throw new AnalysisSourceCaptureError('Frozen span count exceeds its limit')
      const spanIds = new Set<string>()
      for (const span of trace.spans) {
        if (
          span.trace_id !== trace.traceId ||
          !span.span_id ||
          byteLength(span.span_id) > ANALYSIS_LIMITS.maxStringBytes ||
          spanIds.has(span.span_id)
        )
          throw new AnalysisSourceCaptureError('Frozen trace span identities are invalid')
        spanIds.add(span.span_id)
      }
      const spans = Object.freeze(trace.spans.map((span) => boundedCloneAndFreeze(span)))
      totalBytes += spans.reduce((total, span) => total + byteLength(span), 0)
      if (totalBytes > ANALYSIS_LIMITS.maxBytes)
        throw new AnalysisSourceCaptureError('Frozen trace bytes exceed their limit')
      frozen.set(
        trace.traceId,
        Object.freeze({
          traceId: trace.traceId,
          spans,
        }),
      )
    }
    this.#traces = frozen
    this.#now = now
  }

  get traceIds(): readonly string[] {
    return Object.freeze([...this.#traces.keys()])
  }

  async hasTrace(trace_id: string): Promise<boolean> {
    assertTraceId(trace_id)
    return this.#traces.has(trace_id)
  }

  async hasSpans(input: { trace_id: string; span_ids: readonly string[] }): Promise<string[]> {
    assertSpanQuery(input)
    const trace = this.#traces.get(input.trace_id)
    const known = new Set(trace?.spans.map((span) => span.span_id) ?? [])
    return Object.freeze(
      input.span_ids.filter((spanId) => known.has(spanId)),
    ) as unknown as string[]
  }

  async getOverview(filters?: TraceAnalystFilters): Promise<DatasetOverview> {
    const traces = [...this.#traces.values()].filter((trace) => matchesFilters(trace, filters))
    const spans = traces.flatMap((trace) => trace.spans)
    const errorSpans = spans.filter((span) => span.status === 'ERROR')
    const clusters = new Map<
      string,
      { sample: TraceAnalystSpan; count: number; traces: Set<string>; spans: Set<string> }
    >()
    for (const span of errorSpans) {
      const signature = normalizeError(span.status_message ?? span.name)
      const cluster = clusters.get(signature) ?? {
        sample: span,
        count: 0,
        traces: new Set<string>(),
        spans: new Set<string>(),
      }
      cluster.count += 1
      cluster.traces.add(span.trace_id)
      cluster.spans.add(span.span_id)
      clusters.set(signature, cluster)
    }
    const ordered = [...clusters.entries()].sort((left, right) => right[1].count - left[1].count)
    const starts = traces.map((trace) => summary(trace).start_time).sort()
    const ends = traces
      .map((trace) => summary(trace).end_time)
      .sort()
      .at(-1)
    return frozenRead({
      total_traces: traces.length,
      raw_jsonl_bytes: JSON.stringify(traces).length,
      services: [
        ...new Set(spans.map((span) => span.service_name).filter((v): v is string => !!v)),
      ],
      agents: [...new Set(spans.map((span) => span.agent_name).filter((v): v is string => !!v))],
      models: [...new Set(spans.map((span) => span.model_name).filter((v): v is string => !!v))],
      tool_names: [...new Set(spans.map((span) => span.tool_name).filter((v): v is string => !!v))],
      sample_trace_ids: traces.slice(0, 20).map((trace) => trace.traceId),
      errors: {
        trace_count: new Set(errorSpans.map((span) => span.trace_id)).size,
        span_count: errorSpans.length,
      },
      error_clusters: ordered.map(([signature, cluster]) => ({
        signature,
        status_message_sample: cluster.sample.status_message ?? cluster.sample.name,
        span_name: cluster.sample.name,
        tool_name: cluster.sample.tool_name,
        trace_count: cluster.traces.size,
        span_count: cluster.count,
        prevalence: traces.length === 0 ? 0 : cluster.traces.size / traces.length,
        exemplar_trace_ids: [...cluster.traces].slice(0, 20),
        exemplar_span_ids: [...cluster.spans].slice(0, 20),
      })),
      time_range:
        traces.length === 0 ? null : { earliest: starts[0] ?? EPOCH, latest: ends ?? EPOCH },
    })
  }

  async queryTraces(input: {
    filters?: TraceAnalystFilters
    limit: number
    offset?: number
  }): Promise<QueryTracesPage> {
    assertPage(input.limit, input.offset)
    const traces = [...this.#traces.values()].filter((trace) =>
      matchesFilters(trace, input.filters),
    )
    const offset = input.offset ?? 0
    return frozenRead({
      traces: traces.slice(offset, offset + input.limit).map(summary),
      total: traces.length,
      has_more: offset + input.limit < traces.length,
    })
  }

  async countTraces(filters?: TraceAnalystFilters): Promise<number> {
    const traces = [...this.#traces.values()].filter((trace) => matchesFilters(trace, filters))
    return traces.length
  }

  async viewTrace(input: { trace_id: string }): Promise<ViewTraceResult> {
    assertTraceId(input.trace_id)
    const trace = this.#traces.get(input.trace_id)
    if (!trace) return frozenRead({ trace_id: input.trace_id, spans: [] })
    return frozenRead({
      trace_id: input.trace_id,
      spans: trace.spans.map((span) => boundedCloneAndFreeze(span)),
    })
  }

  async viewSpans(input: {
    trace_id: string
    span_ids: readonly string[]
  }): Promise<ViewSpansResult> {
    assertSpanQuery(input)
    const trace = this.#traces.get(input.trace_id)
    const spans = input.span_ids.flatMap(
      (spanId) => trace?.spans.filter((span) => span.span_id === spanId) ?? [],
    )
    const present = new Set(spans.map((span) => span.span_id))
    return frozenRead({
      trace_id: input.trace_id,
      spans: spans.map((span) => boundedCloneAndFreeze(span)),
      missing_span_ids: input.span_ids.filter((spanId) => !present.has(spanId)),
      omitted_span_ids: [],
      has_more: false,
      truncated_attribute_count: 0,
    })
  }

  async searchTrace(input: {
    trace_id: string
    regex_pattern: string
    max_matches?: number
  }): Promise<SearchTraceResult> {
    assertTraceId(input.trace_id)
    const limit = boundedMatchLimit(input.max_matches)
    const found = this.#matches(input.trace_id, input.regex_pattern, undefined, limit + 1)
    return frozenRead({
      trace_id: input.trace_id,
      hits: found.slice(0, limit),
      has_more: found.length > limit,
    })
  }

  /** The span filter is applied before the match limit so a cited span is never cut. */
  async searchSpan(input: {
    trace_id: string
    span_id: string
    regex_pattern: string
    max_matches?: number
  }): Promise<SearchSpanResult> {
    assertTraceId(input.trace_id)
    assertSpanId(input.span_id)
    const limit = boundedMatchLimit(input.max_matches)
    const found = this.#matches(input.trace_id, input.regex_pattern, input.span_id, limit + 1)
    return frozenRead({
      trace_id: input.trace_id,
      span_id: input.span_id,
      hits: found.slice(0, limit),
      has_more: found.length > limit,
    })
  }

  #matches(
    traceId: string,
    pattern: string,
    spanId: string | undefined,
    maxHits: number,
  ): SearchTraceResult['hits'] {
    const trace = this.#traces.get(traceId)
    const deadline = new SearchDeadline(this.#now())
    const hits: SearchTraceResult['hits'] = []
    for (const span of trace?.spans ?? []) {
      if (spanId !== undefined && span.span_id !== spanId) continue
      deadline.assertLive(this.#now())
      const text = boundedSearchText(JSON.stringify(span))
      for (const match of text.matchAll(compileEvidencePattern(pattern))) {
        const offset = match.index ?? 0
        const matched = match[0] ?? ''
        hits.push({
          trace_id: traceId,
          span_id: span.span_id,
          span_name: span.name,
          span_kind: span.kind,
          attribute_path: '$',
          matched_text: matched,
          context_before: text.slice(Math.max(0, offset - 32), offset),
          context_after: text.slice(offset + matched.length, offset + matched.length + 32),
          match_offset: offset,
        })
        if (hits.length >= maxHits) return hits
      }
    }
    return hits
  }
}
