import type { AnalysisRecord } from '../../domain/entities.js'
import {
  analysisExecutionView,
  analysisMeasuredModelCallLine,
  analysisMeasuredModelCallSummary,
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
  const citationCheck = (record.checks ?? record.provenance?.checks ?? []).find(
    (check) => check.id === 'citation-support',
  )
  const budgetUsd = analysisBudgetUsd(record)
  return {
    source: String(record.source.digest),
    ...(record.question === undefined ? {} : { question: sanitizeTerminalText(record.question) }),
    analyst: String(record.analystProfileId ?? 'configured analyst'),
    recipe: record.recipe ?? (record.question === undefined ? 'analysis' : 'ask'),
    ...(typeof budgetUsd === 'number' && Number.isFinite(budgetUsd)
      ? { budget: `$${budgetUsd.toFixed(4)}` }
      : {}),
    status:
      record.status === 'preparing' || record.status === 'running' ? 'running' : record.status,
    analysts: (record.analysts ?? []).map((analyst) => ({
      id: sanitizeTerminalText(analyst.analystId),
      status: analyst.status,
      ...(analyst.findingsCount === undefined ? {} : { findingsCount: analyst.findingsCount }),
      ...(analyst.latencyMs === undefined ? {} : { latencyMs: analyst.latencyMs }),
      ...(analyst.detail === undefined ? {} : { detail: sanitizeTerminalText(analyst.detail) }),
    })),
    findings: record.findings.map((finding) => ({
      id: finding.id,
      title: finding.text,
      ...(finding.severity === undefined ? {} : { severity: finding.severity }),
      ...(finding.confidence === undefined ? {} : { confidence: String(finding.confidence) }),
      citationIds: finding.citations.map((citation) => String(citation.id)),
    })),
    citations,
    citationSupport: {
      status: citationCheck?.status ?? 'unavailable',
      supportedFindings: record.findings.filter(
        (finding) => finding.supported && finding.citations.length > 0,
      ).length,
    },
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

  const analysts = analysis.analysts ?? []
  if (analysts.length > 0) {
    details.push(section('analysts'))
    for (const [index, analyst] of analysts.entries()) {
      const receipt = [
        ...(analyst.findingsCount === undefined ? [] : [`${analyst.findingsCount} finding(s)`]),
        ...(analyst.latencyMs === undefined ? [] : [`${Math.round(analyst.latencyMs)}ms`]),
      ]
      details.push(
        `${index + 1}. ${sanitizeTerminalText(analyst.id)} · ${analyst.status}${
          receipt.length === 0 ? '' : ` · ${receipt.join(' · ')}`
        }`,
      )
      if (analyst.detail !== undefined) details.push(`↳ ${sanitizeTerminalText(analyst.detail)}`)
    }
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
      if (citation === undefined) {
        details.push(`! evidence [${number}] unavailable`)
        details.push(`  source: ${shortDigest(citationId)}`)
      } else {
        details.push(`↳ [${number}] ${sanitizeTerminalText(citation.text)}`)
        details.push(`  source: ${shortDigest(citation.eventId)}`)
      }
    }
  }
  if (analysis.findings.length === 0) details.push('No findings were returned.')
  for (const citation of analysis.citations) {
    if (referenced.has(citation.id)) continue
    details.push(
      `↳ [${citationNumbers.get(citation.id) ?? '?'}] ${sanitizeTerminalText(citation.text)}`,
    )
    details.push(`  source: ${shortDigest(citation.eventId)}`)
  }

  const nextAction = analysisNextAction(analysis, mode)
  if (nextAction !== undefined) {
    details.push(section('next'))
    details.push(`next: ${nextAction}`)
  }

  const execution = analysis.execution
  const route = analysisRouteLine(execution)
  if (execution?.modelCalls !== undefined && execution.modelCalls.length > 0) {
    details.push(section('model use'))
    details.push(analysisMeasuredModelCallSummary(execution.modelCalls))
    for (const call of execution.modelCalls)
      details.push(`model call ${analysisMeasuredModelCallLine(call)}`)
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
      `recipe: ${sanitizeTerminalText(analysis.recipe)}${
        analysis.budget === undefined ? '' : ` · budget ${sanitizeTerminalText(analysis.budget)}`
      }`,
      ...(route === undefined ? [] : [route]),
    ],
    details,
  }
}

function analysisBudgetUsd(record: AnalysisRecord): number | undefined {
  const request = record.request
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return undefined
  const budget = (request as Readonly<Record<string, unknown>>).budgetUsd
  return typeof budget === 'number' && Number.isFinite(budget) ? budget : undefined
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
