import type { AgentProfile } from '@tangle-network/agent-interface'
import { defineAgentProfile } from '../adapters/agent-interface/profile-runtime.js'

export const STARTER_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
})

export const DETERMINISTIC_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
  harness: 'pi',
  model: {
    default: 'fixture/deterministic',
    provider: 'fixture',
    reasoningEffort: 'none',
  },
})
