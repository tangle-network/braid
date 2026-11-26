import { createHash } from 'node:crypto'
import type {
  AgentProfile,
  AgentProfileFileMount,
  AgentProfileResourceRef,
} from '@tangle-network/agent-interface'
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
  /** The skill's sibling files, each mounted beside its `SKILL.md`. */
  readonly files?: readonly AgentProfileFileMount[]
  /** The skill's provenance record first, then one per sibling. */
  readonly provenance?: readonly Readonly<Record<string, unknown>>[]
}

/**
 * A file mount belongs to skill `name` when its inline resource is named
 * `name/<rel>` and it is mounted at `.../name/<rel>`: the shape Interface's
 * `mountSkillDirectory` writes for a skill's sibling files.
 */
function isSiblingOf(mount: AgentProfileFileMount, names: ReadonlySet<string>): boolean {
  const resource = mount.resource
  if (resource.kind !== 'inline') return false
  const slash = resource.name.indexOf('/')
  if (slash <= 0) return false
  return (
    names.has(resource.name.slice(0, slash)) &&
    (mount.path === resource.name || mount.path.endsWith(`/${resource.name}`))
  )
}

/** A provenance record for skill `name` itself or for one of its sibling files. */
function isRecordOf(record: Readonly<Record<string, unknown>>, names: ReadonlySet<string>) {
  return names.has(String(record.name)) || names.has(String(record.skill))
}

/** Replace skills by name in a copy of the profile: their files and provenance records go with them. */
function replaceSkills(
  profile: AgentProfile,
  names: ReadonlySet<string>,
  mounts: readonly MountedSkill[],
): AgentProfile {
  const skills = (profile.resources?.skills ?? []).filter(
    (resource) => resource.kind !== 'inline' || !names.has(resource.name),
  )
  const files = (profile.resources?.files ?? []).filter((mount) => !isSiblingOf(mount, names))
  const addedFiles = mounts.flatMap((mount) => mount.files ?? [])
  const namespace = provenanceNamespace(profile)
  const extension = profile.extensions?.[namespace]
  const existing = Array.isArray(extension?.resourceProvenance)
    ? (extension.resourceProvenance as Array<Record<string, unknown>>)
    : undefined
  const records = (existing ?? []).filter((record) => !isRecordOf(record, names))
  const added = mounts.flatMap((mount) => mount.provenance ?? [])
  const nextFiles = [...files, ...addedFiles]
  return {
    ...profile,
    resources: {
      ...profile.resources,
      skills: [...skills, ...mounts.map((mount) => mount.skill)],
      // A profile that mounted no files keeps no files key, so its digest is unchanged.
      ...(nextFiles.length === 0 && profile.resources?.files === undefined
        ? {}
        : { files: nextFiles }),
    },
    ...(existing === undefined && added.length === 0
      ? {}
      : {
          extensions: {
            ...profile.extensions,
            [namespace]: { ...extension, resourceProvenance: [...records, ...added] },
          },
        }),
  }
}

/** Add skills, their sibling files and their provenance records to a copy of the profile. */
export function withSkills(profile: AgentProfile, mounts: readonly MountedSkill[]): AgentProfile {
  return replaceSkills(profile, new Set(mounts.map((mount) => mount.skill.name)), mounts)
}

/** Remove one inline skill, its sibling files and their provenance records from a copy of the profile. */
export function withoutSkill(profile: AgentProfile, name: string): AgentProfile {
  return replaceSkills(profile, new Set([name]), [])
}

export function inlineSkills(
  profile: AgentProfile,
): Array<Extract<AgentProfileResourceRef, { kind: 'inline' }>> {
  return (profile.resources?.skills ?? []).flatMap((resource) =>
    resource.kind === 'inline' ? [resource] : [],
  )
}
