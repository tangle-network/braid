import { exitCodes, targetDefinitions } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'

export const defaultTargetPolicy = Object.freeze({
  source: 'default',
  definitions: targetDefinitions,
})

export function readTargetPolicy(raw = process.env.BRAID_LIVE_BRIDGE_TARGETS) {
  if (raw === undefined || raw.trim() === '') return defaultTargetPolicy
  const keys = raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
  const definitionsByKey = new Map(
    targetDefinitions.map((definition) => [definition.key, definition]),
  )
  const unknown = keys.filter((key) => !definitionsByKey.has(key))
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
  if (keys.length === 0 || unknown.length > 0 || duplicates.length > 0) {
    throw new LiveBridgeError(
      'TARGET_POLICY_INVALID',
      'BRAID_LIVE_BRIDGE_TARGETS must list each supported target key once',
      exitCodes.unavailable,
      { requested: keys, supported: targetDefinitions.map(({ key }) => key), unknown, duplicates },
    )
  }
  return {
    source: 'environment',
    requested: keys,
    definitions: keys.map((key) => definitionsByKey.get(key)),
  }
}

export function targetPolicyEvidence(policy) {
  return {
    source: policy.source,
    ...(policy.requested === undefined ? {} : { requested: policy.requested }),
    required: policy.definitions.map(({ key, label, modelId, backend }) => ({
      key,
      label,
      modelId,
      backend,
    })),
  }
}
