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

export interface TraceFixture {
  readonly traceId: string
  readonly spans: readonly TraceAnalystSpan[]
}

function summary(trace: TraceFixture): TraceAnalystTraceSummary {
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
    start_time: first ?? new Date(0).toISOString(),
    end_time: last ?? new Date(0).toISOString(),
    duration_ms: spans.reduce((total, span) => total + span.duration_ms, 0),
    raw_jsonl_bytes: JSON.stringify(spans).length,
    models: [
      ...new Set(
        spans.map((span) => span.model_name).filter((name): name is string => Boolean(name)),
      ),
    ],
    tools: [
      ...new Set(
        spans.map((span) => span.tool_name).filter((name): name is string => Boolean(name)),
      ),
    ],
  }
}

function matchesFilters(trace: TraceFixture, filters?: TraceAnalystFilters): boolean {
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

function normalizeError(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8,}\b/giu, '<hex>')
    .replace(/\b\d+\b/gu, '<n>')
    .replace(/\/[^ ]+/gu, '<path>')
}

export class InMemoryTraceAnalysisStore implements TraceAnalysisStore {
  private readonly traces = new Map<string, TraceFixture>()

  constructor(initial: readonly TraceFixture[] = []) {
    for (const trace of initial) this.traces.set(trace.traceId, trace)
  }

  replace(trace: TraceFixture): void {
    this.traces.set(trace.traceId, trace)
  }

  snapshot(): InMemoryTraceAnalysisStore {
    return new InMemoryTraceAnalysisStore(
      [...this.traces.values()].map((trace) => ({
        traceId: trace.traceId,
        spans: structuredClone(trace.spans),
      })),
    )
  }

  async hasTrace(trace_id: string): Promise<boolean> {
    return this.traces.has(trace_id)
  }

  async hasSpans(input: { trace_id: string; span_ids: readonly string[] }): Promise<string[]> {
    const trace = this.traces.get(input.trace_id)
    const known = new Set(trace?.spans.map((span) => span.span_id) ?? [])
    return input.span_ids.filter((spanId) => known.has(spanId))
  }

  async getOverview(filters?: TraceAnalystFilters): Promise<DatasetOverview> {
    const traces = [...this.traces.values()].filter((trace) => matchesFilters(trace, filters))
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
        traces: new Set(),
        spans: new Set(),
      }
      cluster.count += 1
      cluster.traces.add(span.trace_id)
      cluster.spans.add(span.span_id)
      clusters.set(signature, cluster)
    }
    const ordered = [...clusters.entries()].sort((left, right) => right[1].count - left[1].count)
    return {
      total_traces: traces.length,
      raw_jsonl_bytes: JSON.stringify(traces).length,
      services: [
        ...new Set(
          spans.map((span) => span.service_name).filter((value): value is string => Boolean(value)),
        ),
      ],
      agents: [
        ...new Set(
          spans.map((span) => span.agent_name).filter((value): value is string => Boolean(value)),
        ),
      ],
      models: [
        ...new Set(
          spans.map((span) => span.model_name).filter((value): value is string => Boolean(value)),
        ),
      ],
      tool_names: [
        ...new Set(
          spans.map((span) => span.tool_name).filter((value): value is string => Boolean(value)),
        ),
      ],
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
        traces.length === 0
          ? null
          : {
              earliest:
                traces.map((trace) => summary(trace).start_time).sort()[0] ??
                new Date(0).toISOString(),
              latest:
                traces
                  .map((trace) => summary(trace).end_time)
                  .sort()
                  .at(-1) ?? new Date(0).toISOString(),
            },
    }
  }

  async queryTraces(input: {
    filters?: TraceAnalystFilters
    limit: number
    offset?: number
  }): Promise<QueryTracesPage> {
    const traces = [...this.traces.values()].filter((trace) => matchesFilters(trace, input.filters))
    const offset = input.offset ?? 0
    return {
      traces: traces.slice(offset, offset + input.limit).map(summary),
      total: traces.length,
      has_more: offset + input.limit < traces.length,
    }
  }

  async countTraces(filters?: TraceAnalystFilters): Promise<number> {
    return (
      await this.queryTraces(
        filters ? { filters, limit: Number.MAX_SAFE_INTEGER } : { limit: Number.MAX_SAFE_INTEGER },
      )
    ).total
  }

  async viewTrace(input: { trace_id: string }): Promise<ViewTraceResult> {
    const trace = this.traces.get(input.trace_id)
    if (!trace) return { trace_id: input.trace_id, spans: [] }
    return { trace_id: input.trace_id, spans: [...trace.spans] }
  }

  async viewSpans(input: {
    trace_id: string
    span_ids: readonly string[]
  }): Promise<ViewSpansResult> {
    const trace = this.traces.get(input.trace_id)
    const spans = input.span_ids.flatMap(
      (spanId) => trace?.spans.filter((span) => span.span_id === spanId) ?? [],
    )
    const present = new Set(spans.map((span) => span.span_id))
    return {
      trace_id: input.trace_id,
      spans,
      missing_span_ids: input.span_ids.filter((spanId) => !present.has(spanId)),
      omitted_span_ids: [],
      has_more: false,
      truncated_attribute_count: 0,
    }
  }

  async searchTrace(input: {
    trace_id: string
    regex_pattern: string
    max_matches?: number
  }): Promise<SearchTraceResult> {
    const trace = this.traces.get(input.trace_id)
    const limit = boundedMatchLimit(input.max_matches)
    const hits = searchSpans(input.trace_id, trace?.spans ?? [], input.regex_pattern, limit + 1)
    return {
      trace_id: input.trace_id,
      hits: hits.slice(0, limit),
      has_more: hits.length > limit,
    }
  }

  async searchSpan(input: {
    trace_id: string
    span_id: string
    regex_pattern: string
    max_matches?: number
  }): Promise<SearchSpanResult> {
    const trace = this.traces.get(input.trace_id)
    const limit = boundedMatchLimit(input.max_matches)
    const hits = searchSpans(
      input.trace_id,
      trace?.spans.filter((span) => span.span_id === input.span_id) ?? [],
      input.regex_pattern,
      limit + 1,
    )
    return {
      trace_id: input.trace_id,
      span_id: input.span_id,
      hits: hits.slice(0, limit),
      has_more: hits.length > limit,
    }
  }
}

function searchSpans(
  traceId: string,
  spans: readonly TraceAnalystSpan[],
  patternText: string,
  maxHits: number,
): SearchTraceResult['hits'] {
  const pattern = compileEvidencePattern(patternText)
  const deadline = new SearchDeadline(Date.now())
  const hits: SearchTraceResult['hits'] = []
  for (const span of spans) {
    deadline.assertLive(Date.now())
    const text = boundedSearchText(JSON.stringify(span))
    for (const match of text.matchAll(pattern)) {
      deadline.assertLive(Date.now())
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
