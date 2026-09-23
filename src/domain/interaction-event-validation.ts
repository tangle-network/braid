import type { InteractionEvent, InteractionRecord } from './interaction-state.js'

export function assertResolvedInteractionEvent(
  record: InteractionRecord,
  event: Extract<InteractionEvent, { readonly kind: 'interaction.resolved' }>,
): void {
  const resolution = event.resolution
  if (resolution === undefined) return
  const pending = record.pendingResponse
  if (pending) {
    if (resolution.operationId !== pending.operationId) {
      throw new Error('Interaction resolution operation does not match the pending response')
    }
    if (resolution.responseDigest !== pending.responseDigest) {
      throw new Error('Interaction resolution response does not match the pending response')
    }
  } else if (
    resolution.operationId !== 'provider-reconciled' ||
    resolution.responseDigest !== undefined
  ) {
    throw new Error('Interaction resolution has no matching response intent')
  }
  const expectedOutcome =
    event.status === 'resolved'
      ? 'accepted'
      : event.status === 'declined'
        ? 'declined'
        : event.status === 'cancelled'
          ? 'cancelled'
          : undefined
  if (expectedOutcome !== undefined && resolution.outcome !== expectedOutcome) {
    throw new Error('Interaction resolution outcome does not match its status')
  }
}
