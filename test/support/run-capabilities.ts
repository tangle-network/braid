import { defaultTangleSandboxCapabilities } from '@tangle-network/agent-provider-tangle'
import { DEFAULT_RUN_CAPABILITIES, type RunCapabilities } from '../../src/ports/execution.js'

/** A real shared capability document for fake interaction-response adapters. */
export function interactionResponseRunCapabilities(): RunCapabilities {
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    environment: defaultTangleSandboxCapabilities('opencode'),
  }
}
