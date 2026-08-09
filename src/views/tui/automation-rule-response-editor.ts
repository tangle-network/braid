import {
  Container,
  type Focusable,
  Input,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  TruncatedText,
} from '@earendil-works/pi-tui'
import type { InteractionResponseValue } from '../shared/intents.js'
import type { AnswerSpecView, InteractionView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  interactionSummary,
  positiveOutcome,
  responseValue,
  safeResponse,
} from './automation-rule-presentation.js'
import type { BraidTheme } from './theme.js'

export interface RuleResponseEditorOptions {
  readonly interaction: InteractionView
  readonly proposedResponse: InteractionResponseValue
  readonly theme: BraidTheme
  readonly onResponse: (response: InteractionResponseValue) => void
  readonly onCancel: () => void
}

type EditableAnswerSpec = Exclude<AnswerSpecView, { readonly kind: 'form' }>
type ResponseValue = string | number | boolean

export class RuleResponseEditor extends Container implements Focusable {
  readonly #interaction: InteractionView
  readonly #theme: BraidTheme
  readonly #onResponse: (response: InteractionResponseValue) => void
  readonly #onCancel: () => void
  readonly #outcome: string
  readonly #error = new Text('', 0, 0)
  #input: Input | undefined
  #choices: SelectList | undefined
  #focused = false

  constructor(options: RuleResponseEditorOptions) {
    super()
    this.#interaction = options.interaction
    this.#theme = options.theme
    this.#onResponse = options.onResponse
    this.#onCancel = options.onCancel
    this.#outcome = positiveOutcome(options.interaction, options.proposedResponse)
    const spec = options.interaction.answerSpec
    if (spec.kind === 'form') this.#buildUnsupported()
    else this.#buildSingle(spec, options.proposedResponse)
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    if (this.#input) this.#input.focused = value
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#onCancel()
      return
    }
    if (this.#input !== undefined) {
      this.#input.handleInput(data)
      return
    }
    this.#choices?.handleInput(data)
  }

  #buildSingle(spec: EditableAnswerSpec, response: InteractionResponseValue): void {
    this.#addHeader()
    switch (spec.kind) {
      case 'text': {
        const input = new Input()
        const value = responseValue(response)
        input.setValue(typeof value === 'string' ? value : '')
        input.onSubmit = (next) => this.#submitText(next, spec.required, spec.maxLength)
        input.onEscape = () => this.#onCancel()
        this.#input = input
        this.addChild(new TruncatedText('response', 0, 0))
        this.addChild(input)
        break
      }
      case 'number': {
        const input = new Input()
        const value = responseValue(response)
        input.setValue(typeof value === 'number' ? String(value) : '')
        input.onSubmit = (next) =>
          this.#submitNumber(next, spec.required, spec.minimum, spec.maximum)
        input.onEscape = () => this.#onCancel()
        this.#input = input
        this.addChild(new TruncatedText('response · number', 0, 0))
        this.addChild(input)
        break
      }
      case 'boolean': {
        const proposed = responseValue(response)
        const value = typeof proposed === 'boolean' ? proposed : (spec.defaultValue ?? true)
        this.#choices = this.#choiceList(
          [
            { value: 'true', label: 'yes' },
            { value: 'false', label: 'no' },
          ],
          String(value),
          (item) => this.#finishResponse(item.value === 'true'),
        )
        this.addChild(new TruncatedText('response · choose', 0, 0))
        this.addChild(this.#choices)
        break
      }
      case 'select': {
        const proposed = responseValue(response)
        const value =
          typeof proposed === 'string'
            ? proposed
            : sanitizeTerminalText(spec.options[0]?.value ?? '')
        const items = spec.options.map((option) => ({
          value: sanitizeTerminalText(option.value),
          label: sanitizeTerminalText(option.label),
        }))
        this.#choices = this.#choiceList(items, value, (item) => this.#finishResponse(item.value))
        this.addChild(new TruncatedText('response · choose', 0, 0))
        this.addChild(this.#choices)
        break
      }
      case 'secret':
      case 'unknown':
        this.#buildUnsupported()
        return
    }
    this.#addFooter()
    if (this.#input) this.#input.focused = this.#focused
  }

  #buildUnsupported(): void {
    this.#addHeader()
    this.addChild(new TruncatedText(this.#theme.warning('manual response only'), 0, 0))
    this.#addFooter()
  }

  #choiceList(
    items: readonly SelectItem[],
    selectedValue: string | undefined,
    onSelect: (item: SelectItem) => void,
  ): SelectList {
    const list = new SelectList(
      [...items],
      Math.min(4, Math.max(1, items.length)),
      this.#theme.select,
    )
    const selectedIndex = items.findIndex((item) => item.value === selectedValue)
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex)
    list.onSelect = onSelect
    list.onCancel = () => this.#onCancel()
    return list
  }

  #submitText(value: string, required: boolean, maxLength: number | undefined): void {
    const safe = sanitizeTerminalText(value)
    if (required && safe.length === 0) {
      this.#setError('a response is required')
      return
    }
    if (maxLength !== undefined && [...safe].length > maxLength) {
      this.#setError(`response is limited to ${maxLength} characters`)
      return
    }
    this.#finishResponse(safe)
  }

  #submitNumber(
    value: string,
    required: boolean,
    minimum: number | undefined,
    maximum: number | undefined,
  ): void {
    const safe = sanitizeTerminalText(value).trim()
    if (safe.length === 0 && !required) {
      this.#finishResponse()
      return
    }
    const number = Number(safe)
    if (
      !Number.isFinite(number) ||
      (minimum !== undefined && number < minimum) ||
      (maximum !== undefined && number > maximum)
    ) {
      this.#setError('enter a number in the allowed range')
      return
    }
    this.#finishResponse(number)
  }

  #finishResponse(value?: ResponseValue): void {
    this.#onResponse(
      safeResponse({
        outcome: this.#outcome,
        ...(value === undefined ? {} : { value }),
      }),
    )
  }

  #addHeader(): void {
    this.clear()
    this.#input = undefined
    this.#choices = undefined
    this.addChild(new TruncatedText(this.#theme.brand('new automation rule'), 0, 0))
    this.addChild(new TruncatedText(`on: ${interactionSummary(this.#interaction)}`, 0, 0))
  }

  #addFooter(): void {
    this.addChild(this.#error)
    this.addChild(new TruncatedText('enter continue · esc cancel', 0, 0))
  }

  #setError(message: string): void {
    this.#error.setText(this.#theme.danger(sanitizeTerminalText(message)))
    this.invalidate()
  }
}
