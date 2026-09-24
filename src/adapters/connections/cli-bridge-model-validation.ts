import type { AgentProfile } from '@tangle-network/agent-interface'
import { materializeBridgeModelRoute } from './cli-bridge-model-route.js'

export const CLI_BRIDGE_MODEL_VALIDATION_MAX_TOKENS = 1
export const CLI_BRIDGE_PI_MODEL_VALIDATION_MAX_TOTAL_TOKENS = 256

/**
 * Build a minimal profile for a bounded route and credential check.
 *
 * This does not claim that every field in the selected profile was materialized.
 * Pi exposes only a total completion cap, including hidden reasoning.
 * Its route probe needs room to emit OK after that reasoning and cannot request a visible-only cap.
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
  const maxTokens =
    runner === 'pi'
      ? Math.min(
          CLI_BRIDGE_PI_MODEL_VALIDATION_MAX_TOTAL_TOKENS,
          profile.model?.maxTotalOutputTokens ?? CLI_BRIDGE_PI_MODEL_VALIDATION_MAX_TOTAL_TOKENS,
        )
      : CLI_BRIDGE_MODEL_VALIDATION_MAX_TOKENS
  return {
    model,
    messages: [{ role: 'user', content: 'Braid model validation. Reply with exactly OK.' }],
    stream: false,
    max_tokens: maxTokens,
    agent_profile: {
      name: 'Braid model validation',
      harness: runner,
      model: {
        default: authoredModel,
        ...(provider === undefined || provider.length === 0 ? {} : { provider }),
        ...(profile.model?.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: profile.model.reasoningEffort }),
        ...(runner === 'pi'
          ? {}
          : { maxVisibleOutputTokens: CLI_BRIDGE_MODEL_VALIDATION_MAX_TOKENS }),
        maxTotalOutputTokens: maxTokens,
      },
    },
  }
}
