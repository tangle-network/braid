import { agentInterfaceModuleUrl } from './module-url.js'

type AgentInterfaceModule = typeof import('@tangle-network/agent-interface')

const [
  agentProfile,
  candidateCommon,
  executionPreparation,
  profileDiff,
  profileSecurity,
  profileSnapshot,
  profileSchema,
] = (await Promise.all([
  import(agentInterfaceModuleUrl('agent-profile.js')),
  import(agentInterfaceModuleUrl('agent-candidate-schema-common.js')),
  import(agentInterfaceModuleUrl('agent-execution-preparation.js')),
  import(agentInterfaceModuleUrl('profile-diff.js')),
  import(agentInterfaceModuleUrl('profile-security.js')),
  import(agentInterfaceModuleUrl('agent-profile-snapshot.js')),
  import(agentInterfaceModuleUrl('profile-schema.js')),
])) as [
  Pick<AgentInterfaceModule, 'defineAgentProfile' | 'mergeAgentProfiles'>,
  Pick<AgentInterfaceModule, 'canonicalCandidateDigest' | 'canonicalCandidateJson' | 'sha256Bytes'>,
  Pick<AgentInterfaceModule, 'canonicalAgentProfileDigest'>,
  Pick<AgentInterfaceModule, 'diffAgentProfiles'>,
  Pick<
    AgentInterfaceModule,
    'DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY' | 'validateAgentProfileSecurity'
  >,
  Pick<AgentInterfaceModule, 'snapshotAgentProfile'>,
  Pick<AgentInterfaceModule, 'agentProfileSchema'>,
]

export const { defineAgentProfile, mergeAgentProfiles } = agentProfile
export const { canonicalCandidateDigest, canonicalCandidateJson, sha256Bytes } = candidateCommon
export const { canonicalAgentProfileDigest } = executionPreparation
export const { diffAgentProfiles } = profileDiff
export const { DEFAULT_CLOUD_AGENT_PROFILE_SECURITY_POLICY, validateAgentProfileSecurity } =
  profileSecurity
export const { snapshotAgentProfile } = profileSnapshot
export const agentProfileSchema: AgentInterfaceModule['agentProfileSchema'] =
  profileSchema.agentProfileSchema

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

let environmentCapabilitiesSchema:
  | Promise<AgentInterfaceModule['AgentEnvironmentCapabilitiesSchema']>
  | undefined

export function loadAgentEnvironmentCapabilitiesSchema(): Promise<
  AgentInterfaceModule['AgentEnvironmentCapabilitiesSchema']
> {
  environmentCapabilitiesSchema ??= import(agentInterfaceModuleUrl('environment-runtime.js')).then(
    (module: Pick<AgentInterfaceModule, 'AgentEnvironmentCapabilitiesSchema'>) =>
      module.AgentEnvironmentCapabilitiesSchema,
  )
  return environmentCapabilitiesSchema
}
