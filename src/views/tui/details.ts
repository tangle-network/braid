import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class DetailsViewPanel extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    const details = view.details
    this.addChild(new Text(this.#theme.brand(details?.title ?? 'details'), 1, 0))
    this.addChild(new Spacer(1))
    if (!details) {
      this.addChild(new Text(this.#theme.muted('Select a run or node for details.'), 1, 0))
    } else {
      for (const field of details.fields) this.addChild(this.#field(field.label, field.value))
    }
    this.invalidate()
  }

  #field(label: string, value: string): Text {
    return new Text(
      `${this.#theme.muted(`${sanitizeTerminalText(label)}:`)} ${sanitizeTerminalText(value)}`,
      1,
      0,
    )
  }
}
