import { type Component, Text, TruncatedText } from '@earendil-works/pi-tui'

/**
 * Keeps operational context on one row in a short terminal while preserving the full detail at normal widths.
 */
export class ResponsiveText implements Component {
  readonly #wide: Text
  readonly #paddingX: number
  readonly #paddingY: number
  #compact = ''

  constructor(text: string, paddingX = 1, paddingY = 0, compactText = text) {
    this.#wide = new Text(text, paddingX, paddingY)
    this.#paddingX = paddingX
    this.#paddingY = paddingY
    this.#compact = compactText
  }

  invalidate(): void {
    this.#wide.invalidate()
  }

  setText(text: string, compactText = text): void {
    this.#wide.setText(text)
    this.#compact = compactText
    this.invalidate()
  }

  render(width: number): string[] {
    if (width > 44) return this.#wide.render(width)
    return new TruncatedText(this.#compact, this.#paddingX, this.#paddingY).render(width)
  }
}
