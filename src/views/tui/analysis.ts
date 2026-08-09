import { Container, type Focusable, matchesKey, TruncatedText } from '@earendil-works/pi-tui'
import type { AnalysisRecord } from '../../domain/entities.js'
import type { AnalysisView, BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'
import { shortDigest } from './configuration-presenters.js'

const PAGE_ROWS = 6

interface AnalysisMode {
  readonly command: '/ask' | '/analyze' | '/compare'
  readonly label: string
}

interface AnalysisDocument {
  readonly heading: string
  readonly context: readonly string[]
  readonly details: readonly string[]
}

export function analysisViewForRecord(record: AnalysisRecord): AnalysisView {
  const citations = record.findings.flatMap((finding) =>
    finding.citations.map((citation) => ({
      id: String(citation.id),
      eventId: String(citation.eventId ?? 'unavailable'),
      text: citation.quote ?? 'citation has no quoted text',
    })),
  )
  return {
    source: String(record.source.digest),
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
    footer: [
      { label: 'source complete', value: record.source.complete ? 'yes' : 'no' },
      { label: 'findings', value: String(record.findings.length) },
      ...(record.costUsd === undefined
        ? []
        : [{ label: 'analysis cost', value: `$${record.costUsd.toFixed(4)}` }]),
      ...(record.wallTimeMs === undefined
        ? []
        : [{ label: 'analysis time', value: `${record.wallTimeMs}ms` }]),
    ],
    ...(record.error === undefined
      ? record.status === 'failed'
        ? { error: 'analysis source or analyst execution failed' }
        : {}
      : { error: record.error }),
  }
}

export function analysisLines(analysis: AnalysisView): readonly string[] {
  const document = analysisDocument(analysis)
  return [document.heading, ...document.context, ...document.details]
}

export class AnalysisViewPanel extends Container implements Focusable {
  readonly #theme: BraidTheme
  #analysis: AnalysisView | undefined
  #page = 0
  #focused = false

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
  }

  setView(view: BraidViewModel): void {
    this.setAnalysis(view.analysis)
  }

  setRecord(record: AnalysisRecord): void {
    this.setAnalysis(analysisViewForRecord(record))
  }

  setAnalysis(analysis: AnalysisView | undefined): void {
    this.#analysis = analysis
    this.#page = 0
    this.#renderPage()
  }

  handleInput(data: string): void {
    const analysis = this.#analysis
    if (analysis === undefined) return
    const pages = pageCount(analysisDocument(analysis).details.length)
    const previous = this.#page
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'up')) this.#page -= 1
    else if (matchesKey(data, 'pageDown') || matchesKey(data, 'down')) this.#page += 1
    else if (matchesKey(data, 'home')) this.#page = 0
    else if (matchesKey(data, 'end')) this.#page = pages - 1
    this.#page = Math.max(0, Math.min(this.#page, pages - 1))
    if (this.#page !== previous) this.#renderPage()
  }

  #renderPage(): void {
    this.clear()
    const analysis = this.#analysis
    if (analysis === undefined) {
      this.addChild(this.#line(this.#theme.brand('analysis · unavailable')))
      this.addChild(this.#line(this.#theme.warning('No frozen analysis result is available.')))
      this.addChild(this.#line(this.#theme.muted('esc close')))
      this.invalidate()
      return
    }

    const document = analysisDocument(analysis)
    const pages = pageCount(document.details.length)
    this.#page = Math.max(0, Math.min(this.#page, pages - 1))
    this.addChild(this.#line(this.#theme.brand(document.heading)))
    for (const line of document.context) this.addChild(this.#line(this.#theme.muted(line)))
    const start = this.#page * PAGE_ROWS
    for (const line of document.details.slice(start, start + PAGE_ROWS)) {
      this.addChild(this.#line(line.startsWith('! ') ? this.#theme.warning(line) : line))
    }
    this.addChild(
      this.#line(
        this.#theme.muted(
          pages > 1 ? `PgUp/PgDn · page ${this.#page + 1}/${pages} · esc close` : 'esc close',
        ),
      ),
    )
    this.invalidate()
  }

  #line(value: string): TruncatedText {
    return new TruncatedText(value, 1, 0)
  }
}

function analysisDocument(analysis: AnalysisView): AnalysisDocument {
  const mode = analysisMode(analysis)
  const citations = new Map(analysis.citations.map((citation) => [citation.id, citation]))
  const referenced = new Set<string>()
  const details: string[] = []

  for (const finding of analysis.findings) {
    const severity = finding.severity ? ` · ${sanitizeTerminalText(finding.severity)}` : ''
    const confidence = finding.confidence
      ? ` · confidence ${sanitizeTerminalText(finding.confidence)}`
      : ''
    const cited = finding.citationIds.length
      ? `[${finding.citationIds.map(sanitizeTerminalText).join(',')}] `
      : '[no citation] '
    details.push(`• ${cited}${sanitizeTerminalText(finding.title)}${severity}${confidence}`)
    for (const citationId of finding.citationIds) {
      referenced.add(citationId)
      const citation = citations.get(citationId)
      details.push(
        citation === undefined
          ? `! evidence unavailable: ${sanitizeTerminalText(citationId)}`
          : `↳ [${sanitizeTerminalText(citation.id)}] ${sanitizeTerminalText(citation.text)}`,
      )
    }
  }
  if (analysis.findings.length === 0) details.push('No findings were returned.')
  for (const citation of analysis.citations) {
    if (referenced.has(citation.id)) continue
    details.push(
      `evidence [${sanitizeTerminalText(citation.id)}]: ${sanitizeTerminalText(citation.text)}`,
    )
  }
  if (analysis.footer.length > 0) {
    const footer = analysis.footer.map(
      (field) => `${sanitizeTerminalText(field.label)}: ${sanitizeTerminalText(field.value)}`,
    )
    for (let index = 0; index < footer.length; index += 2) {
      details.push(footer.slice(index, index + 2).join(' · '))
    }
  }
  if (analysis.error) details.push(`! ${sanitizeTerminalText(analysis.error)}`)

  return {
    heading: `${mode.command} · ${mode.label}`,
    context: [
      `source: ${shortDigest(analysis.source)} · frozen`,
      `analyst: ${sanitizeTerminalText(analysis.analyst)} · ${sanitizeTerminalText(analysis.status)}`,
    ],
    details,
  }
}

function pageCount(detailCount: number): number {
  return Math.max(1, Math.ceil(detailCount / PAGE_ROWS))
}

function analysisMode(analysis: AnalysisView): AnalysisMode {
  const recipe = sanitizeTerminalText(analysis.recipe).trim()
  const normalized = recipe.toLocaleLowerCase()
  if (normalized === 'ask' || normalized === 'question')
    return { command: '/ask', label: 'frozen question' }
  if (normalized.includes('compare')) return { command: '/compare', label: 'paired sources' }
  return { command: '/analyze', label: recipe || 'named recipe' }
}
