import type { BraidViewModel } from '../shared/models.js'
import { SurfacePanel, safeText } from './surface-panel.js'
import type { BraidTheme } from './theme.js'

export class ConnectionSetupViewPanel extends SurfacePanel {
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme) {
    super({ title: 'connection', theme })
  }

  setView(view: BraidViewModel): void {
    this.#view = view
  }

  protected body(): string[] {
    const connection = this.#view?.connectionSetup
    if (!connection)
      return [
        'Connection setup is unavailable.',
        'The current application core does not expose connection storage.',
      ]
    return [
      `kind    ${safeText(connection.kind)}`,
      `health  ${safeText(connection.health)}`,
      ...connection.fields.map(
        (field) => `${safeText(field.label)}  ${field.secret ? '[secret]' : safeText(field.value)}`,
      ),
      ...(connection.capabilities.length > 0
        ? [`supports  ${connection.capabilities.map(safeText).join(', ')}`]
        : []),
      ...(connection.error ? [`error   ${safeText(connection.error)}`] : []),
    ]
  }
}
