import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import type { BraidApplication } from '../app/application.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import type {
  ConnectionRemovalInput,
  ConnectionRemovalResult,
} from '../app/connection-action-types.js'
import type { ConnectionActionService } from '../app/connection-actions.js'
import { ConnectionRemovalError } from '../app/connection-errors.js'
import { ConnectionRegistry } from '../app/connections.js'
import { connectionRemovalBlockers } from '../domain/connection-removal.js'
import type { ConnectionRecord } from '../domain/entities.js'
import type { ProductionConfigMutationLock } from './production-config-mutation-lock.js'
import {
  activeConnectionSelection,
  assertConnectionRevision,
  copyConnectionCatalog,
} from './production-connection-catalog.js'
import {
  prepareUnsharedConnectionCredentialRemoval,
  removeUnsharedConnectionCredential,
} from './production-connection-credential-cleanup.js'
import { hasDurableOperation, historicalConnectionRecord } from './production-connection-replay.js'
import type { ProductionCredentialMapping } from './production-credential-reference.js'

export interface ProductionConnectionRemovalContext {
  readonly app: BraidApplication
  readonly catalog: ConnectionRegistry
  readonly configPath: string
  readonly mutationLock: ProductionConfigMutationLock
  readonly credentialMapping: ProductionCredentialMapping
  readonly connectionOptions: ProductionConnectionOptions
  readonly service: (catalog?: () => readonly ConnectionRecord[]) => ConnectionActionService
  readonly persist: <T>(
    selection: ConfigurationSelection,
    connections: readonly ConnectionRecord[],
    action: () => Promise<T>,
  ) => Promise<T>
}

export async function removeProductionConnection(
  input: ConnectionRemovalInput,
  context: ProductionConnectionRemovalContext,
): Promise<ConnectionRemovalResult> {
  const { app, catalog } = context
  if (hasDurableOperation(app, input.operationId)) {
    const replayed = await context.service().remove(input)
    const historical = historicalConnectionRecord(app, input.connectionId)
    if (historical !== undefined) {
      await removeUnsharedConnectionCredential({
        app,
        operationId: input.operationId,
        configPath: context.configPath,
        mutationLock: context.mutationLock,
        credentialMapping: context.credentialMapping,
        record: historical,
        remaining: catalog.list(),
        connectionOptions: context.connectionOptions,
      })
    }
    return replayed
  }
  assertConnectionRevision(app, input.expectedRevision)
  const configured = catalog.get(input.connectionId)
  if (configured === undefined) {
    const historical = historicalConnectionRecord(app, input.connectionId)
    const recoveryCatalog =
      historical === undefined ? catalog : new ConnectionRegistry([...catalog.list(), historical])
    const replayed = await context.service(() => recoveryCatalog.list()).remove(input)
    if (historical !== undefined) {
      await removeUnsharedConnectionCredential({
        app,
        operationId: input.operationId,
        configPath: context.configPath,
        mutationLock: context.mutationLock,
        credentialMapping: context.credentialMapping,
        record: historical,
        remaining: catalog.list(),
        connectionOptions: context.connectionOptions,
      })
    }
    return replayed
  }
  const blockers = connectionRemovalBlockers(app.state(), configured.id)
  if (blockers.length > 0) throw new ConnectionRemovalError(configured.id, blockers)
  const proposed = copyConnectionCatalog(catalog)
  proposed.remove({ connectionId: configured.id })
  const selection = activeConnectionSelection(app, proposed)
  const credentialRemoval = await prepareUnsharedConnectionCredentialRemoval({
    operationId: input.operationId,
    configPath: context.configPath,
    mutationLock: context.mutationLock,
    credentialMapping: context.credentialMapping,
    record: configured,
    remaining: proposed.list(),
    connectionOptions: context.connectionOptions,
  })
  try {
    const result = await context.persist(selection, proposed.list(), async () => {
      const removed = await context.service().remove(input)
      catalog.remove({ connectionId: configured.id })
      return removed
    })
    await credentialRemoval.commit(app)
    return result
  } catch (error) {
    try {
      await credentialRemoval.rollback()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Connection removal failed and its credential cleanup record could not be rolled back',
      )
    }
    throw error
  }
}
