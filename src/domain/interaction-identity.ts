import { canonicalDigest } from './canonical.js'
import { createInteractionId, type InteractionId } from './ids.js'

/** Map one provider-owned interaction identity into Braid's local namespace. */
export function localInteractionId(runId: string, providerInteractionId: string): InteractionId {
  return createInteractionId(
    `interaction-${canonicalDigest({ runId, providerInteractionId }).slice(0, 48)}`,
  )
}
