import type { InteractionResponseValue } from '../shared/intents.js'
import type { InteractionOutcome, InteractionView } from '../shared/models.js'

export type InteractionInputResult =
  | { readonly response: InteractionResponseValue }
  | { readonly error: string }

export function interactionInputResponse(
  interaction: InteractionView,
  outcome: InteractionOutcome | undefined,
  value: string,
): InteractionInputResult {
  if (outcome === undefined) return { error: 'No allowed response is available.' }
  const spec = interaction.answerSpec
  if (spec.kind === 'number') {
    const number = Number(value)
    if (
      !Number.isFinite(number) ||
      (spec.minimum !== undefined && number < spec.minimum) ||
      (spec.maximum !== undefined && number > spec.maximum)
    )
      return { error: 'Enter a number in the allowed range.' }
    return { response: { outcome, value: number } }
  }
  if (spec.kind === 'unknown') return { response: { outcome: 'cancel' } }
  if (spec.kind === 'form') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
      return {
        response: {
          outcome,
          data: parsed as Record<string, string | number | boolean | readonly string[]>,
        },
      }
    } catch {
      return { error: 'Enter a JSON object with the requested fields' }
    }
  }
  if (spec.required && value.length === 0) return { error: 'A response is required.' }
  if (spec.kind === 'boolean' && value !== 'true' && value !== 'false')
    return { error: 'Enter true or false, or use y/n.' }
  return { response: { outcome, value: spec.kind === 'boolean' ? value === 'true' : value } }
}
