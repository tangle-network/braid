import type { InteractionReceipt } from '../../app/application-types.js'
import type { UiDispatchResult } from '../../views/shared/intents.js'

/** Turns a durable provider acknowledgement into an honest UI result. */
export async function projectInteractionReceipt(
  receipt: InteractionReceipt,
  revision: () => number,
): Promise<UiDispatchResult> {
  const outcome = receipt.acknowledgement.outcome
  if (outcome === 'accepted' || outcome === 'already-applied') {
    return {
      kind: 'accepted',
      operationId: receipt.operationId,
      runId: receipt.runId,
      control: 'respond_interaction',
      outcome,
      revision: revision(),
      replayed: receipt.replayed,
      completion: receipt.completion.then(() => undefined),
    }
  }

  await receipt.completion
  if (outcome === 'rejected') {
    return {
      kind: 'error',
      code: 'INTERACTION_RESPONSE_REJECTED',
      message: 'The runner rejected this response; Braid did not mark it accepted',
      retryable: false,
    }
  }
  return {
    kind: 'unavailable',
    code: 'CAPABILITY_UNAVAILABLE',
    reason: 'The current runtime could not confirm this response; Braid did not mark it accepted',
  }
}
