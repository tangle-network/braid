import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class ForkPreviewPanel extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    const preview = view.forkPreview
    this.addChild(new Text(this.#theme.brand('fork preview'), 1, 0))
    this.addChild(new Spacer(1))
    if (!preview) {
      this.addChild(new Text(this.#theme.muted('Fork preview is unavailable.'), 1, 0))
      this.addChild(
        new Text(
          this.#theme.warning(
            'Checkpoint and fork capabilities were not reported by the current core.',
          ),
          1,
          0,
        ),
      )
    } else {
      this.addChild(new Text(`kind: ${sanitizeTerminalText(preview.kind)}`, 1, 0))
      this.addChild(new Text(`source: ${sanitizeTerminalText(preview.source)}`, 1, 0))
      this.addChild(new Text(`destination: ${sanitizeTerminalText(preview.destination)}`, 1, 0))
      for (const field of preview.fields) {
        this.addChild(
          new Text(
            `${sanitizeTerminalText(field.label)}: ${sanitizeTerminalText(field.source)} → ${sanitizeTerminalText(field.destination)}`,
            1,
            0,
          ),
        )
      }
      if (!preview.allowed)
        this.addChild(
          new Text(
            this.#theme.warning(
              sanitizeTerminalText(preview.unavailableReason ?? 'Fork is unavailable'),
            ),
            1,
            0,
          ),
        )
    }
    this.invalidate()
  }
}
