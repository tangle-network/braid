import type { AgentProfile } from '@tangle-network/agent-interface'
import { snapshotAgentProfile } from '../adapters/agent-interface/profile-runtime.js'
import type { BraidState } from '../domain/state.js'

export class RuntimeSelection {
  #profile: Readonly<AgentProfile>
  #connectionId: string | undefined

  constructor(profile: Readonly<AgentProfile>, connectionId?: string) {
    this.#profile = snapshotAgentProfile(profile)
    this.#connectionId = connectionId
  }

  profile(): Readonly<AgentProfile> {
    return this.#profile
  }

  connectionId(): string | undefined {
    return this.#connectionId
  }

  setProfile(profile: Readonly<AgentProfile>): void {
    this.#profile = snapshotAgentProfile(profile)
  }

  setConnection(connectionId: string): void {
    this.#connectionId = connectionId
  }

  syncFromState(state: BraidState): void {
    if (state.selectedProfileId !== null) {
      const selected = state.profiles.find((candidate) => candidate.id === state.selectedProfileId)
      if (selected !== undefined) this.setProfile(selected.profile)
    }
    this.#connectionId = state.selectedConnectionId ?? undefined
  }
}
