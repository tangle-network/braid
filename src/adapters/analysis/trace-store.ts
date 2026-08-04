import {
  createBoundedTraceAnalysisStore,
  otlpTextToTraceAnalysisStore,
  type ToolSpan,
  type TraceAnalysisStore,
  toolSpansToTraceAnalysisStore,
} from '@tangle-network/agent-eval'
import { verifyFrozenAnalysisSource } from '../../app/analysis-source.js'
import type { FrozenAnalysisEvent, FrozenAnalysisEvidence } from '../../app/analysis-types.js'
import { AnalysisSourceError } from '../../app/analysis-types.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { BraidEvent } from '../../domain/events.js'
import { redactSensitiveText, redactStructuredValue } from '../../domain/redaction.js'

export interface AnalysisTraceSpanReference {
  readonly spanId: string
  readonly eventId: string
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

function safeValue(value: unknown): unknown {
  try {
    return redactStructuredValue(value)
  } catch {
    return '[redacted value]'
  }
}

function safeText(value: unknown): string {
  if (typeof value === 'string') return redactSensitiveText(value)
  try {
    return redactSensitiveText(JSON.stringify(safeValue(value)) ?? String(value))
  } catch {
    return '[redacted value]'
  }
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
    args: safeValue(source.input ?? null),
    ...(source.input === undefined ? {} : { argsCaptured: true }),
    startedAt,
    attributes: {
      'braid.event_id': String(event.id),
      'braid.part_id': source.partId,
      'braid.source_digest': evidence.source.digest,
    },
  }
}

function sourceEventError(event: BraidEvent): string | undefined {
  if (event.kind === 'run.error') return event.message
  if (event.kind === 'run.tool.result' && event.error !== undefined) return event.error
  return undefined
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
        eventId: String(event.id),
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
          : { status: 'error' as const, error: safeText(event.event.error) }),
        ...(event.event.result === undefined ? {} : { result: safeValue(event.event.result) }),
        attributes: {
          'braid.event_id': String(event.id),
          'braid.part_id': event.event.partId,
          'braid.source_digest': evidence.source.digest,
        },
      }
      entries.set(key, { key, event, span })
      references.set(span.spanId, {
        spanId: span.spanId,
        eventId: String(event.id),
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
        : { status: 'error' as const, error: safeText(event.event.error) }),
      ...(event.event.result === undefined ? {} : { result: safeValue(event.event.result) }),
      attributes: {
        ...existing.span.attributes,
        'braid.result_event_id': String(event.id),
      },
    }
    entries.set(key, { key, event: existing.event, span })
  }

  return {
    spans: [...entries.values()].map((entry) => entry.span),
    references: [...references.values()],
  }
}

function eventAttributes(
  event: FrozenAnalysisEvent,
  sourceDigest: string,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    'braid.event_id': String(event.id),
    'braid.kind': event.event.kind,
    'braid.source_digest': sourceDigest,
    'openinference.span.kind': event.event.kind === 'run.text.delta' ? 'LLM' : 'AGENT',
  }
  if (event.event.kind === 'run.text.delta' || event.event.kind === 'run.reasoning.delta') {
    attributes['output.value'] = safeText(event.event.text)
  }
  const error = sourceEventError(event.event)
  if (error !== undefined) attributes['error.message'] = safeText(error)
  return attributes
}

function genericTraceText(evidence: FrozenAnalysisEvidence): {
  readonly text: string
  readonly references: readonly AnalysisTraceSpanReference[]
} {
  const lines = evidence.events.map((event) => {
    const time = new Date(eventTime(event)).toISOString()
    const spanId = spanIdFor(event)
    const error = sourceEventError(event.event)
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
          : { code: 'STATUS_CODE_ERROR', message: safeText(error) },
      resource: { attributes: { 'braid.source_digest': evidence.source.digest } },
      attributes: eventAttributes(event, evidence.source.digest),
    })
  })
  return {
    text: `${lines.join('\n')}\n`,
    references: evidence.events.map((event) => ({
      spanId: spanIdFor(event),
      eventId: String(event.id),
      ...(event.event.kind === 'run.part.updated' ? { partId: event.event.part.id } : {}),
    })),
  }
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
  let store: TraceAnalysisStore
  let references: readonly AnalysisTraceSpanReference[]
  if (toolEvidence.spans.length > 0) {
    store = toolSpansToTraceAnalysisStore(toolEvidence.spans)
    references = toolEvidence.references
  } else {
    const generic = genericTraceText(evidence)
    store = otlpTextToTraceAnalysisStore(generic.text)
    references = generic.references
  }

  return {
    traceId: String(evidence.source.runId),
    sourceDigest: String(evidence.source.digest),
    store: createBoundedTraceAnalysisStore(store),
    spans: references,
  }
}
