import type { BraidViewModel } from '../shared/models.js'
import { SurfacePanel, safeText, wrappedLines } from './surface-panel.js'
import type { BraidTheme } from './theme.js'

export class ForkPreviewPanel extends SurfacePanel {
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme, onConfirm?: () => void) {
    super({
      title: 'fork preview',
      theme,
      ...(onConfirm ? { onConfirm } : {}),
      footer: onConfirm ? 'enter create fork  ·  esc close' : 'esc close',
    })
  }

  setView(view: BraidViewModel): void {
    this.#view = view
  }

  protected body(width: number): string[] {
    const view = this.#view
    const preview = view?.forkPreview
    const result = view?.forkResult
    if (result) {
      return [
        `${safeText(result.status)}  ${safeText(result.kind)} fork`,
        ...wrappedLines(`${safeText(result.source)}  ->  ${safeText(result.destination)}`, width),
        ...(result.receipt ? [`receipt  ${safeText(result.receipt)}`] : []),
        ...(result.detail ? wrappedLines(safeText(result.detail), width) : []),
      ]
    }
    if (!preview)
      return [
        'Fork preview is unavailable.',
        'The current connection did not report checkpoint support.',
      ]
    const lines = [
      `${safeText(preview.kind)}  ${safeText(preview.source)}  ->  ${safeText(preview.destination)}`,
      '',
    ]
    for (const field of preview.fields) {
      lines.push(`${safeText(field.label)}`)
      lines.push(
        ...wrappedLines(`  ${safeText(field.source)}  ->  ${safeText(field.destination)}`, width),
      )
    }
    if (!preview.allowed)
      lines.push(`unavailable  ${safeText(preview.unavailableReason ?? 'Fork is unavailable')}`)
    return lines
  }
}
