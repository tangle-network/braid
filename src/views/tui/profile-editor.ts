import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class ProfileEditorViewPanel extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    const editor = view.profileEditor
    this.addChild(new Text(this.#theme.brand('profile'), 1, 0))
    this.addChild(new Spacer(1))
    if (!editor) {
      this.addChild(new Text(this.#theme.muted('Profile editing is unavailable.'), 1, 0))
      this.addChild(
        new Text(
          this.#theme.warning('The current application core does not expose profile storage.'),
          1,
          0,
        ),
      )
    } else {
      this.addChild(new Text(`source: ${sanitizeTerminalText(editor.source)}`, 1, 0))
      this.addChild(new Text(`digest: ${sanitizeTerminalText(editor.digest)}`, 1, 0))
      this.addChild(new Text(`validation: ${sanitizeTerminalText(editor.validation)}`, 1, 0))
      for (const field of editor.fields) {
        const value = field.secret ? '[secret]' : sanitizeTerminalText(field.value)
        this.addChild(new Text(`${sanitizeTerminalText(field.path)}: ${value}`, 1, 0))
      }
      if (editor.error)
        this.addChild(new Text(this.#theme.danger(sanitizeTerminalText(editor.error)), 1, 0))
    }
    this.invalidate()
  }
}
