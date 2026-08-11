import type { AgentProfile } from '@tangle-network/agent-interface'
import { createProfileRecord } from '../app/profiles.js'

/** Gives configuration views the exact active profile without making it durable state. */
export function productionActiveProfile(profile: Readonly<AgentProfile>) {
  return createProfileRecord(
    {
      kind: 'inline',
      reference: 'braid:configured-profile',
      label: 'Configured AgentProfile',
      writable: false,
      trusted: true,
    },
    profile,
  )
}
