import { COMMAND_DEFINITIONS } from '../shared/command-registry.js'
import { SurfacePanel, safeText } from './surface-panel.js'
import type { BraidTheme } from './theme.js'

export class HelpViewPanel extends SurfacePanel {
  #query = ''

  constructor(theme: BraidTheme) {
    super({ title: 'help', theme, footer: 'type a command in the composer  ·  esc close' })
  }

  setQuery(query: string): void {
    this.#query = query
  }

  protected body(): string[] {
    const normalized = this.#query.trim().toLowerCase()
    const definitions = COMMAND_DEFINITIONS.filter(
      (definition) =>
        !normalized ||
        `${definition.name} ${definition.description}`.toLowerCase().includes(normalized),
    )
    const rows = [
      'Ctrl+P  command palette',
      'Ctrl+O  conversation search',
      'Ctrl+K  profile / runner switcher',
      'Ctrl+G  graph',
      'F2      activity pane',
      '?       compact help',
      'Ctrl+C  clear, cancel, then quit',
      '/help   search this compact guide',
      '',
    ]
    rows.push(
      ...definitions
        .slice(0, 8)
        .map((definition) => `${safeText(definition.usage)}  ${safeText(definition.description)}`),
    )
    if (definitions.length > 8) rows.push(`+ ${definitions.length - 8} more commands in Ctrl+P`)
    return rows
  }
}
