import type { TraceAnalystSpan } from '@tangle-network/agent-eval'
import {
  buildRuntimeEventOtelSpans,
  type OtelSpan,
  type RuntimeStreamEvent,
} from '@tangle-network/agent-runtime'
import { canonicalDigest } from '../domain/canonical.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import { InMemoryTraceAnalysisStore, type TraceFixture } from '../analysis/trace-store.js'
import type { AnalysisSourceBinding, AnalysisSourceRecord } from '../analysis/source.js'

export const APPLICATION_SOURCE_ID = 'source-conversation-conv-1-branch-1'

function selectedEvents(
  runId: string,
  events: readonly BraidEventEnvelope[],
): readonly BraidEventEnvelope[] {
  const first = events.findIndex(
    (envelope) => envelope.event.kind === 'run.requested' && envelope.event.runId === runId,
  )
  if (first < 0) return []
  const rest = events.slice(first)
  const last = rest.findIndex(
    (envelope) => envelope.event.kind === 'run.finished' && envelope.event.runId === runId,
  )
  return last < 0 ? rest : rest.slice(0, last + 1)
}

function capture(
  state: BraidState,
  events: readonly BraidEventEnvelope[],
  traces: readonly TraceFixture[],
  selectedRunId: string | undefined,
): { readonly source: AnalysisSourceRecord; readonly traceStore: InMemoryTraceAnalysisStore } {
  const runId = selectedRunId ?? 'run-none'
  const run = state.runs.find((candidate) => candidate.id === runId)
  const runEvents = run ? selectedEvents(runId, events) : []
  const hasUnidentifiedEvents = runEvents.some((envelope) => !envelope.eventId)
  const eventReferences = runEvents.flatMap((envelope) =>
    envelope.eventId
      ? [
          {
            eventId: envelope.eventId,
            kind: envelope.event.kind,
            excerpt: JSON.stringify(envelope.event).slice(0, 400),
          },
        ]
      : [],
  )
  const runTraces = traces
    .map((trace) => ({
      traceId: trace.traceId,
      spans: trace.spans.filter((span) => span.attributes['braid.run_id'] === runId),
    }))
    .filter((trace) => trace.spans.length > 0)
  const traceReferences = runTraces.map((trace) => ({
    traceId: trace.traceId,
    spanIds: trace.spans.map((span) => span.span_id),
  }))
  const lastEventId = eventReferences.at(-1)?.eventId
  const sourceRevision = String(runEvents.at(-1)?.revision ?? 0)
  const hasFinishedEvent = runEvents.at(-1)?.event.kind === 'run.finished'
  const source: AnalysisSourceRecord = {
    sourceId: APPLICATION_SOURCE_ID,
    sourceRevision,
    conversationId: state.conversationId,
    branchId: state.branchId,
    runId,
    profileDigest: `sha256:${canonicalDigest(state.profile)}`,
    runner: state.profile.harness ?? 'automatic',
    model: run?.model ?? state.profile.model?.default ?? 'automatic',
    connection:
      state.profile.model?.default === 'fixture/deterministic' ? 'fixture' : 'unconfigured',
    eventIds: eventReferences.map((entry) => entry.eventId),
    traceReferences,
    eventReferences,
    metrics: {
      revision: runEvents.at(-1)?.revision ?? 0,
      ...(run
        ? {
            input_tokens: run.inputTokens,
            output_tokens: run.outputTokens,
            cost_usd: run.costUsd ?? null,
          }
        : {}),
    },
    artifactUris: [],
    capturedAt: new Date().toISOString(),
    complete: Boolean(run && !hasUnidentifiedEvents && hasFinishedEvent),
    completeness:
      hasUnidentifiedEvents || !run ? 'unknown' : run && hasFinishedEvent ? 'complete' : 'partial',
    runtime: 'agent-runtime',
    ...(run && lastEventId ? { receiptId: `receipt-${runId}-${lastEventId}` } : {}),
  }
  return { source, traceStore: new InMemoryTraceAnalysisStore(runTraces) }
}

