import type { AnalysisRecord } from '../../domain/entities.js'
import {
  analysisExecutionView,
  analysisModelCallLine,
  analysisModelCallSummary,
} from './analysis-model-call-presentation.js'
import type { AnalysisView } from './models.js'
import { sanitizeTerminalText } from './sanitize.js'

export interface AnalysisDocument {
  readonly heading: string
  readonly context: readonly string[]
  readonly details: readonly string[]
}

interface AnalysisMode {
  readonly command: '/ask' | '/analyze' | '/compare'
  readonly label: string
}

export function analysisViewForRecord(record: AnalysisRecord): AnalysisView {
  const citations = record.findings.flatMap((finding) =>
    finding.citations.map((citation) => ({
      id: String(citation.id),
      eventId: String(citation.eventId ?? 'unavailable'),
      text: citation.quote ?? 'citation has no quoted text',
    })),
  )
  const costFooter = analysisCostFooter(record)
  return {
    source: String(record.source.digest),
    ...(record.question === undefined ? {} : { question: sanitizeTerminalText(record.question) }),
    analyst: String(record.analystProfileId ?? 'configured analyst'),
    recipe: record.recipe ?? (record.question === undefined ? 'analysis' : 'ask'),
    status:
      record.status === 'preparing' || record.status === 'running' ? 'running' : record.status,
    findings: record.findings.map((finding) => ({
      id: finding.id,
      title: finding.text,
      ...(finding.severity === undefined ? {} : { severity: finding.severity }),
      ...(finding.confidence === undefined ? {} : { confidence: String(finding.confidence) }),
      citationIds: finding.citations.map((citation) => String(citation.id)),
    })),
    citations,
    execution: analysisExecutionView(record),
    footer: [
      { label: 'source complete', value: record.source.complete ? 'yes' : 'no' },
      { label: 'findings', value: String(record.findings.length) },
      ...(record.usage?.model === undefined
        ? []
        : [{ label: 'model', value: sanitizeTerminalText(record.usage.model) }]),
      ...(record.provenance?.runner === undefined
        ? []
        : [{ label: 'runner', value: sanitizeTerminalText(record.provenance.runner) }]),
      ...(record.provenance?.agentEvalVersion === undefined
        ? []
        : [
            {
              label: 'agent-eval',
              value: sanitizeTerminalText(record.provenance.agentEvalVersion),
            },
          ]),
      ...(record.usage === undefined
        ? []
        : [
            {
              label: 'tokens',
              value: `${record.usage.input} in / ${record.usage.output} out`,
            },
          ]),
      ...(costFooter === undefined ? [] : [costFooter]),
      ...(record.wallTimeMs === undefined
        ? []
        : [{ label: 'analysis time', value: `${record.wallTimeMs}ms` }]),
      ...(record.checks ?? record.provenance?.checks ?? []).map((check) => ({
        label: `check ${sanitizeTerminalText(check.id)}`,
        value: `${check.status}${check.detail === undefined ? '' : ` · ${sanitizeTerminalText(check.detail)}`}`,
      })),
    ],
    ...(record.error === undefined
      ? record.status === 'failed'
        ? { error: 'analysis source or analyst execution failed' }
        : {}
      : { error: record.error }),
  }
}

function analysisCostFooter(
  record: AnalysisRecord,
): { readonly label: string; readonly value: string } | undefined {
  if (record.usage?.estimatedCostUsd !== undefined) {
    return {
      label: 'analysis cost estimate',
      value: `~$${record.usage.estimatedCostUsd.toFixed(4)}`,
    }
  }
  if (record.usage?.usdKnown === false && record.usage.costUsd !== undefined) {
    return {
      label: 'analysis cost minimum',
      value: `≥$${record.usage.costUsd.toFixed(4)}`,
    }
  }
  if (record.costUsd === undefined) return undefined
  return { label: 'analysis cost', value: `$${record.costUsd.toFixed(4)}` }
}

export function analysisLines(analysis: AnalysisView): readonly string[] {
  const document = analysisDocument(analysis)
  return [document.heading, ...document.context, ...document.details]
}

