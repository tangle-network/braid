import { type Component, Spacer, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { safeFieldValue } from './configuration-presenters.js'
import type { BraidTheme } from './theme.js'

export function connectionSetupChildren(
  theme: BraidTheme,
  view: BraidViewModel,
): readonly Component[] {
  const children: Component[] = [new Text(theme.brand('connection'), 1, 0), new Spacer(1)]
  const connection = view.connectionSetup
  if (connection === undefined) {
    children.push(new Text(theme.muted('No connection details loaded.'), 1, 0))
    children.push(
      new Text(theme.warning('Use /connection to list, test, or select connections.'), 1, 0),
    )
    return children
  }

  children.push(
    new Text(
      theme.muted(
        `kind ${sanitizeTerminalText(connection.kind)} · health ${sanitizeTerminalText(connection.health)}`,
      ),
      1,
      0,
    ),
  )
  for (const field of connection.fields) {
    const value = safeFieldValue(field.label, field.value, field.secret)
    children.push(new Text(`${sanitizeTerminalText(field.label)}: ${value}`, 1, 0))
  }
  if (connection.capabilities.length > 0) {
    children.push(
      new Text(
        `capabilities: ${connection.capabilities.map(sanitizeTerminalText).join(', ')}`,
        1,
        0,
      ),
    )
  }
  if (connection.error !== undefined) {
    children.push(new Text(theme.danger(sanitizeTerminalText(connection.error)), 1, 0))
  }
  return children
}
