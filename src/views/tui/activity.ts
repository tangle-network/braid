import { Container, Text } from '@earendil-works/pi-tui'
import type { ActivityItemView, BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'
import { tone } from './surface-panel.js'

export class ActivityView extends Container {
  readonly #theme: BraidTheme

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.clear()
    this.addChild(new Text(this.#theme.brand('activity'), 0, 0))
    this.addChild(
      new Text(this.#theme.muted(`${view.statusText}  ·  ${view.queueCount} queued`), 0, 0),
    )
    this.addChild(new Text('', 0, 0))
    if (view.activity.length === 0) {
      this.addChild(new Text(this.#theme.muted('Nothing is running.'), 0, 0))
    } else {
      for (const item of view.activity) this.addChild(this.#item(item))
    }
    this.addChild(new Text('', 0, 0))
    this.addChild(new Text(this.#theme.muted('F2 hide  ·  Ctrl+G graph'), 0, 0))
    this.invalidate()
  }

  #item(item: ActivityItemView): Text {
    const status = sanitizeTerminalText(item.status)
    const detail = item.detail ? `  ${sanitizeTerminalText(item.detail)}` : ''
    const title = sanitizeTerminalText(item.title)
    return new Text(`${tone(this.#theme, status)}  ${title}${this.#theme.muted(detail)}`, 0, 0)
  }
}
