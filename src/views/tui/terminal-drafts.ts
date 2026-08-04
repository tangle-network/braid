import type { Editor } from '@earendil-works/pi-tui'
import type { BraidIntent, UiDispatchResult } from '../shared/intents.js'
import type { BraidViewModel } from '../shared/models.js'

type DraftView = Pick<BraidViewModel, 'conversationId' | 'branch' | 'draft'>
type DraftIntent = Extract<BraidIntent, { readonly type: 'set-draft' }>

export interface TerminalDraftOptions {
  readonly editor: Editor
  readonly dispatch: (intent: DraftIntent) => Promise<UiDispatchResult>
  readonly nextOperationId: () => string
  readonly requestRender: () => void
  readonly debounceMs?: number
}

export class TerminalDraftController {
  readonly #editor: Editor
  readonly #dispatch: TerminalDraftOptions['dispatch']
  readonly #nextOperationId: () => string
  readonly #requestRender: () => void
  readonly #debounceMs: number
  #timer: ReturnType<typeof setTimeout> | undefined
  #tail: Promise<void> = Promise.resolve()
  #conversationId: string | undefined
  #branchId: string | undefined
  #persisted = ''
  #suppressChange = false

  constructor(options: TerminalDraftOptions) {
    this.#editor = options.editor
    this.#dispatch = options.dispatch
    this.#nextOperationId = options.nextOperationId
    this.#requestRender = options.requestRender
    this.#debounceMs = options.debounceMs ?? 150
  }

  changed(text: string): void {
    this.#requestRender()
    if (this.#suppressChange || !this.#conversationId || !this.#branchId) return
    if (this.#timer) clearTimeout(this.#timer)
    const conversationId = this.#conversationId
    const branchId = this.#branchId
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#save(conversationId, branchId, text)
    }, this.#debounceMs)
  }

  restore(view: DraftView): void {
    if (this.#conversationId === view.conversationId && this.#branchId === view.branch) {
      if (this.#editor.getText() === this.#persisted && view.draft !== this.#persisted) {
        this.#persisted = view.draft
        this.setText(view.draft)
      }
      return
    }
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (this.#conversationId && this.#branchId) {
      const previousText = this.#editor.getText()
      if (previousText !== this.#persisted) {
        void this.#save(this.#conversationId, this.#branchId, previousText)
      }
    }
    this.#conversationId = view.conversationId
    this.#branchId = view.branch
    this.#persisted = view.draft
    this.setText(view.draft)
  }

  setText(text: string): void {
    this.#suppressChange = true
    try {
      this.#editor.setText(text)
    } finally {
      this.#suppressChange = false
    }
  }

  async flush(text = this.#editor.getText()): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
    if (!this.#conversationId || !this.#branchId) return
    await this.#save(this.#conversationId, this.#branchId, text)
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #save(conversationId: string, branchId: string, text: string): Promise<void> {
    if (
      conversationId === this.#conversationId &&
      branchId === this.#branchId &&
      text === this.#persisted
    ) {
      return this.#tail
    }
    const task = this.#tail.then(async () => {
      const result = await this.#dispatch({
        type: 'set-draft',
        operationId: this.#nextOperationId(),
        conversationId,
        branchId,
        text,
      })
      if (
        result.kind === 'accepted' &&
        conversationId === this.#conversationId &&
        branchId === this.#branchId
      ) {
        this.#persisted = text
      }
    })
    this.#tail = task.catch(() => undefined)
    return task
  }
}
