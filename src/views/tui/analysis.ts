import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { AnalysisView, BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class AnalysisViewPanel extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    const analysis = view.analysis
    this.addChild(new Text(this.#theme.brand('analysis'), 1, 0))
    this.addChild(new Spacer(1))
    if (!analysis) {
      this.addChild(new Text(this.#theme.muted('Analysis is unavailable.'), 1, 0))
      this.addChild(
        new Text(
          this.#theme.warning(
            'The current application core does not expose frozen trace analysis.',
          ),
          1,
          0,
        ),
      )
    } else {
      this.#renderAnalysis(analysis)
    }
    this.invalidate()
  }

  #renderAnalysis(analysis: AnalysisView): void {
    this.addChild(new Text(`source: ${sanitizeTerminalText(analysis.source)}`, 1, 0))
    this.addChild(new Text(`analyst: ${sanitizeTerminalText(analysis.analyst)}`, 1, 0))
    this.addChild(new Text(`recipe: ${sanitizeTerminalText(analysis.recipe)}`, 1, 0))
    this.addChild(new Text(`status: ${sanitizeTerminalText(analysis.status)}`, 1, 0))
    for (const finding of analysis.findings) {
      const severity = finding.severity ? ` [${sanitizeTerminalText(finding.severity)}]` : ''
      this.addChild(new Text(`• ${sanitizeTerminalText(finding.title)}${severity}`, 1, 0))
    }
    for (const citation of analysis.citations) {
      this.addChild(
        new Text(
          `cite ${sanitizeTerminalText(citation.id)}: ${sanitizeTerminalText(citation.text)}`,
          1,
          0,
        ),
      )
    }
    for (const field of analysis.footer) {
      this.addChild(
        new Text(
          `${sanitizeTerminalText(field.label)}: ${sanitizeTerminalText(field.value)}`,
          1,
          0,
        ),
      )
    }
    if (analysis.error)
      this.addChild(new Text(this.#theme.danger(sanitizeTerminalText(analysis.error)), 1, 0))
  }
}
