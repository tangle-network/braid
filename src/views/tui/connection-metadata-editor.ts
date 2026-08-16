import {
  Container,
  type Focusable,
  type Input,
  matchesKey,
  SelectList,
} from '@earendil-works/pi-tui'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  APPLY_DRAFT,
  BACK_TO_FIELDS,
  BACK_TO_KIND,
  CANCEL_DRAFT,
  CLOSE_EDITOR,
  createConnectionMetadataReviewList,
  emitConnectionMetadataDraft,
} from './connection-metadata-editor-actions.js'
import {
  buildConnectionMetadataInputs,
  captureConnectionMetadataInput,
  handleConnectionMetadataFieldInput,
  syncConnectionMetadataInputFocus,
} from './connection-metadata-editor-inputs.js'
import {
  type ConnectionMetadataDraft,
  type ConnectionMetadataFormValues,
  type ConnectionMetadataKind,
  connectionMetadataDraftFromForm,
  connectionMetadataErrorText,
  isConnectionMetadataKind,
  type TrustedTransportPolicy,
} from './connection-metadata-editor-model.js'
import {
  connectionMetadataFieldKeys,
  connectionMetadataFormDefaults,
  connectionMetadataFormFromDraft,
  connectionMetadataKindItems,
} from './connection-metadata-editor-presentation.js'
import { connectionMetadataEditorChildren } from './connection-metadata-editor-rendering.js'
import type { BraidTheme } from './theme.js'

