import { Container, Text, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { BraidViewModel, MessageView, TranscriptPartView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export class TranscriptView extends Container {
  readonly #theme: BraidTheme
  #view: BraidViewModel | undefined

  constructor(theme: BraidTheme) {
    super()
    this.#theme = theme
  }

  setView(view: BraidViewModel): void {
    this.#view = view
    this.clear()
    this.addChild(new Text(this.#header(view), 0, 0))
    this.addChild(new Text(this.#context(view), 0, 0))
    if (view.hiddenMessageCount > 0) {
      this.addChild(
        new Text(this.#theme.muted(`${view.hiddenMessageCount} earlier messages hidden`), 0, 0),
      )
    }
    for (const message of view.messages) this.#addMessage(message)
    if (view.messages.length === 0) {
      this.addChild(new Text(this.#theme.muted('No turns yet. Type a message to begin.'), 0, 0))
      this.addChild(
        new Text(this.#theme.muted('Ctrl+P commands  ·  Ctrl+O conversations  ·  ? help'), 0, 0),
      )
    }
    this.invalidate()
  }

  #header(view: BraidViewModel): string {
    const profile = sanitizeTerminalText(view.profileName)
    const status = sanitizeTerminalText(view.statusText)
    if (view.conversationTitle) {
      return `${this.#theme.brand('braid')}  ${sanitizeTerminalText(view.conversationTitle)}  ${this.#theme.muted(`· ${profile} · ${status}`)}`
    }
    return `${this.#theme.brand('braid')} ${profile} ${status}`
  }

  #context(view: BraidViewModel): string {
    const branch = sanitizeTerminalText(view.branch)
    const workspace = sanitizeTerminalText(view.workspace ?? 'no workspace')
    const runner = sanitizeTerminalText(view.runner)
    return this.#theme.muted(`${branch}  ·  ${workspace}  ·  ${runner}`)
  }

  #addMessage(message: MessageView): void {
    const prefix = message.role === 'user' ? this.#theme.accent('you') : this.#theme.brand('braid')
    const text = sanitizeTerminalText(message.text)
    if (message.role === 'user') {
      this.#addWrapped(`${prefix}  `, text, 0, this.#theme.text)
      return
    }
    if (message.parts.length === 0 && text)
      this.#addWrapped(`${prefix}  `, text, 0, this.#theme.text)
    for (const part of message.parts) this.#addPart(part)
    if (message.status === 'failed' || message.status === 'blocked') {
      this.addChild(new Text(`      ${this.#theme.danger(message.status)}`, 0, 0))
    } else if (message.status === 'cancelled' || message.status === 'aborted') {
      this.addChild(new Text(`      ${this.#theme.warning('cancelled')}`, 0, 0))
    } else if (message.status === 'streaming') {
      this.addChild(
        new Text(
          `      ${this.#theme.warning('streaming')} ${this.#theme.muted('provider is still writing')}`,
          0,
          0,
        ),
      )
    } else if (!message.parts.some((part) => part.kind === 'text') && text) {
      this.#addWrapped('braid  ', text, 0, this.#theme.text)
    }
  }

  #addPart(part: TranscriptPartView): void {
    const text = sanitizeTerminalText(part.text)
    const status =
      part.status === 'running'
        ? this.#theme.warning('…')
        : part.status === 'failed'
          ? this.#theme.danger('failed')
          : ''
    if (part.kind === 'reasoning') {
      this.#addWrapped(`      ${this.#theme.muted('~')} `, text, 0, this.#theme.muted)
      return
    }
    if (part.kind === 'tool' || part.kind === 'result' || part.kind === 'artifact') {
      const label = part.kind === 'tool' ? 'tool' : part.kind
      const suffix = part.durationMs ? ` · ${part.durationMs}ms` : ''
      this.#addWrapped(
        `      ${this.#theme.accent(label)}${suffix}  `,
        `${text} ${status}`,
        0,
        this.#theme.text,
      )
      return
    }
    if (part.kind === 'warning' || part.kind === 'error') {
      this.#addWrapped(
        `      ${this.#theme.warning(part.kind)}  `,
        `${text} ${status}`,
        0,
        this.#theme.warning,
      )
      return
    }
    if (part.kind === 'text') {
      this.#addWrapped('      ', text, 0, this.#theme.text)
      return
    }
    this.#addWrapped(`      ${this.#theme.muted(part.kind)}  `, text, 0, this.#theme.text)
  }

  #addWrapped(
    prefix: string,
    text: string,
    indent: number,
    style: (value: string) => string,
  ): void {
    const safe = text || ' '
    const lines = wrapTextWithAnsi(style(safe), 72)
    for (const [index, line] of lines.entries()) {
      const lead = index === 0 ? prefix : `${' '.repeat(indent)}      `
      this.addChild(new Text(`${lead}${line}`, 0, 0))
    }
  }
}
