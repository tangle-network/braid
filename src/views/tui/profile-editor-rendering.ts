import { type Component, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { safeFieldValue } from './configuration-presenters.js'
import type { BraidTheme } from './theme.js'

export function profileEditorChildren(
  theme: BraidTheme,
  view: BraidViewModel,
): readonly Component[] {
  const children: Component[] = []
  const editor = view.profileEditor
  if (editor === undefined) {
    children.push(new Text(theme.muted('No profile details loaded.'), 1, 0))
    children.push(
      new Text(theme.warning('Use /profile to list, validate, select, or save profiles.'), 1, 0),
    )
    return children
  }

  children.push(
    new Text(
      theme.muted(
        `source ${sanitizeTerminalText(editor.source)} · ${editor.readOnly ? 'read-only' : 'writable'}`,
      ),
      1,
      0,
    ),
    new Text(theme.muted(`digest ${sanitizeTerminalText(editor.digest)}`), 1, 0),
    new Text(theme.muted(`validation ${sanitizeTerminalText(editor.validation)}`), 1, 0),
  )
  for (const field of editor.fields) {
    const value = safeFieldValue(field.path, field.value, field.secret)
    children.push(new Text(`${sanitizeTerminalText(field.path)}: ${value}`, 1, 0))
  }
  if (editor.error !== undefined) {
    children.push(new Text(theme.danger(sanitizeTerminalText(editor.error)), 1, 0))
  }
  return children
}
