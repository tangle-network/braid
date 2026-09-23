import type { BraidViewModel } from '../shared/models.js'
import { SurfacePanel, safeText, wrappedLines } from './surface-panel.js'
import type { BraidTheme } from './theme.js'

export class DetailsViewPanel extends SurfacePanel {
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme) {
    super({ title: 'run details', theme })
  }

  setView(view: BraidViewModel): void {
    this.#view = view
  }

  protected body(width: number): string[] {
    const details = this.#view?.details
    if (!details) return ['Select a run or node for details.']
    return details.fields.flatMap((field) =>
      wrappedLines(`${safeText(field.label)}: ${safeText(field.value)}`, width),
    )
  }
}
