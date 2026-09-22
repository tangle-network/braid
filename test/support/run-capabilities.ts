import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface'
import { defaultTangleSandboxCapabilities } from '@tangle-network/agent-provider-tangle'
import { DEFAULT_RUN_CAPABILITIES, type RunCapabilities } from '../../src/ports/execution.js'

export function interactionResponseEnvironmentCapabilities(): AgentEnvironmentCapabilities {
  return defaultTangleSandboxCapabilities('opencode')
}

/** A real shared capability document for fake interaction-response adapters. */
export function interactionResponseRunCapabilities(): RunCapabilities {
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    environment: interactionResponseEnvironmentCapabilities(),
  }
}
