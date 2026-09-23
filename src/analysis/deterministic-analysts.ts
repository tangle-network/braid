import {
  type Analyst,
  type AnalystContext,
  type AnalystFinding,
  type AnalystRegistry,
  buildDefaultAnalystRegistry,
  type DatasetOverview,
  type ExactCapableAnalyst,
  makeFinding,
  type TraceAnalysisStore,
  type TraceAnalystSpan,
} from '@tangle-network/agent-eval'

import { analystIdForKind } from './analyst-ids.js'
import { traceSpanUri } from './source-uris.js'

/**
 * Deterministic analysts state only counted observations read from the frozen
 * store and always cite the span they read. They never assert a root cause and
 * never call a model, so their findings are reproducible for one frozen digest.
 */

const MAX_QUESTION_ECHO = 400

function context(signal: AbortSignal | undefined): { signal: AbortSignal } | undefined {
  return signal ? { signal } : undefined
}

function producedAt(ctx: AnalystContext): string {
  const captured = ctx.tags?.captured_at
  return captured && !Number.isNaN(Date.parse(captured)) ? captured : '1970-01-01T00:00:00.000Z'
}

function analyst(
  id: string,
  description: string,
  analyze: (store: TraceAnalysisStore, ctx: AnalystContext) => Promise<AnalystFinding[]>,
): ExactCapableAnalyst<TraceAnalysisStore> {
  return {
    id,
    description,
    inputKind: 'trace-store',
    cost: { kind: 'deterministic' },
    version: '1.0.0',
    executionConfig: { implementation: 'braid-deterministic', id },
    analyze,
  }
}

async function firstSpan(
  store: TraceAnalysisStore,
  signal: AbortSignal | undefined,
): Promise<TraceAnalystSpan | undefined> {
  const page = await store.queryTraces({ limit: 20 }, context(signal))
  for (const trace of page.traces) {
    const view = await store.viewTrace({ trace_id: trace.trace_id }, context(signal))
    const span = view.spans?.[0]
    if (span) return span
  }
  return undefined
}

async function errorSpan(
  store: TraceAnalysisStore,
  signal: AbortSignal | undefined,
): Promise<TraceAnalystSpan | undefined> {
  const page = await store.queryTraces(
    { filters: { has_errors: true }, limit: 20 },
    context(signal),
  )
  for (const trace of page.traces) {
    const view = await store.viewTrace({ trace_id: trace.trace_id }, context(signal))
    const span = view.spans?.find((entry) => entry.status === 'ERROR')
    if (span) return span
  }
  return undefined
}

function finding(input: {
  readonly analystId: string
  readonly area: string
  readonly claim: string
  readonly rationale: string
  readonly span: TraceAnalystSpan
  readonly action: string
  readonly ctx: AnalystContext
}): AnalystFinding {
  return makeFinding({
    analyst_id: input.analystId,
    severity: 'medium',
    area: input.area,
    claim: input.claim,
    rationale: input.rationale,
    evidence_refs: [
      {
        kind: 'span',
        uri: traceSpanUri(input.span.trace_id, input.span.span_id),
        excerpt: input.span.status_message ?? input.span.name,
      },
    ],
    recommended_action: input.action,
    validation_plan: 'Replay the cited span and check the same counted condition.',
    confidence: 1,
    subject: input.span.trace_id,
    produced_at: producedAt(input.ctx),
    id_basis: `${input.analystId}:${input.area}:${input.span.span_id}`,
  })
}

function counts(overview: DatasetOverview): string {
  return `${overview.total_traces} trace(s), ${overview.errors.span_count} error span(s), ${overview.tool_names.length} distinct tool(s)`
}

const askAnalyst = analyst(
  analystIdForKind('ask'),
  'Answer the caller question with counted observations and one cited span.',
  async (store, ctx) => {
    const overview = await store.getOverview(undefined, context(ctx.signal))
    const span = (await errorSpan(store, ctx.signal)) ?? (await firstSpan(store, ctx.signal))
    if (!span) return []
    const asked = ctx.tags?.question?.slice(0, MAX_QUESTION_ECHO)
    const observed = overview.errors.span_count
    const answer = asked
      ? `Asked: ${asked} — the frozen source shows ${counts(overview)}.`
      : `The frozen source shows ${counts(overview)}.`
    const bound =
      observed > 0
        ? 'An error is observed, which establishes the failure point but not its cause.'
        : 'No error span is present, so this source cannot establish a failure cause.'
    return [
      finding({
        analystId: analystIdForKind('ask'),
        area: 'answer',
        claim: `${answer} ${bound}`,
        rationale: `Counted from the frozen store: ${counts(overview)}. Cited span ${span.span_id} is the read evidence.`,
        span,
        action:
          observed > 0
            ? 'Inspect the cited span, then reproduce the same failure before changing behavior.'
            : 'Capture a failing run or inspect user-visible output before diagnosing further.',
        ctx,
      }),
    ]
  },
)

