import type { AgentProfile } from '@tangle-network/agent-interface'

export interface ProfileModelSettings {
  readonly reasoningEffort?: string
  readonly maxVisibleOutputTokens?: number
  readonly maxReasoningTokens?: number
  readonly maxTotalOutputTokens?: number
}

/** Projects only public model controls that Braid can explain to a user. */
export function profileModelSettings(profile: Readonly<AgentProfile>): ProfileModelSettings {
  const reasoningEffort = profile.model?.reasoningEffort?.trim()
  const maxVisibleOutputTokens = positiveLimit(profile.model?.maxVisibleOutputTokens)
  const maxReasoningTokens = positiveLimit(profile.model?.maxReasoningTokens)
  const maxTotalOutputTokens = positiveLimit(profile.model?.maxTotalOutputTokens)
  return {
    ...(reasoningEffort === undefined || reasoningEffort.length === 0 ? {} : { reasoningEffort }),
    ...(maxVisibleOutputTokens === undefined ? {} : { maxVisibleOutputTokens }),
    ...(maxReasoningTokens === undefined ? {} : { maxReasoningTokens }),
    ...(maxTotalOutputTokens === undefined ? {} : { maxTotalOutputTokens }),
  }
}

function positiveLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}
