import {
  applyToolSpanOtlpAttributes,
  createBoundedTraceAnalysisStore,
  OPENINFERENCE_SPAN_KIND,
  otlpTextToTraceAnalysisStore,
  type ToolSpan,
  type TraceAnalysisStore,
} from '@tangle-network/agent-eval/traces'
import { verifyFrozenAnalysisSource } from '../../app/analysis-source.js'
import type { FrozenAnalysisEvent, FrozenAnalysisEvidence } from '../../app/analysis-types.js'
import { AnalysisSourceError } from '../../app/analysis-types.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidEvent } from '../../domain/events.js'
import {
  analysisEventAttributes,
  analysisEventError,
  safeAnalysisText,
  safeAnalysisValue,
} from './trace-event-projection.js'

export interface AnalysisTraceSpanReference {
  readonly spanId: string
  readonly eventIds: readonly string[]
  readonly partId?: string
  readonly toolName?: string
}

export interface AnalysisTraceBundle {
  readonly traceId: string
  readonly sourceDigest: string
  readonly store: TraceAnalysisStore
  readonly spans: readonly AnalysisTraceSpanReference[]
}

interface ToolSpanEntry {
  readonly key: string
  readonly event: FrozenAnalysisEvent
  readonly span: ToolSpan
}

function eventTime(event: FrozenAnalysisEvent): number {
  const parsed = Date.parse(event.occurredAt)
  return Number.isFinite(parsed) ? parsed : event.sequence
}

function toolKey(
  event: Extract<BraidEvent, { readonly kind: 'run.tool.call' | 'run.tool.result' }>,
): string {
  return event.callId ?? `${event.partId}:${event.toolName}`
}

function spanIdFor(event: FrozenAnalysisEvent): string {
  return `span-${canonicalDigest({ eventId: event.id, sequence: event.sequence }).slice(0, 40)}`
}

function createToolSpan(
  evidence: FrozenAnalysisEvidence,
  event: FrozenAnalysisEvent,
  source: Extract<BraidEvent, { readonly kind: 'run.tool.call' }>,
): ToolSpan {
  const startedAt = eventTime(event)
  return {
    spanId: spanIdFor(event),
    runId: String(evidence.source.runId),
    kind: 'tool',
    name: source.toolName,
    toolName: source.toolName,
    args: safeAnalysisValue(source.input ?? null),
    ...(source.input === undefined ? {} : { argsCaptured: true }),
    startedAt,
    attributes: {
      'braid.event_id': String(event.id),
      'braid.part_id': source.partId,
      'braid.source_digest': evidence.source.digest,
    },
  }
}

function buildToolSpans(evidence: FrozenAnalysisEvidence): {
  readonly spans: readonly ToolSpan[]
  readonly references: readonly AnalysisTraceSpanReference[]
} {
  const entries = new Map<string, ToolSpanEntry>()
  const references = new Map<string, AnalysisTraceSpanReference>()

  for (const event of evidence.events) {
    if (event.event.kind === 'run.tool.call') {
      const span = createToolSpan(evidence, event, event.event)
      const key = toolKey(event.event)
      entries.set(key, { key, event, span })
      references.set(span.spanId, {
        spanId: span.spanId,
        eventIds: [String(event.id)],
        partId: event.event.partId,
        toolName: event.event.toolName,
      })
      continue
    }
    if (event.event.kind !== 'run.tool.result') continue

    const key = toolKey(event.event)
    const existing = entries.get(key)
    if (existing === undefined) {
      const startedAt = eventTime(event)
      const span: ToolSpan = {
        spanId: spanIdFor(event),
        runId: String(evidence.source.runId),
        kind: 'tool',
        name: event.event.toolName,
        toolName: event.event.toolName,
        args: null,
        startedAt,
        endedAt: startedAt,
        ...(event.event.error === undefined
          ? { status: 'ok' as const }
          : { status: 'error' as const, error: safeAnalysisText(event.event.error) }),
        ...(event.event.result === undefined
          ? {}
          : { result: safeAnalysisValue(event.event.result) }),
        attributes: {
          'braid.event_id': String(event.id),
          'braid.part_id': event.event.partId,
          'braid.source_digest': evidence.source.digest,
        },
      }
      entries.set(key, { key, event, span })
      references.set(span.spanId, {
        spanId: span.spanId,
        eventIds: [String(event.id)],
        partId: event.event.partId,
        toolName: event.event.toolName,
      })
      continue
    }

    const endedAt = eventTime(event)
    const latencyMs = Math.max(0, endedAt - existing.span.startedAt)
    const span: ToolSpan = {
      ...existing.span,
      endedAt,
      latencyMs,
      ...(event.event.error === undefined
        ? { status: 'ok' as const }
        : { status: 'error' as const, error: safeAnalysisText(event.event.error) }),
      ...(event.event.result === undefined
        ? {}
        : { result: safeAnalysisValue(event.event.result) }),
      attributes: {
        ...existing.span.attributes,
        'braid.result_event_id': String(event.id),
      },
    }
    entries.set(key, { key, event: existing.event, span })
    references.set(span.spanId, {
      spanId: span.spanId,
      eventIds: [String(existing.event.id), String(event.id)],
      partId: event.event.partId,
      toolName: event.event.toolName,
    })
  }

  return {
    spans: [...entries.values()].map((entry) => entry.span),
    references: [...references.values()],
  }
}

