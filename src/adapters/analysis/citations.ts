import type { AnalystFinding, EvidenceRef } from '@tangle-network/agent-eval'
import type { FrozenAnalysisEvent, FrozenAnalysisEvidence } from '../../app/analysis-types.js'
import { AnalysisCitationError } from '../../app/analysis-types.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { AnalysisCitation, AnalysisFinding } from '../../domain/entities.js'
import type { EventId } from '../../domain/ids.js'
import {
  createCitationId,
  createEventId,
  isEventId,
  isMessagePartId,
} from '../../domain/ids-values.js'
import type { AnalysisTraceBundle, AnalysisTraceSpanReference } from './trace-store.js'

function decodePart(value: string, label: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new AnalysisCitationError(`Citation ${label} is not valid URI encoding`)
  }
}

function eventId(value: string): EventId {
  if (isEventId(value)) return value
  return createEventId(`event-${canonicalDigest(value).slice(0, 40)}`)
}

function sourceEvent(evidence: FrozenAnalysisEvidence, id: string): FrozenAnalysisEvent {
  const event = evidence.events.find((candidate) => String(candidate.id) === id)
  if (event === undefined)
    throw new AnalysisCitationError(`Citation references missing event ${id}`)
  return event
}

function eventText(event: FrozenAnalysisEvent): string {
  if (event.event.kind === 'run.text.delta' || event.event.kind === 'run.reasoning.delta') {
    return event.event.text
  }
  if (event.event.kind === 'run.warning' || event.event.kind === 'run.error') {
    return event.event.message
  }
  try {
    return JSON.stringify(event.event)
  } catch {
    return ''
  }
}

function messageText(evidence: FrozenAnalysisEvidence, messageId: string): string {
  const message = evidence.messages.find((candidate) => String(candidate.id) === messageId)
  if (message === undefined)
    throw new AnalysisCitationError(`Citation references missing message ${messageId}`)
  return message.text
}

function partText(evidence: FrozenAnalysisEvidence, partId: string): string {
  const part = evidence.messageParts.find((candidate) => String(candidate.id) === partId)
  if (part === undefined)
    throw new AnalysisCitationError(`Citation references missing message part ${partId}`)
  switch (part.kind) {
    case 'text':
    case 'reasoning':
      return part.text
    case 'tool-result':
      return part.summary
    case 'warning':
    case 'error':
      return part.message
    case 'artifact':
    case 'unknown':
      return part.summary
    case 'tool-call':
      return JSON.stringify(part.arguments)
    case 'file':
      return part.path ?? part.filename ?? ''
    case 'image':
      return part.altText ?? ''
  }
}

function assertExcerpt(event: FrozenAnalysisEvent, excerpt: string | undefined): void {
  if (excerpt === undefined) return
  if (excerpt.length === 0 || !eventText(event).includes(excerpt)) {
    throw new AnalysisCitationError(
      `Citation excerpt does not occur in frozen event ${String(event.id)}`,
    )
  }
}

function spanReference(bundle: AnalysisTraceBundle, spanId: string): AnalysisTraceSpanReference {
  const reference = bundle.spans.find((candidate) => candidate.spanId === spanId)
  if (reference === undefined)
    throw new AnalysisCitationError(`Citation references missing span ${spanId}`)
  return reference
}

function traceMatches(evidence: FrozenAnalysisEvidence, traceId: string): boolean {
  return (
    traceId === String(evidence.source.runId) ||
    traceId === String(evidence.source.trace?.id) ||
    traceId === `braid://run/${String(evidence.source.runId)}`
  )
}

function citationForEvent(
  evidence: FrozenAnalysisEvidence,
  ref: EvidenceRef,
  sourceId: string,
  partId?: string,
): AnalysisCitation {
  const source = sourceEvent(evidence, sourceId)
  assertExcerpt(source, ref.excerpt)
  const digest = canonicalDigest({ sourceId, partId, ref })
  const citationPartId = partId !== undefined && isMessagePartId(partId) ? partId : undefined
  return {
    id: createCitationId(`citation-${digest.slice(0, 40)}`),
    eventId: eventId(sourceId),
    ...(citationPartId === undefined ? {} : { partId: citationPartId }),
    ...(ref.excerpt === undefined ? {} : { quote: ref.excerpt }),
  }
}

