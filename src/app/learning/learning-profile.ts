import { createHash } from 'node:crypto'
import type { AgentProfile, AgentProfileResourceRef } from '@tangle-network/agent-interface'
import { canonicalAgentProfileDigestHex } from '../../adapters/agent-interface/profile-runtime.js'

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function profileDigest(profile: AgentProfile): string {
  return `sha256:${canonicalAgentProfileDigestHex(profile)}`
}

function inlineText(resources: readonly AgentProfileResourceRef[] | undefined): string[] {
  return (resources ?? []).flatMap((resource) =>
    resource.kind === 'inline' ? [resource.content] : [],
  )
}

/**
 * Every text a harness may load from the profile into the model's context:
 * system prompt additions, instructions, inline skills, tools, agents,
 * commands and subagent prompts. A skill counts in full, so this is an upper
 * bound for harnesses that load a skill's body only when it is invoked.
 */
export function loadedText(profile: AgentProfile): string {
  const parts = [
    profile.prompt?.systemPrompt ?? '',
    profile.prompt?.appendSystemPrompt ?? '',
    ...(profile.prompt?.instructions ?? []),
    ...inlineText(profile.resources?.skills),
    ...inlineText(profile.resources?.tools),
    ...inlineText(profile.resources?.agents),
    ...inlineText(profile.resources?.commands),
    ...Object.values(profile.subagents ?? {}).flatMap((agent) => [
      agent.description ?? '',
      agent.prompt ?? '',
    ]),
  ]
  return parts.filter((part) => part !== '').join('\n')
}

/** Estimated loaded tokens: agent-eval's chars / 4 estimate over {@link loadedText}. */
export async function loadedTokens(profile: AgentProfile): Promise<number> {
  const { estimateTokens } = await import('@tangle-network/agent-eval')
  return estimateTokens(loadedText(profile))
}

/** Where `mountSkill` provenance lives for this profile. */
function provenanceNamespace(profile: AgentProfile): string {
  return profile.name ?? 'braid'
}

export interface MountedSkill {
  readonly skill: Extract<AgentProfileResourceRef, { kind: 'inline' }>
  readonly provenance?: Readonly<Record<string, unknown>>
}

/** Add skills, and their provenance records, to a copy of the profile. */
export function withSkills(profile: AgentProfile, mounts: readonly MountedSkill[]): AgentProfile {
  const names = new Set(mounts.map((mount) => mount.skill.name))
  const kept = (profile.resources?.skills ?? []).filter(
    (resource) => resource.kind !== 'inline' || !names.has(resource.name),
  )
  const namespace = provenanceNamespace(profile)
  const extension = profile.extensions?.[namespace] ?? {}
  const records = Array.isArray(extension.resourceProvenance)
    ? (extension.resourceProvenance as Array<Record<string, unknown>>).filter(
        (record) => !names.has(String(record.name)),
      )
    : []
  const added = mounts.flatMap((mount) => (mount.provenance === undefined ? [] : [mount.provenance]))
  return {
    ...profile,
    resources: { ...profile.resources, skills: [...kept, ...mounts.map((mount) => mount.skill)] },
    ...(added.length === 0 && records.length === 0
      ? {}
      : {
          extensions: {
            ...profile.extensions,
            [namespace]: { ...extension, resourceProvenance: [...records, ...added] },
          },
        }),
  }
}

/** Remove one inline skill, and its provenance record, from a copy of the profile. */
export function withoutSkill(profile: AgentProfile, name: string): AgentProfile {
  const skills = (profile.resources?.skills ?? []).filter(
    (resource) => resource.kind !== 'inline' || resource.name !== name,
  )
  const namespace = provenanceNamespace(profile)
  const extension = profile.extensions?.[namespace]
  const records = Array.isArray(extension?.resourceProvenance)
    ? (extension.resourceProvenance as Array<Record<string, unknown>>).filter(
        (record) => record.name !== name,
      )
    : undefined
  return {
    ...profile,
    resources: { ...profile.resources, skills },
    ...(extension === undefined || records === undefined
      ? {}
      : {
          extensions: {
            ...profile.extensions,
            [namespace]: { ...extension, resourceProvenance: records },
          },
        }),
  }
}

export function inlineSkills(
  profile: AgentProfile,
): Array<Extract<AgentProfileResourceRef, { kind: 'inline' }>> {
  return (profile.resources?.skills ?? []).flatMap((resource) =>
    resource.kind === 'inline' ? [resource] : [],
  )
}
