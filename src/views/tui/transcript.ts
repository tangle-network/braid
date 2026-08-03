import { Box, Container, Spacer, Text, truncateToWidth } from '@earendil-works/pi-tui'
import type { BraidViewModel, MessageView, TranscriptPartView } from '../shared/models.js'
import { sanitizeDiff, sanitizeMarkdown, sanitizeTerminalText } from '../shared/sanitize.js'
import { SafeMarkdown } from './safe-markdown.js'
import type { BraidTheme } from './theme.js'

export class TranscriptView extends Container {
  readonly #theme: BraidTheme
  #headerText: Text | undefined
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.#view = view
    this.clear()
    this.#headerText = new Text(this.#header(view, 80), 1, 0)
    this.addChild(this.#headerText)
    if (view.hiddenMessageCount > 0) {
      this.addChild(
        new Text(this.#theme.muted(`${view.hiddenMessageCount} earlier messages hidden`), 1, 0),
      )
    }
    for (const message of view.messages) this.addChild(this.#message(message))
    if (view.messages.length === 0) {
      this.addChild(new Spacer(1))
      this.addChild(
        new Text(this.#theme.muted('Write a message, or press Ctrl+P for commands.'), 1, 0),
      )
    }
    this.invalidate()
  }

  override render(width: number): string[] {
    if (this.#view && this.#headerText) this.#headerText.setText(this.#header(this.#view, width))
    return super.render(width)
  }

  #header(view: BraidViewModel, width: number): string {
    const profile = sanitizeTerminalText(view.profileName)
    if (width < 80) {
      return truncateToWidth(
        `${this.#theme.brand('braid')}  ${this.#theme.text(profile)}  ${this.#theme.muted(view.statusText)}`,
        Math.max(1, width - 2),
        '…',
      )
    }
    const runner = sanitizeTerminalText(view.runner)
    const connection = sanitizeTerminalText(view.connection)
    return `${this.#theme.brand('braid')}  ${this.#theme.text(profile)}  ${this.#theme.muted(`${runner} · ${connection}`)}`
  }

  #message(message: MessageView): Container {
    const container = new Container()
    if (message.role === 'user') {
      const box = new Box(1, 0, this.#theme.userBackground)
      box.addChild(new SafeMarkdown(sanitizeMarkdown(message.text), 0, 0, this.#theme.markdown))
      container.addChild(box)
      return container
    }

    container.addChild(new Spacer(1))
    for (const part of message.parts) container.addChild(this.#part(part))
    if (message.parts.length === 0 && message.text) {
      container.addChild(
        new SafeMarkdown(sanitizeMarkdown(message.text), 1, 0, this.#theme.markdown),
      )
    }
    if (message.status === 'failed' || message.status === 'blocked') {
      container.addChild(new Text(this.#theme.danger(message.status), 1, 0))
    } else if (message.status === 'cancelled' || message.status === 'aborted') {
      container.addChild(new Text(this.#theme.warning('cancelled'), 1, 0))
    } else if (message.status === 'redacted') {
      container.addChild(new Text(this.#theme.muted('content removed'), 1, 0))
    } else if (message.status === 'streaming') {
      container.addChild(new Text(this.#theme.muted('Working…'), 1, 0))
    }
    return container
  }

  #part(part: TranscriptPartView): SafeMarkdown | Text | Container {
    const text =
      part.kind === 'artifact' || part.kind === 'tool'
        ? sanitizeDiff(part.text)
        : sanitizeMarkdown(part.text)
    const label = part.kind === 'text' ? '' : `${part.kind} `
    const status =
      part.status === 'running'
        ? this.#theme.warning('…')
        : part.status === 'failed'
          ? this.#theme.danger('failed')
          : ''
    const prefix = label ? this.#theme.muted(`${label}· `) : ''
    if (!text) return new Text(`${prefix}${status}`, 1, 0)
    const container = new Container()
    if (label || status) container.addChild(new Text(`${prefix}${status}`, 1, 0))
    container.addChild(new SafeMarkdown(text, 1, 0, this.#theme.markdown))
    return container
  }
}