type EditableField = 'name' | 'endpoint' | 'account' | 'region'
type EditorStage = 'kind' | 'fields' | 'review'
export interface ConnectionMetadataEditorOptions {
  readonly theme: BraidTheme
  readonly initialDraft?: Partial<ConnectionMetadataDraft>
  readonly trustedTransportPolicy?: TrustedTransportPolicy
  readonly onApply: (draft: ConnectionMetadataDraft) => void | Promise<void>
  readonly onCancel: () => void
  readonly requestRender?: () => void
}
export class ConnectionMetadataEditor extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #onApply: ConnectionMetadataEditorOptions['onApply']
  readonly #onCancel: () => void
  readonly #requestRender: (() => void) | undefined
  readonly #trustedTransportPolicy: TrustedTransportPolicy | undefined
  readonly #kindList: SelectList
  readonly #inputs = new Map<EditableField, Input>()
  #form: ConnectionMetadataFormValues
  #stage: EditorStage = 'kind'
  #fieldIndex = 0
  #reviewDraft: ConnectionMetadataDraft | undefined
  #reviewList: SelectList | undefined
  #error: string | undefined
  #focused = false
  #busy = false
  #applied = false
  #closed = false
  constructor(options: ConnectionMetadataEditorOptions) {
    super()
    this.#theme = options.theme
    this.#onApply = options.onApply
    this.#onCancel = options.onCancel
    this.#requestRender = options.requestRender
    this.#trustedTransportPolicy = options.trustedTransportPolicy
    this.#form = connectionMetadataFormFromDraft(options.initialDraft)
    this.#kindList = new SelectList(
      [...connectionMetadataKindItems()],
      connectionMetadataKindItems().length,
      options.theme.select,
    )
    this.#kindList.setSelectedIndex(this.#kindIndex(this.#form.kind))
    this.#kindList.onSelect = (item) => this.#selectKind(item.value)
    this.#kindList.onCancel = () => this.#cancel()
    this.#render()
  }
  get focused(): boolean {
    return this.#focused
  }
  set focused(value: boolean) {
    this.#focused = value
    this.#syncInputFocus()
  }
  handleInput(data: string): void {
    if (this.#closed || this.#busy) return
    if (this.#stage === 'kind') {
      if (matchesKey(data, 'left')) {
        this.#cancel()
        return
      }
      this.#kindList.handleInput(data)
      return
    }
    if (this.#stage === 'review') {
      if (matchesKey(data, 'left')) {
        this.#cancel()
        return
      }
      this.#reviewList?.handleInput(data)
      return
    }
    this.#handleFieldInput(data)
  }
  #handleFieldInput(data: string): void {
    handleConnectionMetadataFieldInput(data, {
      kind: this.#form.kind,
      fieldIndex: this.#fieldIndex,
      inputs: this.#inputs,
      onAction: (action) => {
        if (action === 'cancel') this.#cancel()
        else if (action === 'back') this.#backField()
        else this.#nextField()
      },
      onValue: (field, value) => {
        this.#form = Object.freeze({ ...this.#form, [field]: value })
        this.#error = undefined
        this.invalidate()
        this.#requestRender?.()
      },
    })
  }
  #selectKind(value: string): void {
    if (!isConnectionMetadataKind(value)) return
    if (value !== this.#form.kind) this.#form = connectionMetadataFormDefaults(value)
    this.#stage = 'fields'
    this.#fieldIndex = 0
    this.#error = undefined
    this.#reviewDraft = undefined
    this.#reviewList = undefined
    this.#buildInputs()
    this.#redraw()
  }
  #buildInputs(): void {
    buildConnectionMetadataInputs(this.#form, this.#inputs)
    this.#syncInputFocus()
  }
  #nextField(): void {
    this.#captureActiveInput()
    const fields = connectionMetadataFieldKeys(this.#form.kind)
    if (this.#fieldIndex < fields.length - 1) {
      this.#fieldIndex += 1
      this.#syncInputFocus()
      this.#redraw()
      return
    }
    this.#enterReview()
  }
  #backField(): void {
    this.#captureActiveInput()
    if (this.#fieldIndex > 0) {
      this.#fieldIndex -= 1
      this.#syncInputFocus()
      this.#redraw()
      return
    }
    this.#stage = 'kind'
    this.#kindList.setSelectedIndex(this.#kindIndex(this.#form.kind))
    this.#redraw()
  }
  #enterReview(): void {
    const result = connectionMetadataDraftFromForm(this.#form, {
      ...(this.#trustedTransportPolicy === undefined
        ? {}
        : { trustedTransportPolicy: this.#trustedTransportPolicy }),
    })
    if (!result.ok) {
      this.#error = connectionMetadataErrorText(result.issues)
      const firstInvalid = result.issues.find((issue) =>
        connectionMetadataFieldKeys(this.#form.kind).includes(issue.field as EditableField),
      )
      if (firstInvalid !== undefined) {
        const index = connectionMetadataFieldKeys(this.#form.kind).indexOf(
          firstInvalid.field as EditableField,
        )
        if (index >= 0) this.#fieldIndex = index
      }
      this.#syncInputFocus()
      this.#redraw()
      return
    }
    this.#reviewDraft = result.draft
    this.#stage = 'review'
    this.#reviewList = this.#newReviewList()
    this.#redraw()
  }
  #newReviewList(): SelectList {
    return createConnectionMetadataReviewList({
      theme: this.#theme,
      busy: this.#busy,
      applied: this.#applied,
      onSelect: (value) => this.#selectReview(value),
      onCancel: () => this.#cancel(),
    })
  }
  #selectReview(value: string): void {
    if (value === CLOSE_EDITOR || value === CANCEL_DRAFT) {
      this.#cancel()
      return
    }
    if (value === BACK_TO_FIELDS) {
      this.#stage = 'fields'
      this.#fieldIndex = Math.max(0, connectionMetadataFieldKeys(this.#form.kind).length - 1)
      this.#error = undefined
      this.#buildInputs()
      this.#redraw()
      return
    }
    if (value === BACK_TO_KIND) {
      this.#stage = 'kind'
      this.#error = undefined
      this.#kindList.setSelectedIndex(this.#kindIndex(this.#form.kind))
      this.#redraw()
      return
    }
    if (value === APPLY_DRAFT) this.#apply()
  }
  #apply(): void {
    if (this.#busy || this.#reviewDraft === undefined) return
    const result = connectionMetadataDraftFromForm(this.#form, {
      ...(this.#trustedTransportPolicy === undefined
        ? {}
        : { trustedTransportPolicy: this.#trustedTransportPolicy }),
    })
    if (!result.ok) {
      this.#stage = 'fields'
      this.#error = connectionMetadataErrorText(result.issues)
      this.#buildInputs()
      this.#redraw()
      return
    }
    this.#reviewDraft = result.draft
    this.#busy = true
    this.#error = undefined
    this.#reviewList = this.#newReviewList()
    this.#redraw()
    emitConnectionMetadataDraft(
      result.draft,
      this.#onApply,
      () => this.#finishApply(),
      (error) => this.#failApply(error),
    )
  }
  #finishApply(): void {
    this.#busy = false
    this.#applied = true
    this.#reviewList = this.#newReviewList()
    this.#redraw()
  }
  #failApply(error: unknown): void {
    this.#busy = false
    this.#error = sanitizeTerminalText(
      error instanceof Error ? error.message : 'The connection draft could not be applied',
    )
    this.#reviewList = this.#newReviewList()
    this.#redraw()
  }
  #captureActiveInput(): void {
    this.#form = captureConnectionMetadataInput(this.#form, this.#inputs, this.#fieldIndex)
  }
  #syncInputFocus(): void {
    syncConnectionMetadataInputFocus(
      this.#inputs,
      this.#form.kind,
      this.#fieldIndex,
      this.#focused,
      this.#stage === 'fields',
    )
  }
  #kindIndex(kind: ConnectionMetadataKind): number {
    return connectionMetadataKindItems().findIndex((item) => item.value === kind)
  }
  #redraw(): void {
    this.#render()
    this.#requestRender?.()
  }
  #render(): void {
    this.#syncInputFocus()
    this.clear()
    for (const child of connectionMetadataEditorChildren({
      theme: this.#theme,
      stage: this.#stage,
      form: this.#form,
      kindList: this.#kindList,
      inputs: this.#inputs,
      ...(this.#reviewDraft === undefined ? {} : { reviewDraft: this.#reviewDraft }),
      ...(this.#reviewList === undefined ? {} : { reviewList: this.#reviewList }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
      busy: this.#busy,
      applied: this.#applied,
    })) {
      this.addChild(child)
    }
    this.invalidate()
  }
  #cancel(): void {
    if (this.#busy || this.#closed) return
    this.#closed = true
    this.#focused = false
    this.#syncInputFocus()
    this.#onCancel()
  }
}
