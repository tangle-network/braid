import {
  type Component,
  Container,
  type Focusable,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export interface ConfigurationReviewOptions {
  readonly theme: BraidTheme
  readonly summary: readonly string[]
  readonly compactSummary: readonly string[]
  readonly items: readonly SelectItem[]
  readonly title?: string
  readonly error?: string
  readonly onSelect: (item: SelectItem) => void
  readonly onCancel: () => void
}

/**
 * Compact review control for the final setup choice.
 * It intentionally has no input field: the review actions are few and should remain visible on a short terminal.
 */
export class ConfigurationReview extends Container implements Focusable {
  readonly #list: SelectList
  readonly #onCancel: () => void
  #focused = false

  constructor(options: ConfigurationReviewOptions) {
    super()
    this.#list = new SelectList([...options.items], 4, options.theme.select)
    this.#list.onSelect = options.onSelect
    this.#list.onCancel = options.onCancel
    this.#onCancel = options.onCancel
    this.addChild(new Text(options.theme.brand(options.title ?? 'review and start'), 1, 0))
    if (options.error !== undefined) {
      this.addChild(new Text(options.theme.danger(sanitizeTerminalText(options.error)), 1, 0))
    }
    this.addChild(new ReviewSummary(options.theme, options.summary, options.compactSummary))
    this.addChild(this.#list)
    this.addChild(new Text(options.theme.muted('enter choose · ↑↓ move · ←/esc cancel'), 1, 0))
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'left')) {
      this.#onCancel()
      return
    }
    this.#list.handleInput(data)
  }
}

class ReviewSummary implements Component {
  readonly #wide: Text
  readonly #theme: BraidTheme
  readonly #compact: readonly string[]

  constructor(theme: BraidTheme, wide: readonly string[], compact: readonly string[]) {
    this.#theme = theme
    this.#wide = new Text(theme.muted(wide.map(sanitizeTerminalText).join('\n')), 1, 0)
    this.#compact = compact.map(sanitizeTerminalText)
  }

  invalidate(): void {
    this.#wide.invalidate()
  }

  render(width: number): string[] {
    if (width > 44) return this.#wide.render(width)
    return this.#compact.map((line) =>
      this.#theme.muted(truncateToWidth(line, Math.max(1, width - 2), '…')),
    )
  }
}
