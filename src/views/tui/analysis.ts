import type { AnalysisView, BraidViewModel } from '../shared/models.js'
import { SurfacePanel, safeText, wrappedLines } from './surface-panel.js'
import type { BraidTheme } from './theme.js'

export class AnalysisViewPanel extends SurfacePanel {
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme) {
    super({
      title: 'analysis findings',
      theme,
      footer: 'f fork source  ·  enter keep  ·  esc close',
    })
  }

  setView(view: BraidViewModel): void {
    this.#view = view
  }

  protected body(width: number): string[] {
    const analysis = this.#view?.analysis
    if (!analysis) return ['No frozen run is selected for analysis.']
    return this.#lines(analysis, width)
  }

  #lines(analysis: AnalysisView, width: number): string[] {
    const lines = [
      `${safeText(analysis.status)}  ${safeText(analysis.recipe)}  from ${safeText(analysis.source)}`,
      `${safeText(analysis.analyst)}  ·  cited findings only`,
      '',
    ]
    for (const finding of analysis.findings) {
      const evidence = finding.citationIds.join(', ')
      lines.push(`${safeText(finding.severity ?? 'finding')}  ${safeText(finding.title)}`)
      lines.push(
        ...wrappedLines(
          `  confidence ${safeText(finding.confidence ?? 'unknown')}  ·  citations ${safeText(evidence)}`,
          width,
        ),
      )
    }
    lines.push('', 'evidence')
    for (const citation of analysis.citations) {
      lines.push(
        ...wrappedLines(
          `  ${safeText(citation.id)}  ${safeText(citation.eventId)}  ${safeText(citation.text)}`,
          width,
        ),
      )
    }
    lines.push(
      '',
      ...analysis.footer.map((field) => `${safeText(field.label)}: ${safeText(field.value)}`),
    )
    return lines
  }
}
