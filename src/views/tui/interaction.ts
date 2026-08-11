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
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { automationResponseFor } from './interaction-automation-response.js'
import { focusedSurfaceLines } from './focused-surface.js'
import { interactionInputResponse } from './interaction-input-response.js'
import {
  answerHelp,
  answerOutcome,
  cancellationOutcome,
  consequence,
  interactionFooter,
  interactionHeading,
  interactionSubjectComponents,
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
  readonly #onAutomate: ((response: InteractionResponseValue) => void) | undefined
  readonly #input: Input
  readonly #selector?: SearchableSelector
  readonly #rows: () => number
  readonly #validation = new Text('', 1, 0)
  readonly #consequence = new MutableTruncatedLine()
  #focused = false
  #responded = false
  #selectedOutcome: InteractionOutcome | undefined

  constructor(
    interaction: InteractionView,
    theme: BraidTheme,
    onRespond: (response: InteractionResponseValue) => void,
    onAutomate?: (response: InteractionResponseValue) => void,
    rows: () => number = () => 12,
  ) {
    super()
    this.#interaction = interaction
    this.#theme = theme
    this.#onRespond = onRespond
    this.#onAutomate = onAutomate
    this.#rows = rows
    this.#input = isSecretInteraction(interaction) ? new SecretInput() : new Input()
    this.#selectedOutcome = answerOutcome(interaction)
    this.#input.onSubmit = (value) => this.#submitValue(value)
    this.#input.onEscape = () => this.#cancel()

    const compactSelector = interaction.answerSpec.kind === 'select'
    this.addChild(
      this.#line(
        isSecretInteraction(interaction)
          ? 'Secret response requested; value stays hidden.'
          : sanitizeTerminalText(interaction.prompt),
      ),
    )
    this.#consequence.setValue(this.#theme.muted(consequence(interaction, this.#selectedOutcome)))
    this.addChild(this.#consequence)
    for (const child of interactionSubjectComponents(interaction, theme, compactSelector))
      this.addChild(child)

    if (interaction.answerSpec.kind === 'select') {
      const selector = new SearchableSelector({
        title: 'response',
        items: interaction.answerSpec.options.map((option) => ({
          value: option.value,
          label: option.label,
        })),
        theme,
        maxVisible: 1,
        embedded: true,
        onSelect: (item) => {
          const outcome = this.#selectedOutcome ?? answerOutcome(this.#interaction)
          if (outcome) this.#respond({ outcome, value: item.value })
          else this.#cancel()
        },
        onCancel: () => this.#cancel(),
      })
      this.#selector = selector
      this.addChild(selector)
      if (interaction.allowedOutcomes.length > 0)
        this.addChild(new OutcomeKeys(interaction.allowedOutcomes, theme))
    } else {
      this.addChild(this.#line(answerHelp(interaction)))
      this.addChild(this.#input)
      if (interaction.allowedOutcomes.length > 0)
        this.addChild(new OutcomeKeys(interaction.allowedOutcomes, theme))
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
    if (matchesKey(data, 'alt+a') && this.#onAutomate !== undefined) {
      if (isSecretInteraction(this.#interaction)) {
        this.#setValidation('Secret responses remain manual.')
        return
      }
      const response = this.#automationResponse()
      if (response === undefined) {
        this.#setValidation('Choose an accepted response before automating it.')
        return
      }
      this.#onAutomate(response)
      return
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.#cancel()
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
      if (
        ['text', 'secret', 'number', 'form'].includes(this.#interaction.answerSpec.kind) &&
        isPositiveOutcome(outcome)
      ) {
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

  override render(width: number): string[] {
    return focusedSurfaceLines({
      theme: this.#theme,
      title: interactionHeading(this.#interaction),
      context: runContext(this.#interaction),
      body: super.render(width),
      footer: interactionFooter(this.#interaction, this.#onAutomate !== undefined),
      width,
      rows: this.#rows(),
      preserveTailRows: 4,
    })
  }

  #submitValue(value: string): void {
    const result = interactionInputResponse(
      this.#interaction,
      this.#selectedOutcome ?? answerOutcome(this.#interaction),
      value,
    )
    if ('error' in result) this.#setValidation(result.error)
    else this.#respond(result.response)
  }

  #setValidation(message: string): void {
    this.#validation.setText(this.#theme.danger(message))
    if (!this.children.includes(this.#validation)) {
      const consequenceIndex = this.children.indexOf(this.#consequence)
      this.children.splice(Math.max(0, consequenceIndex + 1), 0, this.#validation)
    }
    this.invalidate()
  }

  #selectOutcome(outcome: InteractionOutcome): void {
    this.#selectedOutcome = outcome
    this.#consequence.setValue(this.#theme.muted(consequence(this.#interaction, outcome)))
    this.invalidate()
  }
  #respond(response: InteractionResponseValue): void {
    if (this.#responded) return
    if (!this.#interaction.allowedOutcomes.some((outcome) => outcome === response.outcome)) {
      this.#setValidation('That response is not allowed for this request.')
      return
    }
    this.#responded = true
    this.#onRespond(response)
  }
  #cancel(): void {
    const outcome = cancellationOutcome(this.#interaction)
    if (outcome === undefined) {
      this.#setValidation('Cancellation is not allowed for this request.')
      return
    }
    this.#respond({ outcome })
  }

  #automationResponse(): InteractionResponseValue | undefined {
    const selectedValue = this.#selector?.selectedItem()?.value
    return automationResponseFor({
      interaction: this.#interaction,
      outcome: this.#selectedOutcome ?? answerOutcome(this.#interaction),
      inputValue: this.#input.getValue(),
      ...(selectedValue === undefined ? {} : { selectedValue }),
    })
  }
  #line(value: string): TruncatedText {
    return new TruncatedText(value, 1, 0)
  }
}
