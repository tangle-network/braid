import { canonicalDigest } from '../domain/canonical.js'
import type { ConnectionRecord, OperationRecord, ProfileRecord } from '../domain/entities.js'
import type { BraidEvent } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'
import { commitEventsAndWaitAtRevision, type TransitionHost } from './application-transition.js'

export type ConfigurationOperation = OperationRecord & {
  readonly kind: 'profile-save' | 'connection-change'
}

export interface ConfigurationActionTransition {
  readonly state: () => BraidState
  readonly requestOperation: (input: {
    readonly operation: ConfigurationOperation
    readonly expectedRevision?: number
  }) => Promise<BraidState>
  readonly failOperation: (operation: ConfigurationOperation) => Promise<BraidState>
  readonly selectProfile: (input: {
    readonly profile: ProfileRecord
    readonly operation: ConfigurationOperation & { readonly kind: 'profile-save' }
    readonly expectedRevision?: number
  }) => Promise<BraidState>
  readonly saveProfile: (input: {
    readonly profile: ProfileRecord
    readonly operation: ConfigurationOperation & { readonly kind: 'profile-save' }
    readonly select: boolean
  }) => Promise<BraidState>
  readonly selectConnection: (input: {
    readonly connection: ConnectionRecord
    readonly operation: ConfigurationOperation & { readonly kind: 'connection-change' }
    readonly expectedRevision?: number
  }) => Promise<BraidState>
  readonly upsertConnection: (input: {
    readonly connection: ConnectionRecord
    readonly operation: ConfigurationOperation & { readonly kind: 'connection-change' }
    readonly expectedRevision?: number
  }) => Promise<BraidState>
  readonly removeConnection: (input: {
    readonly connection: ConnectionRecord
    readonly operation: ConfigurationOperation & { readonly kind: 'connection-change' }
    readonly expectedRevision?: number
  }) => Promise<BraidState>
  readonly updateConnectionHealth: (input: {
    readonly connection: ConnectionRecord
    readonly operation: ConfigurationOperation & { readonly kind: 'connection-change' }
  }) => Promise<BraidState>
}

export function createConfigurationActionTransition(
  host: TransitionHost,
): ConfigurationActionTransition {
  const shouldUpsertConnection = (connection: ConnectionRecord): boolean => {
    const current = host.state().connections.find((candidate) => candidate.id === connection.id)
    return current === undefined || canonicalDigest(current) !== canonicalDigest(connection)
  }
  const commit = (events: readonly BraidEvent[], expectedRevision?: number): Promise<BraidState> =>
    commitEventsAndWaitAtRevision(host, events, expectedRevision).then(() => host.state())
  const requestOperation: ConfigurationActionTransition['requestOperation'] = ({
    operation,
    expectedRevision,
  }) => commit([{ kind: 'operation.requested', operation }], expectedRevision)
  const failOperation: ConfigurationActionTransition['failOperation'] = (operation) =>
    commit([{ kind: 'operation.updated', operation }])
  const selectProfile: ConfigurationActionTransition['selectProfile'] = ({
    profile,
    operation,
    expectedRevision,
  }) => {
    const events: BraidEvent[] = []
    if (!host.state().profiles.some((candidate) => candidate.id === profile.id)) {
      events.push({ kind: 'profile.registered', profile })
    }
    events.push({ kind: 'profile.selected', profileId: profile.id })
    events.push({ kind: 'operation.updated', operation })
    return commit(events, expectedRevision)
  }
  const saveProfile: ConfigurationActionTransition['saveProfile'] = ({
    profile,
    operation,
    select,
  }) => {
    const events: BraidEvent[] = [{ kind: 'profile.registered', profile }]
    if (select) events.push({ kind: 'profile.selected', profileId: profile.id })
    events.push({ kind: 'operation.updated', operation })
    return commit(events)
  }
  const selectConnection: ConfigurationActionTransition['selectConnection'] = ({
    connection,
    operation,
    expectedRevision,
  }) => {
    const events: BraidEvent[] = []
    if (shouldUpsertConnection(connection)) {
      events.push({ kind: 'connection.upserted', connection })
    }
    events.push({ kind: 'connection.selected', connectionId: connection.id })
    events.push({ kind: 'operation.updated', operation })
    return commit(events, expectedRevision)
  }
  const upsertConnection: ConfigurationActionTransition['upsertConnection'] = ({
    connection,
    operation,
    expectedRevision,
  }) =>
    commit(
      [
        { kind: 'connection.upserted', connection },
        { kind: 'operation.updated', operation },
      ],
      expectedRevision,
    )
  const removeConnection: ConfigurationActionTransition['removeConnection'] = ({
    connection,
    operation,
    expectedRevision,
  }) => {
    const events: BraidEvent[] = []
    if (shouldUpsertConnection(connection)) {
      events.push({ kind: 'connection.upserted', connection })
    }
    events.push({ kind: 'connection.removed', connectionId: connection.id, operation })
    return commit(events, expectedRevision)
  }
  const updateConnectionHealth: ConfigurationActionTransition['updateConnectionHealth'] = ({
    connection,
    operation,
  }) =>
    commit([
      { kind: 'connection.upserted', connection },
      { kind: 'operation.updated', operation },
    ])
  return Object.freeze({
    state: () => host.state(),
    requestOperation,
    failOperation,
    selectProfile,
    saveProfile,
    selectConnection,
    upsertConnection,
    removeConnection,
    updateConnectionHealth,
  })
}