export function applicationAnalysisBinding(
  readState: () => BraidState,
  readEvents: () => readonly BraidEventEnvelope[],
  readTraces: () => readonly TraceFixture[] = () => [],
  readSelectedRunId: () => string | undefined = () => undefined,
): AnalysisSourceBinding {
  const initial: AnalysisSourceRecord = {
    sourceId: APPLICATION_SOURCE_ID,
    sourceRevision: '0',
    conversationId: 'uninitialized',
    branchId: 'uninitialized',
    runId: 'run-none',
    profileDigest: 'sha256:uninitialized',
    runner: 'uninitialized',
    model: 'uninitialized',
    connection: 'uninitialized',
    eventIds: [],
    traceReferences: [],
    eventReferences: [],
    metrics: {},
    artifactUris: [],
    capturedAt: new Date(0).toISOString(),
    complete: false,
    completeness: 'unknown',
    runtime: 'agent-runtime',
  }
  return {
    source: initial,
    traceStore: new InMemoryTraceAnalysisStore(),
    currentRevision: async () => {
      const events = readEvents()
      const selectedRunId = readSelectedRunId()
      return String(selectedEvents(selectedRunId ?? '', events).at(-1)?.revision ?? 0)
    },
    captureAtRevision: async () =>
      capture(readState(), readEvents(), readTraces(), readSelectedRunId()),
  }
}

function unixNanoToMilliseconds(value: string): number {
  const milliseconds = Number(BigInt(value) / 1_000_000n)
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 8_640_000_000_000_000
  )
    throw new Error('Runtime trace timestamp is outside the supported range')
  return milliseconds
}

function unixNanoToIso(value: string): string {
  return new Date(unixNanoToMilliseconds(value)).toISOString()
}

function attributesFromOtel(span: OtelSpan, runId: string): Record<string, unknown> {
  const attributes: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const attribute of span.attributes ?? []) {
    const value = attribute.value
    if (value.stringValue !== undefined) attributes[attribute.key] = value.stringValue
    else if (value.intValue !== undefined) {
      const number = Number(value.intValue)
      attributes[attribute.key] = Number.isSafeInteger(number) ? number : value.intValue
    } else if (value.doubleValue !== undefined) attributes[attribute.key] = value.doubleValue
    else if (value.boolValue !== undefined) attributes[attribute.key] = value.boolValue
  }
  attributes['braid.run_id'] = runId
  return attributes
}

function attributeText(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key]
  return typeof value === 'string' ? value : null
}

function spanKind(attributes: Readonly<Record<string, unknown>>): TraceAnalystSpan['kind'] {
  const eventType = attributeText(attributes, 'tangle.runtime.event_type')
  if (eventType === 'llm_call') return 'LLM'
  if (eventType === 'tool_call' || eventType === 'tool_result') return 'TOOL'
  return 'AGENT'
}

function spanStatus(span: OtelSpan): TraceAnalystSpan['status'] {
  if (span.status?.code === 2) return 'ERROR'
  if (span.status?.code === 1) return 'OK'
  return 'UNSET'
}

function analystSpanFromOtel(span: OtelSpan, runId: string): TraceAnalystSpan {
  const attributes = attributesFromOtel(span, runId)
  return {
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId ?? null,
    name: span.name,
    kind: spanKind(attributes),
    start_time: unixNanoToIso(span.startTimeUnixNano),
    end_time: unixNanoToIso(span.endTimeUnixNano),
    duration_ms: Math.max(
      0,
      Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1e6,
    ),
    status: spanStatus(span),
    ...(span.status?.message ? { status_message: span.status.message } : {}),
    service_name: attributeText(attributes, 'service.name') ?? 'agent-runtime',
    agent_name: attributeText(attributes, 'gen_ai.agent.name') ?? 'braid',
    model_name: attributeText(attributes, 'gen_ai.request.model'),
    tool_name: attributeText(attributes, 'tool.name') ?? attributeText(attributes, 'mcp.tool.name'),
    attributes,
  }
}

/** Convert the runtime's real event stream into the trace rows Braid freezes. */
export function runtimeTraceForEvents(
  runId: string,
  events: readonly RuntimeStreamEvent[],
): readonly TraceAnalystSpan[] {
  const traceId = `trace-${runId}`
  return buildRuntimeEventOtelSpans(events, traceId)
    .filter((span) => BigInt(span.endTimeUnixNano) > BigInt(span.startTimeUnixNano))
    .map((span) => analystSpanFromOtel(span, runId))
}