function genericTraceText(evidence: FrozenAnalysisEvidence): {
  readonly text: string
  readonly references: readonly AnalysisTraceSpanReference[]
} {
  const events = evidence.events.filter(
    (event) => event.event.kind !== 'run.tool.call' && event.event.kind !== 'run.tool.result',
  )
  const lines = events.map((event) => {
    const time = new Date(eventTime(event)).toISOString()
    const spanId = spanIdFor(event)
    const error = analysisEventError(event.event)
    return JSON.stringify({
      trace_id: String(evidence.source.runId),
      span_id: spanId,
      parent_span_id: null,
      name: `braid.${event.event.kind}`,
      kind: 'SPAN_KIND_INTERNAL',
      start_time: time,
      end_time: time,
      status:
        error === undefined
          ? { code: 'STATUS_CODE_UNSET' }
          : { code: 'STATUS_CODE_ERROR', message: safeAnalysisText(error) },
      resource: {
        attributes: {
          'service.name': 'braid',
          'braid.source_digest': evidence.source.digest,
        },
      },
      attributes: analysisEventAttributes(event, evidence.source.digest),
    })
  })
  return {
    text: `${lines.join('\n')}\n`,
    references: events.map((event) => ({
      spanId: spanIdFor(event),
      eventIds: [String(event.id)],
      ...(event.event.kind === 'run.part.updated' ? { partId: event.event.part.id } : {}),
    })),
  }
}

function toolTraceText(spans: readonly ToolSpan[]): string {
  const lines = spans.map((span) => {
    const attributes = { ...(span.attributes ?? {}) }
    applyToolSpanOtlpAttributes(attributes, span)
    attributes[OPENINFERENCE_SPAN_KIND] = 'TOOL'
    const endedAt = span.endedAt ?? span.startedAt + (span.latencyMs ?? 0)
    return JSON.stringify({
      trace_id: span.runId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId ?? null,
      name: span.name,
      kind: 'SPAN_KIND_INTERNAL',
      start_time: new Date(span.startedAt).toISOString(),
      end_time: new Date(endedAt).toISOString(),
      status:
        span.status === 'error' || span.error !== undefined
          ? { code: 'STATUS_CODE_ERROR', message: span.error }
          : span.status === 'ok'
            ? { code: 'STATUS_CODE_OK' }
            : { code: 'STATUS_CODE_UNSET' },
      resource: { attributes: { 'service.name': 'braid' } },
      attributes,
    })
  })
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

export function buildAnalysisTraceStore(evidence: FrozenAnalysisEvidence): AnalysisTraceBundle {
  verifyFrozenAnalysisSource(evidence)
  if (evidence.source.runId === undefined) {
    throw new AnalysisSourceError('Trace analysis requires a frozen run source')
  }
  if (evidence.events.length === 0) {
    throw new AnalysisSourceError(`Run ${evidence.source.runId} has no frozen events to analyze`)
  }

  const toolEvidence = buildToolSpans(evidence)
  const generic = genericTraceText(evidence)
  const store: TraceAnalysisStore = otlpTextToTraceAnalysisStore(
    `${toolTraceText(toolEvidence.spans)}${generic.text}`,
  )
  const references = [...toolEvidence.references, ...generic.references]

  return {
    traceId: String(evidence.source.runId),
    sourceDigest: String(evidence.source.digest),
    store: createBoundedTraceAnalysisStore(store),
    spans: references,
  }
}