export function analysisDocument(analysis: AnalysisView): AnalysisDocument {
  const mode = analysisMode(analysis)
  const citations = new Map(analysis.citations.map((citation) => [citation.id, citation]))
  const citationNumbers = new Map(
    analysis.citations.map((citation, index) => [citation.id, index + 1] as const),
  )
  const referenced = new Set<string>()
  const details: string[] = []

  if (analysis.question !== undefined) {
    details.push(section('question'))
    details.push(sanitizeTerminalText(analysis.question))
  }

  details.push(section('findings'))
  for (const [index, finding] of analysis.findings.entries()) {
    const severity = finding.severity ? ` · ${sanitizeTerminalText(finding.severity)}` : ''
    const confidence = finding.confidence
      ? ` · confidence ${sanitizeTerminalText(finding.confidence)}`
      : ''
    const cited = finding.citationIds.length
      ? `[${finding.citationIds.map((id) => citationNumbers.get(id) ?? '?').join(',')}] `
      : '[no citation] '
    details.push(
      `${index + 1}. ${cited}${sanitizeTerminalText(finding.title)}${severity}${confidence}`,
    )
    for (const citationId of finding.citationIds) {
      referenced.add(citationId)
      const citation = citations.get(citationId)
      const number = citationNumbers.get(citationId) ?? '?'
      details.push(
        citation === undefined
          ? `! evidence [${number}] unavailable · citation ${shortDigest(citationId)}`
          : `↳ [${number}] ${sanitizeTerminalText(citation.text)} · event ${shortDigest(citation.eventId)}`,
      )
    }
  }
  if (analysis.findings.length === 0) details.push('No findings were returned.')
  for (const citation of analysis.citations) {
    if (referenced.has(citation.id)) continue
    details.push(
      `↳ [${citationNumbers.get(citation.id) ?? '?'}] ${sanitizeTerminalText(citation.text)} · event ${shortDigest(citation.eventId)}`,
    )
  }

  const nextAction = analysisNextAction(analysis, mode)
  if (nextAction !== undefined) {
    details.push(section('next'))
    details.push(`next: ${nextAction}`)
  }

  details.push(section('model use'))
  const execution = analysis.execution
  const route = analysisRouteLine(execution)
  if (execution?.modelCalls === undefined) {
    details.push('Model calls were not reported.')
  } else if (execution.modelCalls.length === 0) {
    details.push('0 model calls reported.')
  } else {
    details.push(analysisModelCallSummary(execution.modelCalls))
    for (const call of execution.modelCalls)
      details.push(`model call ${analysisModelCallLine(call)}`)
  }

  if (analysis.error) details.push(`! ${sanitizeTerminalText(analysis.error)}`)
  if (analysis.footer.length > 0) {
    details.push(section('run receipt'))
    for (const field of analysis.footer)
      details.push(`${sanitizeTerminalText(field.label)}: ${sanitizeTerminalText(field.value)}`)
  }

  return {
    heading: `${mode.command} · ${mode.label}`,
    context: [
      `source: ${shortDigest(analysis.source)} · frozen`,
      `analyst: ${sanitizeTerminalText(analysis.analyst)} · ${sanitizeTerminalText(analysis.status)}`,
      ...(route === undefined ? [] : [route]),
    ],
    details,
  }
}

function analysisRouteLine(execution: AnalysisView['execution']): string | undefined {
  if (execution?.runner !== undefined && execution.configuredModel !== undefined) {
    return `route: runner ${sanitizeTerminalText(execution.runner)} · configured model ${sanitizeTerminalText(execution.configuredModel)}`
  }
  if (execution?.runner !== undefined)
    return `route: runner ${sanitizeTerminalText(execution.runner)}`
  if (execution?.configuredModel !== undefined)
    return `route: configured model ${sanitizeTerminalText(execution.configuredModel)}`
  return undefined
}

function section(label: string): string {
  return `── ${label}`
}

function analysisNextAction(analysis: AnalysisView, mode: AnalysisMode): string | undefined {
  if (analysis.status === 'failed') {
    return 'retry /ask with a narrower question, or open /activity to inspect the failed analyst call'
  }
  if (analysis.status === 'cancelled') {
    return 'run /ask again, or open /activity to inspect the cancelled analyst call'
  }
  if (analysis.status !== 'completed') return undefined
  if (mode.command === '/ask') {
    return 'ask a narrower question, or use /compare <left> <right> against another frozen run'
  }
  if (mode.command === '/compare') {
    return 'inspect either frozen run with /ask <question>'
  }
  return 'inspect the cited evidence, or use /compare <left> <right> against another frozen run'
}

function analysisMode(analysis: AnalysisView): AnalysisMode {
  const recipe = sanitizeTerminalText(analysis.recipe).trim()
  const normalized = recipe.toLocaleLowerCase()
  if (normalized === 'ask' || normalized === 'question') {
    return { command: '/ask', label: 'frozen question' }
  }
  if (normalized.includes('compare')) return { command: '/compare', label: 'paired sources' }
  return { command: '/analyze', label: recipe || 'named recipe' }
}

function shortDigest(value: string): string {
  const safe = sanitizeTerminalText(value)
  if (safe.length <= 24) return safe
  return `${safe.slice(0, 15)}…${safe.slice(-8)}`
}
