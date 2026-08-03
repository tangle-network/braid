import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import { COMMAND_DEFINITIONS } from '../shared/command-registry.js'
import type { BraidTheme } from './theme.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'

export class HelpViewPanel extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setQuery(query: string): void {
    this.clear()
    this.addChild(new Text(this.#theme.brand('help'), 1, 0))
    this.addChild(
      new Text(this.#theme.muted(`search: ${sanitizeTerminalText(query) || 'all commands'}`), 1, 0),
    )
    this.addChild(new Spacer(1))
    const normalized = query.trim().toLowerCase()
    const definitions = COMMAND_DEFINITIONS.filter(
      (definition) =>
        !normalized ||
        `${definition.name} ${definition.description}`.toLowerCase().includes(normalized),
    )
    for (const definition of definitions) {
      this.addChild(
        new Text(
          `${this.#theme.accent(definition.usage)} — ${sanitizeTerminalText(definition.description)}`,
          1,
          0,
        ),
      )
    }
    this.addChild(new Spacer(1))
    this.addChild(
      new Text(
        this.#theme.muted('Ctrl+P commands · Ctrl+O conversations · Ctrl+G graph · Esc close'),
        1,
        0,
      ),
    )
    this.invalidate()
  }
}
