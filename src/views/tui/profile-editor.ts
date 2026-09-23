import type { BraidViewModel } from '../shared/models.js'
import { SurfacePanel, safeText } from './surface-panel.js'
import type { BraidTheme } from './theme.js'

export class ProfileEditorViewPanel extends SurfacePanel {
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme) {
    super({ title: 'profile', theme })
  }

  setView(view: BraidViewModel): void {
    this.#view = view
  }

  protected body(): string[] {
    const editor = this.#view?.profileEditor
    if (!editor)
      return [
        'Profile editing is unavailable.',
        'The current application core does not expose profile storage.',
      ]
    return [
      `source  ${safeText(editor.source)}`,
      `digest  ${safeText(editor.digest)}`,
      `check   ${safeText(editor.validation)}`,
      ...editor.fields.map(
        (field) => `${safeText(field.path)}  ${field.secret ? '[secret]' : safeText(field.value)}`,
      ),
      ...(editor.error ? [`error   ${safeText(editor.error)}`] : []),
    ]
  }
}
