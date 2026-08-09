import type { InteractionResponseValue } from '../shared/intents.js'
import type { InteractionOutcome, InteractionView } from '../shared/models.js'
import { isPositiveOutcome } from './interaction-presentation.js'

export function automationResponseFor(input: {
  readonly interaction: InteractionView
  readonly outcome: InteractionOutcome | undefined
  readonly inputValue: string
  readonly selectedValue?: string
}): InteractionResponseValue | undefined {
  const { interaction, outcome } = input
  if (outcome === undefined || !isPositiveOutcome(outcome)) return undefined
  const spec = interaction.answerSpec
  if (spec.kind === 'select')
    return input.selectedValue === undefined ? { outcome } : { outcome, value: input.selectedValue }
  if (spec.kind === 'text')
    return { outcome, ...(input.inputValue.length === 0 ? {} : { value: input.inputValue }) }
  if (spec.kind === 'number') {
    const number = Number(input.inputValue)
    return Number.isFinite(number) && input.inputValue.trim().length > 0
      ? { outcome, value: number }
      : { outcome }
  }
  if (spec.kind === 'boolean') {
    if (input.inputValue === 'true' || input.inputValue === 'false')
      return { outcome, value: input.inputValue === 'true' }
    return { outcome, value: spec.defaultValue ?? true }
  }
  if (spec.kind === 'form') return { outcome }
  return undefined
}
