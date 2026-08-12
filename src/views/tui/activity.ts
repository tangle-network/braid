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
    const items = projectActivityDocument(view).items.filter(isLiveWork)
    this.clear()
    this.addChild(new Text(this.#theme.brand('live work'), 1, 0))
    if (items.length === 0) {
      this.addChild(new Spacer(1))
      this.addChild(new Text(this.#theme.muted('No live work.'), 1, 0))
    } else {
      this.addChild(new Spacer(1))
      for (const item of items) this.addChild(this.#item(item))
    }
    this.invalidate()
  }

  #item(item: ActivityDocumentItem): TruncatedText {
    const status = sanitizeTerminalText(item.status)
    const detail = item.summary !== item.title ? ` · ${sanitizeTerminalText(item.summary)}` : ''
    const title = sanitizeTerminalText(item.title)
    const active = item.status === 'running' || item.status === 'streaming'
    const color = active ? this.#theme.warning : this.#theme.muted
    const symbol = active ? '>' : '·'
    const elapsed = item.durationMs === undefined ? '' : ` ${Math.round(item.durationMs)}ms`
    return new TruncatedText(`${color(`${symbol} ${status}`)} ${title}${elapsed}${detail}`, 1, 0)
  }
}

const LIVE_WORK_STATUSES = new Set([
  'loading',
  'starting',
  'streaming',
  'running',
  'waiting',
  'detached',
  'reconnecting',
  'cancelling',
])

function isLiveWork(item: ActivityDocumentItem): boolean {
  return LIVE_WORK_STATUSES.has(item.status)
}
