import type { InteractionResponse } from '@tangle-network/agent-interface'

export function ephemeralResponse(response: InteractionResponse): InteractionResponse {
  return {
    id: response.id,
    outcome: response.outcome,
    ...(response.data === undefined ? {} : { data: structuredClone(response.data) }),
  }
}

export function eraseEphemeralResponse(response: InteractionResponse): void {
  if (response.data === undefined || typeof response.data !== 'object') return
  for (const key of Object.keys(response.data)) {
    delete (response.data as Record<string, unknown>)[key]
  }
}