const failureAnalyst = analyst(
  analystIdForKind('failure'),
  'Report observed failure clusters and cite an error span.',
  async (store, ctx) => {
    const overview = await store.getOverview({ has_errors: true }, context(ctx.signal))
    const span = await errorSpan(store, ctx.signal)
    if (!span || overview.errors.span_count === 0) return []
    const cluster = overview.error_clusters[0]
    return [
      finding({
        analystId: analystIdForKind('failure'),
        area: 'failure',
        claim: 'The frozen source contains an observed error cluster that needs investigation.',
        rationale: `${overview.errors.span_count} error span(s) across ${overview.errors.trace_count} trace(s); representative signature: ${cluster?.signature ?? 'unknown'}.`,
        span,
        action:
          'Inspect the cited error span, then reproduce the failure before changing behavior.',
        ctx,
      }),
    ]
  },
)

const costAnalyst = analyst(
  analystIdForKind('cost'),
  'Report measured duration and model coverage with a cited span.',
  async (store, ctx) => {
    const overview = await store.getOverview(undefined, context(ctx.signal))
    const span = await firstSpan(store, ctx.signal)
    if (!span || overview.total_traces === 0) return []
    return [
      finding({
        analystId: analystIdForKind('cost'),
        area: 'cost',
        claim:
          'The frozen source has measurable execution work whose duration and model usage should be tracked.',
        rationale: `${overview.total_traces} trace(s), ${overview.models.length} model(s), and ${overview.raw_jsonl_bytes} captured trace bytes are present. Cost is only what the source recorded; uncaptured cost stays unknown.`,
        span,
        action:
          'Compare duration, tokens, and captured cost from the source record before optimizing.',
        ctx,
      }),
    ]
  },
)

const toolsAnalyst = analyst(
  analystIdForKind('tools'),
  'List observed tools and cite the span that contains the activity.',
  async (store, ctx) => {
    const overview = await store.getOverview(undefined, context(ctx.signal))
    const span = await firstSpan(store, ctx.signal)
    if (!span || overview.tool_names.length === 0) return []
    return [
      finding({
        analystId: analystIdForKind('tools'),
        area: 'tool-use',
        claim:
          'The frozen source contains observed tool activity that can be reviewed from the cited span.',
        rationale: `Observed tools: ${overview.tool_names.join(', ')}.`,
        span,
        action:
          'Review tool arguments and outcomes in the cited trace before proposing a tool change.',
        ctx,
      }),
    ]
  },
)

const improvementAnalyst = analyst(
  analystIdForKind('improvement'),
  'Recommend one validated next step from counted observations.',
  async (store, ctx) => {
    const overview = await store.getOverview(undefined, context(ctx.signal))
    const span = (await errorSpan(store, ctx.signal)) ?? (await firstSpan(store, ctx.signal))
    if (!span) return []
    const basis =
      overview.errors.span_count > 0
        ? 'the observed error cluster'
        : overview.tool_names.length > 0
          ? 'the observed tool activity'
          : 'the captured trace'
    return [
      finding({
        analystId: analystIdForKind('improvement'),
        area: 'improvement',
        claim:
          'The next improvement should be validated against the cited source evidence before promotion.',
        rationale: `The recommendation is based on ${basis}; no unsupported root cause is asserted.`,
        span,
        action:
          'Make one isolated change and rerun the cited scenario with the same source measurements.',
        ctx,
      }),
    ]
  },
)

/** Registry used when no model engine is configured for analysis. */
export function createDeterministicAnalystRegistry(): AnalystRegistry {
  const registry = buildDefaultAnalystRegistry({ includeBehavioral: false })
  for (const entry of [
    askAnalyst,
    failureAnalyst,
    costAnalyst,
    toolsAnalyst,
    improvementAnalyst,
  ] satisfies readonly Analyst[])
    registry.register(entry)
  return registry
}
