import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import { COMMAND_DEFINITIONS } from '../shared/command-registry.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export interface HelpViewOptions {
  readonly keyboardDiagnostic?: string
  readonly keymapDiagnostic?: string
}

export class HelpViewPanel extends Container {
  readonly #theme: BraidTheme
  readonly #options: HelpViewOptions

  constructor(theme: BraidTheme, options: HelpViewOptions = {}) {
    super()
    this.#theme = theme
    this.#options = options
  }

  setQuery(query: string): void {
    this.clear()
    this.addChild(new Text(this.#theme.brand('help'), 1, 0))
    this.addChild(
      new Text(this.#theme.muted(`search: ${sanitizeTerminalText(query) || 'all commands'}`), 1, 0),
    )
    this.addChild(new Spacer(1))
    if (this.#options.keyboardDiagnostic) {
      this.addChild(
        new Text(this.#theme.muted(sanitizeTerminalText(this.#options.keyboardDiagnostic)), 1, 0),
      )
    }
    if (this.#options.keymapDiagnostic) {
      this.addChild(
        new Text(this.#theme.warning(sanitizeTerminalText(this.#options.keymapDiagnostic)), 1, 0),
      )
    }
    if (this.#options.keyboardDiagnostic || this.#options.keymapDiagnostic) {
      this.addChild(new Spacer(1))
    }
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
        this.#theme.muted(
          'Ctrl+P commands · Ctrl+O conversations · Ctrl+K profiles · Ctrl+G graph',
        ),
        1,
        0,
      ),
    )
    this.addChild(
      new Text(
        this.#theme.muted(
          'Ctrl+C clear/cancel/quit · Ctrl+D quit · Alt+↑/↓ branches · F2 activity',
        ),
        1,
        0,
      ),
    )
    this.addChild(
      new Text(this.#theme.muted('PgUp/PgDn history · Home/End bounds · Ctrl+E next detail'), 1, 0),
    )
    this.invalidate()
  }
}
