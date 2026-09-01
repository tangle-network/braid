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

export interface WorkerSteerPromptOptions {
  readonly theme: BraidTheme
  readonly worker: string
  readonly onSubmit: (message: string) => void
  readonly onCancel: () => void
}

class WorkerSteerPrompt extends Container implements Focusable {
  readonly #input = new Input()
  readonly #error: Text
  readonly #onSubmit: WorkerSteerPromptOptions['onSubmit']
  readonly #onCancel: WorkerSteerPromptOptions['onCancel']
  #focused = false
  #submitted = false

  constructor(options: WorkerSteerPromptOptions) {
    super()
    this.#onSubmit = options.onSubmit
    this.#onCancel = options.onCancel
    this.#error = new Text('', 1, 0)
    this.addChild(new TruncatedText(options.theme.brand('steer worker'), 1, 0))
    this.addChild(new Spacer(1))
    this.addChild(new TruncatedText(`worker: ${sanitizeTerminalText(options.worker)}`, 1, 0))
    this.addChild(new Text(options.theme.muted('message'), 1, 0))
    this.addChild(this.#input)
    this.addChild(this.#error)
    this.addChild(new Spacer(1))
    this.addChild(new TruncatedText(options.theme.muted('enter send · esc cancel'), 1, 0))
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
    this.#error.setText(sanitizeTerminalText(message))
    this.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onCancel()
      return
    }
    if (this.#submitted) return
    if (matchesKey(data, 'enter')) {
      const message = this.#input.getValue().trim()
      if (!message) {
        this.setError('A steering message is required')
        return
      }
      this.#submitted = true
      this.#onSubmit(message)
      return
    }
    this.#input.handleInput(data)
  }
}

export function createWorkerSteerPrompt(options: WorkerSteerPromptOptions): WorkerSteerPrompt {
  return new WorkerSteerPrompt(options)
}
