import { Container, Spacer, Text, TruncatedText } from '@earendil-works/pi-tui'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { projectActivityDocument, type ActivityDocumentItem } from './activity-document.js'
import type { BraidTheme } from './theme.js'

export class ActivityView extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    const document = projectActivityDocument(view)
    this.clear()
    this.addChild(new Text(this.#theme.brand('activity'), 1, 0))
    if (document.items.length === 0) {
      this.addChild(new Spacer(1))
      this.addChild(new Text(this.#theme.muted('No recorded activity.'), 1, 0))
    } else {
      this.addChild(new Spacer(1))
      for (const item of document.items) this.addChild(this.#item(item))
    }
    this.invalidate()
  }

  #item(item: ActivityDocumentItem): TruncatedText {
    const status = sanitizeTerminalText(item.status)
    const detail = item.summary !== item.title ? ` · ${sanitizeTerminalText(item.summary)}` : ''
    const title = sanitizeTerminalText(item.title)
    const color =
      item.status === 'failed' || item.status === 'storage-failure'
        ? this.#theme.danger
        : item.status === 'running'
          ? this.#theme.warning
          : item.status === 'complete' || item.status === 'completed'
            ? this.#theme.success
            : this.#theme.muted
    const symbol =
      item.status === 'failed' || item.status === 'storage-failure'
        ? 'x'
        : item.status === 'running'
          ? '>'
          : item.status === 'complete' || item.status === 'completed'
            ? 'ok'
            : '·'
    const elapsed = item.durationMs === undefined ? '' : ` ${Math.round(item.durationMs)}ms`
    return new TruncatedText(`${color(`${symbol} ${status}`)} ${title}${elapsed}${detail}`, 1, 0)
  }
}
