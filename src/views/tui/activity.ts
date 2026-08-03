import { Container, Spacer, Text } from '@earendil-works/pi-tui'
import type { ActivityItemView, BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class ActivityView extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    this.addChild(new Text(this.#theme.brand('activity'), 1, 0))
    this.addChild(new Spacer(1))
    if (view.activity.length === 0) {
      this.addChild(new Text(this.#theme.muted('No activity yet.'), 1, 0))
    } else {
      for (const item of view.activity) this.addChild(this.#item(item))
    }
    this.invalidate()
  }

  #item(item: ActivityItemView): Text {
    const status = sanitizeTerminalText(item.status)
    const detail = item.detail ? ` — ${sanitizeTerminalText(item.detail)}` : ''
    const title = sanitizeTerminalText(item.title)
    const color =
      item.status === 'failed' || item.status === 'storage-failure'
        ? this.#theme.danger
        : item.status === 'running'
          ? this.#theme.warning
          : this.#theme.muted
    return new Text(`${color(status)} ${title}${detail}`, 1, 0)
  }
}
