import {
  Container,
  CURSOR_MARKER,
  Input,
  matchesKey,
  Spacer,
  Text,
  type Focusable,
} from '@earendil-works/pi-tui'
import type { InteractionResponseValue } from '../shared/intents.js'
import type { AnswerSpecView, InteractionView } from '../shared/models.js'
import { sanitizeDiff, sanitizeTerminalText } from '../shared/sanitize.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

class SecretInput extends Input {
  override render(width: number): string[] {
    const mask = Array.from(this.getValue(), () => '•').join('')
    const cursor = this.focused ? CURSOR_MARKER : ''
    return new Text(`${mask}${cursor}`, 1, 0).render(width)
  }
}

export class InteractionShell extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #interaction: InteractionView
  readonly #onRespond: (response: InteractionResponseValue) => void
  readonly #input: Input
  readonly #selector?: SearchableSelector
  readonly #validation = new Text('', 1, 0)
  #focused = false
  #responded = false
  #validationError: string | undefined

  constructor(
    interaction: InteractionView,
    theme: BraidTheme,
    onRespond: (response: InteractionResponseValue) => void,
  ) {
    super()
    this.#interaction = interaction
    this.#theme = theme
    this.#onRespond = onRespond
    this.#input =
      interaction.answerSpec.kind === 'secret' ||
      (interaction.answerSpec.kind === 'text' && interaction.answerSpec.secret)
        ? new SecretInput()
        : new Input()
    this.#input.onSubmit = (value) => this.#submitValue(value)
    this.#input.onEscape = () => this.#respond({ outcome: 'cancel' })

    this.addChild(new Text(this.#theme.brand(sanitizeTerminalText(interaction.kind)), 1, 0))
    this.addChild(new Text(sanitizeTerminalText(interaction.prompt), 1, 0))
    if (interaction.subject) this.#addSubject(interaction.subject)
    this.addChild(new Spacer(1))

    if (interaction.answerSpec.kind === 'select') {
      const selector = new SearchableSelector({
        title: 'choose a response',
        items: interaction.answerSpec.options.map((option) => ({
          value: option.value,
          label: option.label,
        })),
        theme,
        maxVisible: 6,
        onSelect: (item) => this.#respond({ outcome: 'accept', value: item.value }),
        onCancel: () => this.#respond({ outcome: 'cancel' }),
      })
      this.#selector = selector
      this.addChild(selector)
    } else {
      this.addChild(new Text(this.#answerHelp(interaction.answerSpec), 1, 0))
      this.addChild(this.#input)
    }
    this.addChild(this.#validation)
    if (interaction.allowedOutcomes.length > 0) {
      this.addChild(new Spacer(1))
      this.addChild(new Text(this.#outcomeHelp(interaction), 1, 0))
    }
    this.addChild(new Spacer(1))
    this.addChild(new Text(this.#theme.muted('enter submit · esc cancel'), 1, 0))
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    this.#input.focused = value && !this.#selector
    if (this.#selector) this.#selector.focused = value
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#respond({ outcome: 'cancel' })
      return
    }
    if (this.#selector) {
      this.#selector.handleInput(data)
      return
    }
    if (
      matchesKey(data, '1') ||
      matchesKey(data, '2') ||
      matchesKey(data, '3') ||
      matchesKey(data, '4') ||
      matchesKey(data, '5')
    ) {
      const index = Number(data) - 1
      const outcome = this.#interaction.allowedOutcomes[index]
      if (outcome) {
        this.#respond({ outcome })
        return
      }
    }
    if (
      this.#interaction.answerSpec.kind === 'boolean' &&
      (data === 'y' || data === 'Y' || data === 'n' || data === 'N')
    ) {
      this.#respond({ outcome: 'accept', value: data === 'y' || data === 'Y' })
      return
    }
    this.#input.handleInput(data)
  }

  #addSubject(subject: NonNullable<InteractionView['subject']>): void {
    this.addChild(
      new Text(this.#theme.muted(`subject: ${sanitizeTerminalText(subject.title)}`), 1, 0),
    )
    if (subject.target)
      this.addChild(new Text(`target: ${sanitizeTerminalText(subject.target)}`, 1, 0))
    if (subject.detail) this.addChild(new Text(sanitizeTerminalText(subject.detail), 1, 0))
    for (const line of subject.preview ?? []) {
      this.addChild(new Text(sanitizeDiff(line), 1, 0))
    }
  }

  #answerHelp(spec: AnswerSpecView): string {
    if (spec.kind === 'number')
      return `number${spec.minimum === undefined ? '' : ` ≥ ${spec.minimum}`}${spec.maximum === undefined ? '' : ` ≤ ${spec.maximum}`}`
    if (spec.kind === 'boolean') return 'yes/no'
    if (spec.kind === 'unknown') return sanitizeTerminalText(spec.label)
    if (spec.kind === 'select') return 'choose one response'
    if (spec.kind === 'secret') return 'secret response'
    return spec.secret ? 'secret response' : 'response'
  }

  #outcomeHelp(interaction: InteractionView): string {
    return interaction.allowedOutcomes
      .map((outcome, index) => `${index + 1}:${sanitizeTerminalText(outcome)}`)
      .join('  ')
  }

  #submitValue(value: string): void {
    const spec = this.#interaction.answerSpec
    if (spec.kind === 'number') {
      const number = Number(value)
      if (
        !Number.isFinite(number) ||
        (spec.minimum !== undefined && number < spec.minimum) ||
        (spec.maximum !== undefined && number > spec.maximum)
      ) {
        this.#validationError = 'Enter a number in the allowed range.'
        this.#validation.setText(this.#theme.danger(this.#validationError))
        return
      }
      this.#respond({ outcome: 'accept', value: number })
      return
    }
    if (spec.kind === 'unknown') {
      this.#respond({ outcome: 'cancel' })
      return
    }
    if (spec.required && value.length === 0) {
      this.#validationError = 'A response is required.'
      this.#validation.setText(this.#theme.danger(this.#validationError))
      return
    }
    this.#respond({ outcome: 'accept', value: spec.kind === 'boolean' ? value === 'true' : value })
  }

  #respond(response: InteractionResponseValue): void {
    if (this.#responded) return
    this.#responded = true
    this.#onRespond(response)
  }
}
