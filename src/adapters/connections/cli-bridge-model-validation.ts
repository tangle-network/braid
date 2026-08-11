import type { AgentProfile } from '@tangle-network/agent-interface'
import { materializeBridgeModelRoute } from './cli-bridge-model-route.js'

export const CLI_BRIDGE_MODEL_VALIDATION_MAX_TOKENS = 1

/**
 * Build a minimal profile for a bounded route and credential check.
 *
 * This does not claim that every field in the selected profile was materialized.
 * It keeps the reasoning request separate from the one-token output limit.
 */
export function cliBridgeModelValidationRequest(profile: Readonly<AgentProfile>): {
  readonly model: string
  readonly messages: readonly [{ readonly role: 'user'; readonly content: string }]
  readonly stream: false
  readonly max_tokens: number
  readonly agent_profile: AgentProfile
} {
  const runner = profile.harness
  const authoredModel = profile.model?.default?.trim()
  if (runner === undefined || authoredModel === undefined || authoredModel.length === 0) {
    throw new Error('CLI Bridge model validation requires a profile runner and model.default')
  }
  const provider = profile.model?.provider?.trim()
  const model = materializeBridgeModelRoute(runner, authoredModel, provider)
  return {
    model,
    messages: [{ role: 'user', content: 'Braid model validation. Reply with exactly OK.' }],
    stream: false,
    max_tokens: CLI_BRIDGE_MODEL_VALIDATION_MAX_TOKENS,
    agent_profile: {
      name: 'Braid model validation',
      harness: runner,
      model: {
        default: authoredModel,
        ...(provider === undefined || provider.length === 0 ? {} : { provider }),
        ...(profile.model?.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: profile.model.reasoningEffort }),
        metadata: { maxTokens: CLI_BRIDGE_MODEL_VALIDATION_MAX_TOKENS },
      },
    },
  }
}
