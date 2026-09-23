import type { AgentProfile } from '@tangle-network/agent-interface'
import type { ConnectionRecord } from '../connection/connections.js'
import { freezeBoundedProfileValue } from '../profile/profile-json.js'
import type { DiscoveredProfile } from '../profile/profile-sources.js'
import {
  type RunnerCapabilityCatalog,
  type RunOverrides,
  resolveEffectiveRun,
  type SelectionLayers,
  selectionDimensions,
} from '../profile/run-selection.js'

export type FirstRunStage = 'profile' | 'connection' | 'confirmation' | 'complete'

export interface EffectiveRunConfirmationViewModel {
  readonly profileName: string
  readonly profileDigest: string
  readonly connection: Pick<ConnectionRecord, 'id' | 'kind' | 'name' | 'endpoint' | 'account'>
  readonly runner: string
  readonly model: string
  readonly effort: string
  readonly mode?: string
  readonly unsupported: readonly string[]
  readonly profile: Readonly<AgentProfile>
}

export interface FirstRunViewModel {
  readonly stage: FirstRunStage
  readonly profiles: readonly DiscoveredProfile[]
  readonly connections: readonly ConnectionRecord[]
  readonly selectedProfile?: DiscoveredProfile
  readonly selectedConnection?: ConnectionRecord
  readonly confirmation?: EffectiveRunConfirmationViewModel
}

export class FirstRunController {
  #stage: FirstRunStage = 'profile'
  #profiles: readonly DiscoveredProfile[] = Object.freeze([])
  #connections: readonly ConnectionRecord[] = Object.freeze([])
  #selectedProfile: DiscoveredProfile | undefined
  #selectedConnection: ConnectionRecord | undefined
  #confirmation: EffectiveRunConfirmationViewModel | undefined

  start(input: {
    readonly profiles: readonly DiscoveredProfile[]
    readonly connections: readonly ConnectionRecord[]
  }): FirstRunViewModel {
    this.#profiles = freezeBoundedProfileValue(input.profiles)
    this.#connections = freezeBoundedProfileValue(input.connections)
    this.#stage = 'profile'
    this.#selectedProfile = undefined
    this.#selectedConnection = undefined
    this.#confirmation = undefined
    return this.view()
  }

  selectProfile(reference: string): FirstRunViewModel {
    const selected = this.#profiles.find((entry) => entry.reference === reference)
    if (selected?.document === undefined) throw new Error(`Profile ${reference} is unavailable`)
    this.#selectedProfile = selected
    this.#stage = 'connection'
    return this.view()
  }

  selectConnection(id: string): FirstRunViewModel {
    const selected = this.#connections.find((connection) => connection.id === id)
    if (selected === undefined) throw new Error(`Connection ${id} is unavailable`)
    this.#selectedConnection = selected
    this.#stage = 'confirmation'
    return this.view()
  }

  confirm(
    catalog: RunnerCapabilityCatalog,
    layers: SelectionLayers = {},
    overrides?: RunOverrides,
  ): EffectiveRunConfirmationViewModel {
    const profile = this.#selectedProfile?.document
    const connection = this.#selectedConnection
    if (profile === undefined || connection === undefined)
      throw new Error('Select a profile and connection first')
    const selection = resolveEffectiveRun(
      profile.profile,
      { ...layers, ...(overrides === undefined ? {} : { nextRun: overrides }) },
      catalog,
    )
    const unsupported = selectionDimensions(selection)
      .filter((value) => value.fidelity === 'unsupported')
      .map((value) => value.reason ?? 'unsupported selection')
    this.#confirmation = Object.freeze({
      profileName: profile.profile.name ?? 'Unnamed profile',
      profileDigest: profile.profileDigest,
      connection: Object.freeze({
        id: connection.id,
        kind: connection.kind,
        name: connection.name,
        ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
        ...(connection.account === undefined ? {} : { account: connection.account }),
      }),
      runner: selection.runner.effective ?? selection.runner.requested ?? 'unresolved',
      model: selection.model.effective ?? selection.model.requested ?? 'runner-controlled',
      effort: selection.effort.effective ?? selection.effort.requested ?? 'runner-controlled',
      ...(selection.mode.effective === undefined ? {} : { mode: selection.mode.effective }),
      unsupported: Object.freeze(unsupported),
      profile: selection.profile,
    })
    return this.#confirmation
  }

  accept(): FirstRunViewModel {
    if (this.#confirmation === undefined || this.#confirmation.unsupported.length > 0) {
      throw new Error('An effective run with unsupported values cannot be accepted')
    }
    this.#stage = 'complete'
    return this.view()
  }

  cancel(): FirstRunViewModel {
    this.#stage = 'profile'
    this.#selectedProfile = undefined
    this.#selectedConnection = undefined
    this.#confirmation = undefined
    return this.view()
  }

  view(): FirstRunViewModel {
    return freezeBoundedProfileValue({
      stage: this.#stage,
      profiles: this.#profiles,
      connections: this.#connections,
      ...(this.#selectedProfile === undefined ? {} : { selectedProfile: this.#selectedProfile }),
      ...(this.#selectedConnection === undefined
        ? {}
        : { selectedConnection: this.#selectedConnection }),
      ...(this.#confirmation === undefined ? {} : { confirmation: this.#confirmation }),
    })
  }
}
