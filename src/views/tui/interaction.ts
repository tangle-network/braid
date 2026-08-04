import {
  Container,
  type Focusable,
  Input,
  matchesKey,
  Text,
  TruncatedText,
} from '@earendil-works/pi-tui'
import type { InteractionResponseValue } from '../shared/intents.js'
import type { InteractionOutcome, InteractionView } from '../shared/models.js'
import { sanitizeDiff, sanitizeTerminalText } from '../shared/sanitize.js'
import {
  answerHelp,
  answerOutcome,
  consequence,
  interactionHeading,
  isPositiveOutcome,
  isSecretInteraction,
  MutableTruncatedLine,
  OutcomeKeys,
  outcomeForKey,
  rejectionOutcome,
  runContext,
  SecretInput,
} from './interaction-presentation.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

export class InteractionShell extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #interaction: InteractionView
  readonly #onRespond: (response: InteractionResponseValue) => void
  readonly #input: Input
  readonly #selector?: SearchableSelector
  readonly #validation = new Text('', 1, 0)
  readonly #consequence = new MutableTruncatedLine()
  #focused = false
  #responded = false
  #selectedOutcome: InteractionOutcome | undefined

  constructor(
    interaction: InteractionView,
    theme: BraidTheme,
    onRespond: (response: InteractionResponseValue) => void,
  ) {
    super()
    this.#interaction = interaction
    this.#theme = theme
    this.#onRespond = onRespond
    this.#input = isSecretInteraction(interaction) ? new SecretInput() : new Input()
    this.#selectedOutcome = answerOutcome(interaction)
    this.#input.onSubmit = (value) => this.#submitValue(value)
    this.#input.onEscape = () => this.#respond({ outcome: 'cancel' })

    const compactSelector = interaction.answerSpec.kind === 'select'
    this.addChild(this.#line(this.#theme.brand(interactionHeading(interaction))))
    if (!compactSelector) this.addChild(this.#line(runContext(interaction)))
    this.addChild(
      this.#line(
        isSecretInteraction(interaction)
          ? 'Secret response requested; value stays hidden.'
          : sanitizeTerminalText(interaction.prompt),
      ),
    )
    this.#consequence.setValue(this.#theme.muted(consequence(interaction, this.#selectedOutcome)))
    this.addChild(this.#consequence)
    if (interaction.subject) this.#addSubject(interaction.subject, compactSelector)

    if (interaction.answerSpec.kind === 'select') {
      const selector = new SearchableSelector({
        title: 'response',
        items: interaction.answerSpec.options.map((option) => ({
          value: option.value,
          label: option.label,
        })),
        theme,
        maxVisible: 1,
        footer: '↑↓ move · enter choose · esc cancel',
        onSelect: (item) => {
          const outcome = this.#selectedOutcome ?? answerOutcome(this.#interaction)
          if (outcome) this.#respond({ outcome, value: item.value })
          else this.#respond({ outcome: 'cancel' })
        },
        onCancel: () => this.#respond({ outcome: 'cancel' }),
      })
      this.#selector = selector
      if (interaction.allowedOutcomes.length > 0)
        this.addChild(new OutcomeKeys(interaction.allowedOutcomes, theme))
      this.addChild(selector)
    } else {
      this.addChild(this.#line(answerHelp(interaction)))
      this.addChild(this.#input)
      this.addChild(this.#validation)
      if (interaction.allowedOutcomes.length > 0)
        this.addChild(new OutcomeKeys(interaction.allowedOutcomes, theme))
      this.addChild(this.#line(this.#theme.muted('enter submit · esc cancel')))
    }
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
      const outcome = outcomeForKey(data, this.#interaction.allowedOutcomes)
      if (outcome !== undefined) {
        if (isPositiveOutcome(outcome)) this.#selectOutcome(outcome)
        else this.#respond({ outcome })
        return
      }
      this.#selector.handleInput(data)
      return
    }
    const outcome = outcomeForKey(data, this.#interaction.allowedOutcomes)
    if (outcome !== undefined) {
      if (this.#interaction.answerSpec.kind === 'boolean') {
        this.#respond({ outcome, ...(isPositiveOutcome(outcome) ? { value: true } : {}) })
        return
      }
      if (isEditableInteraction(this.#interaction) && isPositiveOutcome(outcome)) {
        this.#selectOutcome(outcome)
        return
      }
      this.#respond({ outcome })
      return
    }
    if (this.#interaction.answerSpec.kind === 'boolean') {
      const approval = answerOutcome(this.#interaction)
      const rejection = rejectionOutcome(this.#interaction)
      if ((data === 'y' || data === 'Y') && approval) {
        this.#respond({ outcome: approval, value: true })
        return
      }
      if ((data === 'n' || data === 'N') && (rejection || approval)) {
        this.#respond(
          rejection
            ? { outcome: rejection }
            : { outcome: approval as InteractionOutcome, value: false },
        )
        return
      }
    }
    this.#input.handleInput(data)
  }

  #addSubject(subject: NonNullable<InteractionView['subject']>, compact: boolean): void {
    if (isSecretInteraction(this.#interaction)) {
      this.addChild(this.#line(this.#theme.muted('request: secret input · details hidden')))
      return
    }
    const title = sanitizeTerminalText(subject.title)
    const target = subject.target ? ` · ${sanitizeTerminalText(subject.target)}` : ''
    this.addChild(this.#line(this.#theme.muted(`request: ${title}${target}`)))
    if (compact) return
    if (subject.detail) this.addChild(this.#line(`detail: ${sanitizeTerminalText(subject.detail)}`))
    const preview = subject.preview ?? []
    if (preview.length > 0) this.addChild(this.#line(sanitizeDiff(preview[0] ?? '')))
  }

  #submitValue(value: string): void {
    const spec = this.#interaction.answerSpec
    const outcome = this.#selectedOutcome ?? answerOutcome(this.#interaction)
    if (!outcome) {
      this.#respond({ outcome: 'cancel' })
      return
    }
    if (spec.kind === 'number') {
      const number = Number(value)
      if (
        !Number.isFinite(number) ||
        (spec.minimum !== undefined && number < spec.minimum) ||
        (spec.maximum !== undefined && number > spec.maximum)
      ) {
        this.#setValidation('Enter a number in the allowed range.')
        return
      }
      this.#respond({ outcome, value: number })
      return
    }
    if (spec.kind === 'unknown') {
      this.#respond({ outcome: 'cancel' })
      return
    }
    if (spec.kind === 'form') {
      try {
        const parsed: unknown = JSON.parse(value)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error()
        this.#respond({
          outcome,
          data: parsed as Record<string, string | number | boolean | readonly string[]>,
        })
      } catch {
        this.#setValidation('Enter a JSON object with the requested fields')
      }
      return
    }
    if (spec.required && value.length === 0) {
      this.#setValidation('A response is required.')
      return
    }
    if (spec.kind === 'boolean' && value !== 'true' && value !== 'false') {
      this.#setValidation('Enter true or false, or use y/n.')
      return
    }
    this.#respond({ outcome, value: spec.kind === 'boolean' ? value === 'true' : value })
  }

  #setValidation(message: string): void {
    this.#validation.setText(this.#theme.danger(message))
    this.invalidate()
  }

  #selectOutcome(outcome: InteractionOutcome): void {
    this.#selectedOutcome = outcome
    this.#consequence.setValue(this.#theme.muted(consequence(this.#interaction, outcome)))
    this.invalidate()
  }

  #respond(response: InteractionResponseValue): void {
    if (this.#responded) return
    this.#responded = true
    this.#onRespond(response)
  }

  #line(value: string): TruncatedText {
    return new TruncatedText(value, 1, 0)
  }
}

function isEditableInteraction(interaction: InteractionView): boolean {
  return ['text', 'secret', 'number', 'form'].includes(interaction.answerSpec.kind)
}
