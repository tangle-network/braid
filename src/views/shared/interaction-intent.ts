import type { InteractionData, InteractionResponse } from '@tangle-network/agent-interface'
import type { InteractionViewModel } from './interaction.js'

export type InteractionKeyboardIntent =
  | { readonly kind: 'accept'; readonly data: InteractionData }
  | { readonly kind: 'decline' }
  | { readonly kind: 'cancel' }

export function responseForInteractionIntent(
  interactionId: string,
  intent: InteractionKeyboardIntent,
): InteractionResponse {
  return intent.kind === 'accept'
    ? { id: interactionId, outcome: 'accepted', data: intent.data }
    : { id: interactionId, outcome: intent.kind === 'decline' ? 'declined' : 'cancelled' }
}

function parseFieldValue(
  field: InteractionViewModel['answerSpec']['fields'][number],
  raw: string,
): string | number | boolean | string[] | undefined {
  switch (field.type) {
    case 'text':
    case 'secret':
      return raw
    case 'number': {
      const value = Number(raw)
      return Number.isFinite(value) ? value : undefined
    }
    case 'boolean':
      if (raw === 'true' || raw === 'yes' || raw === '1') return true
      if (raw === 'false' || raw === 'no' || raw === '0') return false
      return undefined
    case 'select': {
      const values = raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      if (values.length === 0 || (!field.multi && values.length > 1)) return undefined
      if (
        values.some(
          (value) => !field.options.some((option) => option.value === value) && !field.allowCustom,
        )
      ) {
        return undefined
      }
      return values
    }
    default: {
      const exhaustive: never = field
      return exhaustive
    }
  }
}

/** Translate the editor's keyboard submission into the same canonical response used by RPC. */
export function keyboardAnswerForView(
  view: InteractionViewModel,
  raw: string,
): InteractionKeyboardIntent {
  const fields = view.answerSpec.fields
  const assignments =
    fields.length === 1
      ? new Map([[fields[0]?.name ?? '', raw]])
      : new Map(
          raw.split('\n').flatMap((line) => {
            const separator = line.indexOf('=')
            if (separator <= 0) return []
            return [[line.slice(0, separator).trim(), line.slice(separator + 1)]] as const
          }),
        )
  const data: Record<string, string | number | boolean | string[]> = {}
  for (const field of fields) {
    const value = assignments.get(field.name)
    if (value === undefined || value === '') continue
    const parsed = parseFieldValue(field, value)
    if (parsed === undefined) return { kind: 'accept', data: {} }
    data[field.name] = parsed
  }
  return { kind: 'accept', data }
}
