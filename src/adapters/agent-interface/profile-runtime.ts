import { canonicalAgentProfileDigest } from '@tangle-network/agent-interface'
import { snapshotAgentProfile } from '@tangle-network/agent-interface/profile-snapshot'

/**
 * Return the canonical AgentProfile identity in Braid's unprefixed digest format.
 * The profile stays private; only its exact public-schema identity crosses this boundary.
 */
export function canonicalAgentProfileDigestHex(
  profile: Parameters<typeof canonicalAgentProfileDigest>[0],
): string {
  const digest = canonicalAgentProfileDigest(snapshotAgentProfile(profile))
  const match = /^sha256:([0-9a-f]{64})$/u.exec(digest)
  if (match?.[1] === undefined)
    throw new Error('agent-interface returned an invalid AgentProfile digest')
  return match[1]
}
