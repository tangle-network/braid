import type { BraidApplication } from '../app/application.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import { ConnectionRegistry } from '../app/connections.js'
import { AppError } from '../app/errors.js'
import { createProfileRecord } from '../app/profiles.js'
import { connectionRemovalBlockers } from '../domain/connection-removal.js'
import type { ConnectionRecord } from '../domain/entities.js'
import type { ConnectionRemovalPreview } from '../ports/connection-lifecycle.js'
import type { ProductionConfigMutationLock } from './production-config-mutation-lock.js'
import { persistProductionStartupSelection } from './production-setup-persistence.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

export function copyConnectionCatalog(catalog: ConnectionRegistry): ConnectionRegistry {
  return new ConnectionRegistry(catalog.list())
}

export function activeConnectionSelection(
  app: BraidApplication,
  catalog: ConnectionRegistry,
): ConfigurationSelection {
  const connectionId = app.runtimeSelection.connectionId() ?? app.state().selectedConnectionId
  if (connectionId === undefined || connectionId === null) {
    throw new AppError(
      'CONNECTION_REQUIRED',
      'Choose an active connection before changing the catalog',
    )
  }
  return connectionSelection(app, catalog.select({ connectionId }).record)
}

export function connectionSelection(
  app: BraidApplication,
  connection: ConnectionRecord,
): ConfigurationSelection {
  const profile = createProfileRecord(
    {
      kind: 'inline',
      reference: 'braid:active',
      label: app.runtimeSelection.profile().name ?? 'Active profile',
      writable: false,
      trusted: true,
    },
    structuredClone(app.runtimeSelection.profile()),
  )
  return {
    profile,
    connection,
    profileDigest: profile.digest,
    connectionDigest: new ConnectionRegistry([connection]).select({ connectionId: connection.id })
      .digest,
  }
}

export function connectionRemovalPreview(
  app: BraidApplication,
  catalog: ConnectionRegistry,
  connectionId: string,
): ConnectionRemovalPreview {
  const record = catalog.select({ connectionId }).record
  const sharedCredentialConnectionIds =
    record.credentialRef === undefined
      ? []
      : catalog
          .list()
          .filter(
            (candidate) =>
              candidate.id !== record.id && candidate.credentialRef === record.credentialRef,
          )
          .map((candidate) => candidate.id)
  return {
    connectionId: record.id,
    name: record.name,
    blockers: connectionRemovalBlockers(app.state(), record.id),
    credential:
      record.credentialRef === undefined
        ? 'none'
        : sharedCredentialConnectionIds.length > 0
          ? 'shared'
          : 'unique',
    sharedCredentialConnectionIds: Object.freeze(sharedCredentialConnectionIds),
  }
}

export function assertConnectionRevision(
  app: BraidApplication,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new AppError(
      'INVALID_EXPECTED_REVISION',
      'expectedRevision must be a non-negative integer',
    )
  }
  if (app.state().revision !== expectedRevision) {
    throw new AppError(
      'STALE_REVISION',
      `The application changed at revision ${app.state().revision}; expected ${expectedRevision}`,
    )
  }
}

export async function withPersistedConnectionCatalog<T>(input: {
  readonly configPath: string
  readonly mutationLock: ProductionConfigMutationLock
  readonly startupOptions: ProductionStartupLoadOptions
  readonly selection: ConfigurationSelection
  readonly connections: readonly ConnectionRecord[]
  readonly action: () => Promise<T>
}): Promise<T> {
  const persistence = await persistProductionStartupSelection(input.configPath, input.selection, {
    ...(input.startupOptions.databaseKeyFile === undefined
      ? {}
      : { databaseKeyFile: input.startupOptions.databaseKeyFile }),
    connections: input.connections,
    mutationLock: input.mutationLock,
  })
  try {
    return await input.action()
  } catch (error) {
    try {
      await persistence.rollback()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'The connection action failed and its saved catalog could not be rolled back',
      )
    }
    throw error
  }
}
