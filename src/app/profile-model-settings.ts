import type { AgentProfile } from '@tangle-network/agent-interface'

export interface ProfileModelSettings {
  readonly reasoningEffort?: string
  readonly maxOutputTokens?: number
}

/** Projects only public model controls that Braid can explain to a user. */
export function profileModelSettings(profile: Readonly<AgentProfile>): ProfileModelSettings {
  const reasoningEffort = profile.model?.reasoningEffort?.trim()
  const maxTokens = profile.model?.metadata?.maxTokens
  const maxOutputTokens =
    typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0
      ? maxTokens
      : undefined
  return {
    ...(reasoningEffort === undefined || reasoningEffort.length === 0 ? {} : { reasoningEffort }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}
