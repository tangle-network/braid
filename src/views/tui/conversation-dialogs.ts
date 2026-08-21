import {
  Container,
  type Focusable,
  Input,
  matchesKey,
  Spacer,
  Text,
  TruncatedText,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import type { BraidTheme } from './theme.js'

export interface ConversationConfirmationOptions {
  readonly theme: BraidTheme
  readonly title: string
  readonly target: string
  readonly detail: string
  readonly confirmLabel?: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export class ConversationConfirmation extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #title: TruncatedText
  readonly #target: TruncatedText
  readonly #detail: Text
  readonly #error: Text
  readonly #onConfirm: () => void
  readonly #onCancel: () => void
  #focused = false
  #submitted = false

  constructor(options: ConversationConfirmationOptions) {
    super()
    this.#theme = options.theme
    this.#title = new TruncatedText(this.#theme.brand(sanitizeTerminalText(options.title)), 1, 0)
    this.#target = new TruncatedText(`target: ${sanitizeTerminalText(options.target)}`, 1, 0)
    this.#detail = new Text(
      this.#theme.muted(
        `will ${sanitizeTerminalText(options.confirmLabel ?? 'confirm')}: ${sanitizeTerminalText(options.detail)}`,
      ),
      1,
      0,
    )
    this.#error = new Text('', 1, 0)
    this.#onConfirm = options.onConfirm
    this.#onCancel = options.onCancel
    this.addChild(this.#title)
    this.addChild(new Spacer(1))
    this.addChild(this.#target)
    this.addChild(this.#detail)
    this.addChild(this.#error)
    this.addChild(new Spacer(1))
    this.addChild(new TruncatedText(this.#theme.muted('enter/y confirm · n/←/esc cancel'), 1, 0))
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
  }

  setError(message: string): void {
    this.#submitted = false
    this.#error.setText(this.#theme.danger(sanitizeTerminalText(message)))
    this.invalidate()
  }

  handleInput(data: string): void {
    if (this.#submitted) return
    if (
      matchesKey(data, 'escape') ||
      matchesKey(data, 'ctrl+c') ||
      matchesKey(data, 'left') ||
      matchesKey(data, 'n')
    ) {
      this.#onCancel()
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'y')) {
      this.#submitted = true
      this.#error.setText(this.#theme.muted('working…'))
      this.invalidate()
      this.#onConfirm()
    }
  }
}

export interface ConversationRenameOptions {
  readonly theme: BraidTheme
  readonly currentTitle: string
  readonly onSubmit: (title: string) => void
  readonly onCancel: () => void
}

export class ConversationRename extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #input = new Input()
  readonly #error: Text
  readonly #onSubmit: (title: string) => void
  readonly #onCancel: () => void
  #focused = false
  #submitted = false

  constructor(options: ConversationRenameOptions) {
    super()
    this.#theme = options.theme
    this.#onSubmit = options.onSubmit
    this.#onCancel = options.onCancel
    this.#input.setValue('')
    this.#error = new Text('', 1, 0)
    this.addChild(new Text(this.#theme.brand('rename conversation'), 1, 0))
    this.addChild(new Spacer(1))
    this.addChild(new Text(`current: ${sanitizeTerminalText(options.currentTitle)}`, 1, 0))
    this.addChild(new Text(this.#theme.muted('title'), 1, 0))
    this.addChild(this.#input)
    this.addChild(this.#error)
    this.addChild(new Spacer(1))
    this.addChild(new Text(this.#theme.muted('enter save · esc cancel'), 1, 0))
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#input.focused = value
  }

  setError(message: string): void {
    this.#submitted = false
    this.#error.setText(this.#theme.danger(sanitizeTerminalText(message)))
    this.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onCancel()
      return
    }
    if (this.#submitted) return
    if (matchesKey(data, 'enter')) {
      const title = this.#input.getValue().trim()
      if (!title) {
        this.setError('A conversation title is required')
        return
      }
      this.#submitted = true
      this.#error.setText(this.#theme.muted('saving…'))
      this.invalidate()
      this.#onSubmit(title)
      return
    }
    this.#input.handleInput(data)
  }
}
