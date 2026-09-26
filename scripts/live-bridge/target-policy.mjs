import { targetDefinitions } from './constants.mjs'
import { parseProofTargetPolicy, targetPolicyEvidence } from '../proof-tools.mjs'

export const defaultTargetPolicy = Object.freeze({
  source: 'default',
  definitions: targetDefinitions,
})
export function readTargetPolicy(raw = process.env.BRAID_LIVE_BRIDGE_TARGETS) {
  return parseProofTargetPolicy(raw, targetDefinitions, defaultTargetPolicy)
}
export { targetPolicyEvidence }
