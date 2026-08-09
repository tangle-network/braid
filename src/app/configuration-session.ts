import type { ConnectionHealth, ConnectionKind, ConnectionRecord } from '../domain/entities.js'
import { compareCodeUnits } from '../domain/code-unit-order.js'
import type { Digest } from '../domain/ids.js'
import { ConnectionRegistry } from './connections.js'
import type { ProfileRecord } from './profile-types.js'

export type ConfigurationStep = 'profile' | 'connection' | 'confirm' | 'complete' | 'cancelled'

export type ConfigurationBackTarget = 'profile' | 'connection'

export type ConfigurationErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'CONNECTION_NOT_FOUND'
  | 'PROFILE_REQUIRED'
  | 'CONNECTION_REQUIRED'
  | 'NO_PROFILES'
  | 'NO_CONNECTIONS'
  | 'ALREADY_FINISHED'

export class ConfigurationSessionError extends Error {
  readonly code: ConfigurationErrorCode

  constructor(code: ConfigurationErrorCode, message: string) {
    super(message)
    this.name = 'ConfigurationSessionError'
    this.code = code
  }
}

export interface ProfileChoice {
  readonly id: ProfileRecord['id']
  readonly label: string
  readonly description: string
  readonly source: string
  readonly digest: Digest
  readonly profile: ProfileRecord
}

export interface ConnectionChoice {
  readonly id: ConnectionRecord['id']
  readonly label: string
  readonly description: string
  readonly kind: ConnectionKind
  readonly health: ConnectionHealth['status']
  readonly connection: ConnectionRecord
}

export interface ConfigurationSelection {
  readonly profile: ProfileRecord
  readonly connection: ConnectionRecord
  readonly profileDigest: Digest
  readonly connectionDigest: Digest
}

export interface ConfigurationEffectiveValues {
  readonly runner: string
  readonly model: string
  readonly effort: string
  readonly workdir: string
  readonly verification: string
  readonly unsupported: readonly string[]
}

export interface ConfigurationSessionState {
  readonly step: ConfigurationStep
  readonly profiles: readonly ProfileChoice[]
  readonly connections: readonly ConnectionChoice[]
  readonly selectedProfileId?: ProfileRecord['id']
  readonly selectedConnectionId?: ConnectionRecord['id']
  readonly selection?: ConfigurationSelection
  readonly error?: ConfigurationSessionError
}

export interface ConfigurationSessionOptions {
  readonly profiles: readonly ProfileRecord[]
  readonly connections: readonly ConnectionRecord[]
  readonly initialProfileId?: ProfileRecord['id']
  readonly initialConnectionId?: ConnectionRecord['id']
}

function kindLabel(kind: ConnectionKind): string {
  switch (kind) {
    case 'cli-bridge':
      return 'CLI'
    case 'tangle-inference':
      return 'Inference'
    case 'tangle-sandbox':
      return 'Sandbox'
  }
}

function profileChoice(record: ProfileRecord): ProfileChoice {
  const profile = record.profile
  const runner = profile.harness ?? 'runner selected by connection'
  const model = profile.model?.default ?? 'model selected by connection'
  const effort = profile.model?.reasoningEffort
  const details = [runner, model, effort].filter((value): value is string => value !== undefined)
  return Object.freeze({
    id: record.id,
    label: record.displayName,
    description: `${record.source.label} · ${details.join(' · ')}`,
    source: record.source.label,
    digest: record.digest,
    profile: record,
  })
}

function connectionChoice(record: ConnectionRecord): ConnectionChoice {
  const credential = record.credentialRef === undefined ? 'unconfigured' : 'ready'
  const details = [kindLabel(record.kind), record.lastHealth.status, credential].filter(
    (value): value is string => value !== undefined,
  )
  return Object.freeze({
    id: record.id,
    label: record.name,
    description: details.join(' · '),
    kind: record.kind,
    health: record.lastHealth.status,
    connection: record,
  })
}

function sortedProfiles(records: readonly ProfileRecord[]): readonly ProfileRecord[] {
  return [...records].sort((left, right) =>
    compareCodeUnits(
      `${left.displayName}\u0000${left.id}`,
      `${right.displayName}\u0000${right.id}`,
    ),
  )
}

function sortedConnections(records: readonly ConnectionRecord[]): readonly ConnectionRecord[] {
  const order: Readonly<Record<ConnectionKind, number>> = {
    'cli-bridge': 0,
    'tangle-inference': 1,
    'tangle-sandbox': 2,
  }
  return [...records].sort((left, right) =>
    compareCodeUnits(
      `${order[left.kind]}\u0000${left.name}\u0000${left.id}`,
      `${order[right.kind]}\u0000${right.name}\u0000${right.id}`,
    ),
  )
}

function freezeState(state: ConfigurationSessionState): ConfigurationSessionState {
  return Object.freeze({
    ...state,
    profiles: Object.freeze([...state.profiles]),
    connections: Object.freeze([...state.connections]),
  })
}

function clearError(state: ConfigurationSessionState): ConfigurationSessionState {
  const next = { ...state }
  delete next.error
  return freezeState(next)
}

function clearSelection(state: ConfigurationSessionState): ConfigurationSessionState {
  const next = { ...state }
  delete next.selection
  return freezeState(next)
}

/**
 * Coordinates first-run choices without owning durable state or credentials.
 * The consumer decides how a committed selection changes the active run.
 */
