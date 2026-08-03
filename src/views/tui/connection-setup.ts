import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class ConnectionSetupViewPanel extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    const connection = view.connectionSetup
    this.addChild(new Text(this.#theme.brand('connection'), 1, 0))
    this.addChild(new Spacer(1))
    if (!connection) {
      this.addChild(new Text(this.#theme.muted('Connection setup is unavailable.'), 1, 0))
      this.addChild(
        new Text(
          this.#theme.warning('The current application core does not expose connection storage.'),
          1,
          0,
        ),
      )
    } else {
      this.addChild(new Text(`kind: ${sanitizeTerminalText(connection.kind)}`, 1, 0))
      this.addChild(new Text(`health: ${sanitizeTerminalText(connection.health)}`, 1, 0))
      for (const field of connection.fields) {
        const value = field.secret ? '[secret]' : sanitizeTerminalText(field.value)
        this.addChild(new Text(`${sanitizeTerminalText(field.label)}: ${value}`, 1, 0))
      }
      if (connection.capabilities.length > 0) {
        this.addChild(
          new Text(
            `capabilities: ${connection.capabilities.map(sanitizeTerminalText).join(', ')}`,
            1,
            0,
          ),
        )
      }
      if (connection.error)
        this.addChild(new Text(this.#theme.danger(sanitizeTerminalText(connection.error)), 1, 0))
    }
    this.invalidate()
  }
}
