import type { AnalystFinding, EvidenceRef } from '@tangle-network/agent-eval'

import {
  artifactUri,
  eventUri,
  type FrozenAnalysisSource,
  type FrozenAnalysisSourceHandle,
  metricUri,
  traceSpanUri,
} from './source.js'

export interface CitationIssue {
  readonly findingId: string
  readonly citation: EvidenceRef
  readonly reason: string
}

export interface CitationValidation {
  readonly valid: boolean
  readonly checked: number
  readonly issues: readonly CitationIssue[]
}

interface ParsedUri {
  readonly scheme: string
  readonly parts: readonly string[]
}

function parseUri(uri: string): ParsedUri | undefined {
  const match = /^([a-z]+):\/\/(.*)$/u.exec(uri)
  if (!match) return undefined
  return {
    scheme: match[1] ?? '',
    parts: match[2]?.split('/').filter(Boolean).map(decodeURIComponent) ?? [],
  }
}

function fail(finding: AnalystFinding, citation: EvidenceRef, reason: string): CitationIssue {
  return { findingId: finding.finding_id, citation, reason }
}

async function validateOne(
  handle: FrozenAnalysisSourceHandle,
  finding: AnalystFinding,
  citation: EvidenceRef,
): Promise<CitationIssue | undefined> {
  const source: FrozenAnalysisSource = handle.source
  const parsed = parseUri(citation.uri)
  if (!parsed) return fail(finding, citation, 'Citation URI is not absolute')

  if (citation.kind === 'span') {
    if (parsed.scheme !== 'trace' || parsed.parts.length !== 3 || parsed.parts[1] !== 'span') {
      return fail(finding, citation, 'Span citation must use trace://<trace>/span/<span>')
    }
    const [traceId, , spanId] = parsed.parts
    const reference = source.traceReferences.find((entry) => entry.traceId === traceId)
    if (!reference?.spanIds.includes(spanId ?? ''))
      return fail(finding, citation, 'Span is outside the frozen source')
    const result = await handle.traceStore.viewSpans({
      trace_id: traceId ?? '',
      span_ids: [spanId ?? ''],
    })
    const span = result.spans.find((entry) => entry.span_id === spanId)
    if (!span) return fail(finding, citation, 'Span does not resolve in the frozen trace store')
    if (citation.excerpt && !spanText(span).includes(citation.excerpt))
      return fail(finding, citation, 'Citation excerpt does not match the span')
    return undefined
  }

  if (citation.kind === 'event') {
    const expected =
      parsed.parts.length === 2 ? eventUri(source.sourceId, parsed.parts[1] ?? '') : citation.uri
    const eventId = parsed.scheme === 'event' ? parsed.parts[1] : undefined
    const known = source.eventReferences.some(
      (entry) => eventUri(source.sourceId, entry.eventId) === expected && entry.eventId === eventId,
    )
    if (parsed.scheme !== 'event' || parsed.parts[0] !== source.sourceId || !known)
      return fail(finding, citation, 'Event is outside the frozen source')
    const event = source.eventReferences.find((entry) => entry.eventId === eventId)
    if (citation.excerpt && !event?.excerpt?.includes(citation.excerpt))
      return fail(finding, citation, 'Citation excerpt does not match the event')
    return undefined
  }

  if (citation.kind === 'metric') {
    const metricName =
      parsed.scheme === 'metric' && parsed.parts[0] === source.sourceId
        ? parsed.parts[1]
        : undefined
    if (!metricName || !Object.hasOwn(source.metrics, metricName))
      return fail(finding, citation, 'Metric is not present in the frozen source')
    if (source.metrics[metricName] === null)
      return fail(finding, citation, 'Metric is present but unavailable in the frozen source')
    return undefined
  }

  if (citation.kind === 'artifact') {
    if (!source.artifactUris.includes(citation.uri))
      return fail(finding, citation, 'Artifact is not present in the frozen source')
    return undefined
  }

  if (citation.kind === 'finding')
    return fail(finding, citation, 'Finding citations require a persisted prior finding')
  return fail(finding, citation, 'Unknown citation kind')
}

function spanText(span: {
  name: string
  status_message?: string
  attributes: Record<string, unknown>
}): string {
  return [span.name, span.status_message ?? '', ...Object.values(span.attributes).map(String)].join(
    ' ',
  )
}

export async function validateFindingCitations(
  handle: FrozenAnalysisSourceHandle,
  findings: readonly AnalystFinding[],
): Promise<CitationValidation> {
  const issues: CitationIssue[] = []
  let checked = 0
  for (const finding of findings) {
    for (const citation of finding.evidence_refs) {
      checked += 1
      const issue = await validateOne(handle, finding, citation)
      if (issue) issues.push(issue)
    }
  }
  return { valid: issues.length === 0, checked, issues }
}

export { artifactUri, eventUri, metricUri, traceSpanUri }