export function resolveEvidenceRef(
  evidence: FrozenAnalysisEvidence,
  bundle: AnalysisTraceBundle,
  ref: EvidenceRef,
): AnalysisCitation {
  if (ref.kind === 'span') {
    const match = /^trace:\/\/([^/]+)\/span\/([^/?#]+)$/u.exec(ref.uri)
    if (match === null) throw new AnalysisCitationError(`Citation span URI is invalid: ${ref.uri}`)
    const traceId = decodePart(match[1] ?? '', 'trace id')
    const spanId = decodePart(match[2] ?? '', 'span id')
    if (!traceMatches(evidence, traceId)) {
      throw new AnalysisCitationError(
        `Citation references trace ${traceId} outside the frozen source`,
      )
    }
    const span = spanReference(bundle, spanId)
    return citationForEvent(evidence, ref, span.eventId, span.partId)
  }

  if (ref.kind === 'event') {
    const match = /^(?:event:\/\/|braid:\/\/event\/)([^/?#]+)$/u.exec(ref.uri)
    if (match === null) throw new AnalysisCitationError(`Citation event URI is invalid: ${ref.uri}`)
    return citationForEvent(evidence, ref, decodePart(match[1] ?? '', 'event id'))
  }

  if (ref.kind === 'artifact') {
    const match = /^artifact:\/\/([^/?#]+)$/u.exec(ref.uri)
    if (match === null)
      throw new AnalysisCitationError(`Citation artifact URI is invalid: ${ref.uri}`)
    const artifactId = decodePart(match[1] ?? '', 'artifact id')
    const event = evidence.events.find(
      (candidate) =>
        candidate.event.kind === 'run.artifact' && candidate.event.artifactId === artifactId,
    )
    if (event === undefined)
      throw new AnalysisCitationError(`Citation references missing artifact ${artifactId}`)
    return citationForEvent(evidence, ref, String(event.id))
  }

  throw new AnalysisCitationError(`Citation kind '${ref.kind}' has no resolvable frozen source`)
}

function severity(value: AnalystFinding['severity']): AnalysisFinding['severity'] | undefined {
  return value === undefined ? undefined : value
}

export function mapAnalystFinding(
  evidence: FrozenAnalysisEvidence,
  bundle: AnalysisTraceBundle,
  finding: AnalystFinding,
): AnalysisFinding {
  const refs = finding.evidence_refs ?? []
  const citations = refs.map((ref) => resolveEvidenceRef(evidence, bundle, ref))
  const findingSeverity = severity(finding.severity)
  return {
    id: finding.finding_id,
    text: finding.claim,
    ...(findingSeverity === undefined ? {} : { severity: findingSeverity }),
    ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
    citations,
    supported: refs.length > 0 && citations.length === refs.length,
  }
}

export function mapAnalystFindings(
  evidence: FrozenAnalysisEvidence,
  bundle: AnalysisTraceBundle,
  findings: readonly AnalystFinding[],
): readonly AnalysisFinding[] {
  return findings.map((finding) => mapAnalystFinding(evidence, bundle, finding))
}

/** Re-checks a persisted citation against the exact evidence that produced it. */
export function validateAnalysisCitation(
  evidence: FrozenAnalysisEvidence,
  citation: AnalysisCitation,
): void {
  let text: string | undefined
  if (citation.eventId !== undefined) {
    text = eventText(sourceEvent(evidence, String(citation.eventId)))
  }
  if (citation.messageId !== undefined) {
    text = messageText(evidence, String(citation.messageId))
  }
  if (citation.partId !== undefined) {
    const part = evidence.messageParts.find((candidate) => candidate.id === citation.partId)
    if (part === undefined) {
      if (citation.eventId === undefined) {
        throw new AnalysisCitationError(
          `Citation references missing message part ${String(citation.partId)}`,
        )
      }
    } else {
      text = partText(evidence, String(citation.partId))
    }
  }
  if (text === undefined) {
    throw new AnalysisCitationError(`Citation ${String(citation.id)} has no frozen source target`)
  }
  if (citation.start !== undefined && citation.start > text.length) {
    throw new AnalysisCitationError(`Citation ${String(citation.id)} starts outside its source`)
  }
  if (citation.end !== undefined && citation.end > text.length) {
    throw new AnalysisCitationError(`Citation ${String(citation.id)} ends outside its source`)
  }
  if (citation.start !== undefined && citation.end !== undefined && citation.end < citation.start) {
    throw new AnalysisCitationError(`Citation ${String(citation.id)} has an inverted range`)
  }
  if (citation.quote !== undefined && !text.includes(citation.quote)) {
    throw new AnalysisCitationError(
      `Citation ${String(citation.id)} quote is absent from frozen source`,
    )
  }
}