export class ConfigurationSession {
  readonly #profiles: readonly ProfileChoice[]
  readonly #connections: readonly ConnectionChoice[]
  readonly #connectionRegistry: ConnectionRegistry
  #state: ConfigurationSessionState

  constructor(options: ConfigurationSessionOptions) {
    const profiles = sortedProfiles(options.profiles).map(profileChoice)
    const connections = sortedConnections(options.connections).map(connectionChoice)
    this.#profiles = Object.freeze(profiles)
    this.#connections = Object.freeze(connections)
    this.#connectionRegistry = new ConnectionRegistry(
      connections.map((choice) => choice.connection),
    )
    this.#state = freezeState({
      step: 'profile',
      profiles: this.#profiles,
      connections: this.#connections,
      ...(options.initialProfileId === undefined
        ? {}
        : { selectedProfileId: options.initialProfileId }),
      ...(options.initialConnectionId === undefined
        ? {}
        : { selectedConnectionId: options.initialConnectionId }),
    })
  }

  get state(): ConfigurationSessionState {
    return this.#state
  }

  selectProfile(id: string): ConfigurationSessionState {
    this.#assertSelectable()
    if (this.#profiles.length === 0) {
      return this.#fail('NO_PROFILES', 'No AgentProfiles are available for this workspace')
    }
    const profile = this.#profiles.find((choice) => choice.id === id)
    if (!profile) return this.#fail('PROFILE_NOT_FOUND', 'That AgentProfile is no longer available')
    this.#state = clearError(
      clearSelection({
        ...this.#state,
        step: 'connection',
        selectedProfileId: profile.id,
      }),
    )
    return this.#state
  }

  selectConnection(id: string): ConfigurationSessionState {
    this.#assertSelectable()
    if (this.#connections.length === 0) {
      return this.#fail('NO_CONNECTIONS', 'No connections are configured for this workspace')
    }
    const connection = this.#connections.find((choice) => choice.id === id)
    if (!connection)
      return this.#fail('CONNECTION_NOT_FOUND', 'That connection is no longer available')
    this.#connectionRegistry.select({ connectionId: connection.id })
    this.#state = clearError(
      clearSelection({
        ...this.#state,
        step: 'confirm',
        selectedConnectionId: connection.id,
      }),
    )
    return this.#state
  }

  back(): ConfigurationSessionState {
    const target =
      this.#state.step === 'confirm' || this.#state.step === 'complete' ? 'connection' : 'profile'
    return this.backTo(target)
  }

  backTo(target: ConfigurationBackTarget): ConfigurationSessionState {
    this.#assertOpen()
    if (target === 'connection' && this.#state.selectedProfileId === undefined) {
      return this.#fail('PROFILE_REQUIRED', 'Choose an AgentProfile before continuing')
    }
    this.#state = clearError(clearSelection({ ...this.#state, step: target }))
    return this.#state
  }

  confirm(): ConfigurationSelection {
    if (this.#state.step === 'complete' && this.#state.selection !== undefined) {
      return this.#state.selection
    }
    const selected = this.previewSelection()
    this.#state = freezeState({
      ...this.#state,
      step: 'complete',
      selection: selected,
    })
    this.#state = clearError(this.#state)
    return selected
  }

  previewSelection(): ConfigurationSelection {
    this.#assertOpen()
    const profileId = this.#state.selectedProfileId
    if (profileId === undefined) {
      this.#fail('PROFILE_REQUIRED', 'Choose an AgentProfile before continuing')
      throw this.#state.error
    }
    const connectionId = this.#state.selectedConnectionId
    if (connectionId === undefined) {
      this.#fail('CONNECTION_REQUIRED', 'Choose a connection before continuing')
      throw this.#state.error
    }
    const profile = this.#profiles.find((choice) => choice.id === profileId)
    const connection = this.#connections.find((choice) => choice.id === connectionId)
    if (!profile) {
      this.#fail('PROFILE_NOT_FOUND', 'The selected AgentProfile is no longer available')
      throw this.#state.error
    }
    if (!connection) {
      this.#fail('CONNECTION_NOT_FOUND', 'The selected connection is no longer available')
      throw this.#state.error
    }
    const selected: ConfigurationSelection = Object.freeze({
      profile: profile.profile,
      connection: connection.connection,
      profileDigest: profile.digest,
      connectionDigest: this.#connectionRegistry.select({ connectionId }).digest,
    })
    return selected
  }

  cancel(): ConfigurationSessionState {
    if (this.#state.step === 'cancelled') {
      throw new ConfigurationSessionError(
        'ALREADY_FINISHED',
        'This configuration session is closed',
      )
    }
    this.#state = clearError(freezeState({ ...this.#state, step: 'cancelled' }))
    return this.#state
  }

  #fail(code: ConfigurationErrorCode, message: string): ConfigurationSessionState {
    const error = new ConfigurationSessionError(code, message)
    this.#state = freezeState({ ...this.#state, error })
    return this.#state
  }

  #assertOpen(): void {
    if (this.#state.step === 'cancelled') {
      throw new ConfigurationSessionError(
        'ALREADY_FINISHED',
        'This configuration session is closed',
      )
    }
  }

  #assertSelectable(): void {
    if (this.#state.step === 'complete' || this.#state.step === 'cancelled') {
      throw new ConfigurationSessionError(
        'ALREADY_FINISHED',
        'This configuration session is closed',
      )
    }
  }
}
