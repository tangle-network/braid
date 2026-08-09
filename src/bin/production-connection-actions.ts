import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { assertConnectionCredentialReference } from '../adapters/connections/production-connection-credentials.js'
import {
  connectionEndpoint,
  isLoopbackEndpoint,
} from '../adapters/connections/production-connection-endpoints.js'
import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import { createProductionConnectionAdapter } from '../adapters/connections/production-connections.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import type {
  ConnectionListResult,
  ConnectionRemovalInput,
  ConnectionRemovalResult,
  ConnectionSelectionResult,
  ConnectionTestResult,
  ConnectionUpsertInput,
  ConnectionUpsertResult,
} from '../app/connection-action-types.js'
import { ConnectionActionService, type ConnectionActions } from '../app/connection-actions.js'
import { ConnectionError } from '../app/connection-errors.js'
import { connectionRecordFromMetadata } from '../app/connection-record-factory.js'
import { ConnectionRegistry } from '../app/connections.js'
import type { ConnectionRecord, IsoDateTime } from '../domain/entities.js'
import { createCredentialRefId } from '../domain/ids.js'
import type {
  ConnectionCreationInput,
  ConnectionLifecyclePort,
  ConnectionRemovalPreview,
} from '../ports/connection-lifecycle.js'
import {
  type ProductionConnectionActionsOptions,
  resolveProductionConnectionOptions,
} from './production-connection-action-options.js'
import {
  type ProductionConfigMutationLock,
  withProductionConfigMutationLock,
} from './production-config-mutation-lock.js'
import {
  productionCredentialMapping,
  type ProductionCredentialMapping,
} from './production-credential-reference.js'
import {
  activeConnectionSelection,
  assertConnectionRevision,
  connectionRemovalPreview,
  connectionSelection,
  copyConnectionCatalog,
  withPersistedConnectionCatalog,
} from './production-connection-catalog.js'
import { removeProductionConnection } from './production-connection-removal.js'
import {
  connectionRecordForOperation,
  hasDurableOperation,
} from './production-connection-replay.js'
import { prepareProductionSelection } from './production-setup-credentials.js'

export type { ProductionConnectionActionsOptions } from './production-connection-action-options.js'

/** Coordinates the saved catalog, durable events, live resolver, and credentials. */
export class ProductionConnectionActions implements ConnectionActions, ConnectionLifecyclePort {
  readonly #options: ProductionConnectionActionsOptions
  readonly #productionConnection: ProductionConnectionOptions
  readonly #credentialMapping: ProductionCredentialMapping
  #tail: Promise<void> = Promise.resolve()

  constructor(options: ProductionConnectionActionsOptions) {
    this.#options = options
    this.#productionConnection = resolveProductionConnectionOptions(options)
    this.#credentialMapping = productionCredentialMapping(
      options.productionConnection?.credentialRefResolver ??
        options.startupOptions.credentialRefResolver,
    )
  }

  list(query = ''): Promise<ConnectionListResult> {
    return this.#service().list(query)
  }

  requiresCredential(draft: ConnectionCreationInput['draft']): boolean {
    return draft.kind !== 'cli-bridge' || !isLoopbackEndpoint(draft.endpoint)
  }

  upsert(input: ConnectionUpsertInput): Promise<ConnectionUpsertResult> {
    return this.#mutate(async (mutationLock) => {
      const app = this.#options.currentApp()
      const record = new ConnectionRegistry().upsert(input.record)
      connectionEndpoint(record, this.#productionConnection)
      if (hasDurableOperation(app, input.operationId)) return this.#service(app).upsert(input)
      const existing = this.#options.currentCatalog().get(record.id)
      if (existing !== undefined && existing.credentialRef !== record.credentialRef) {
        throw new ConnectionError(
          'CONNECTION_CREDENTIAL_CHANGE_REQUIRES_SECURE_FLOW',
          'Replace connection credentials through the masked credential flow',
          { connectionId: record.id },
        )
      }
      await assertConnectionCredentialReference(record, this.#productionConnection)
      assertConnectionRevision(app, input.expectedRevision)
      const proposed = copyConnectionCatalog(this.#options.currentCatalog())
      proposed.upsert(record)
      const selection = activeConnectionSelection(app, proposed)
      return this.#persist(mutationLock, selection, proposed.list(), async () => {
        const result = await this.#service(app).upsert({ ...input, record })
        this.#options.currentCatalog().upsert(record)
        return result
      })
    })
  }

  create(input: ConnectionCreationInput): Promise<ConnectionUpsertResult> {
    return this.#mutate(async (mutationLock) => {
      const app = this.#options.currentApp()
      const operationCredentialId = createCredentialRefId(
        `credential-${createHash('sha256')
          .update('braid-connection-credential\0')
          .update(resolve(this.#options.configPath))
          .update('\0')
          .update(input.operationId)
          .digest('hex')
          .slice(0, 32)}`,
      )
      const draft = connectionRecordFromMetadata({
        draft: input.draft,
        operationId: input.operationId,
        now: this.#now(),
      })
      connectionEndpoint(draft, this.#productionConnection)
      if (hasDurableOperation(app, input.operationId)) {
        const original = connectionRecordForOperation(app, input.operationId)
        if (original === undefined) {
          throw new Error('The saved connection operation has no matching connection record')
        }
        const replayRecord = connectionRecordFromMetadata({
          draft: input.draft,
          operationId: input.operationId,
          now: original.createdAt,
          ...(original.credentialRef === undefined
            ? {}
            : { credentialRef: original.credentialRef }),
        })
        return this.#service(app).upsert({
          operationId: input.operationId,
          record: replayRecord,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
        })
      }
      assertConnectionRevision(app, input.expectedRevision)
      const prepared = await prepareProductionSelection(
        this.#options.startupOptions,
        connectionSelection(app, draft),
        this.#options.configPath,
        input.credential,
        operationCredentialId,
      )
      const record = prepared.selection.connection
      const proposed = copyConnectionCatalog(this.#options.currentCatalog())
      proposed.upsert(record)
      const selected = activeConnectionSelection(app, proposed)
      try {
        const result = await this.#persist(mutationLock, selected, proposed.list(), async () => {
          const created = await this.#service(app).upsert({
            operationId: input.operationId,
            record,
            ...(input.expectedRevision === undefined
              ? {}
              : { expectedRevision: input.expectedRevision }),
          })
          this.#options.currentCatalog().upsert(record)
          return created
        })
        await prepared.commit()
        return result
      } catch (error) {
        await prepared.rollback().catch((rollbackError: unknown) => {
          throw new AggregateError(
            [error, rollbackError],
            'Connection creation failed and its credential could not be rolled back',
          )
        })
        throw error
      }
    })
  }

  select(input: {
    readonly operationId: string
    readonly connectionId: string
    readonly expectedRevision?: number
  }): Promise<ConnectionSelectionResult> {
    return this.#mutate(async (mutationLock) => {
      const app = this.#options.currentApp()
      if (hasDurableOperation(app, input.operationId)) return this.#service(app).select(input)
      assertConnectionRevision(app, input.expectedRevision)
      const catalog = this.#options.currentCatalog()
      const connection = catalog.select({ connectionId: input.connectionId }).record
      const selection = connectionSelection(app, connection)
      return this.#persist(mutationLock, selection, catalog.list(), () =>
        this.#service(app).select(input),
      )
    })
  }

  remove(input: ConnectionRemovalInput): Promise<ConnectionRemovalResult> {
    return this.#mutate((mutationLock) => {
      const app = this.#options.currentApp()
      return removeProductionConnection(input, {
        app,
        catalog: this.#options.currentCatalog(),
        configPath: this.#options.configPath,
        mutationLock,
        credentialMapping: this.#credentialMapping,
        connectionOptions: this.#productionConnection,
        service: (catalog) => this.#service(app, catalog),
        persist: (selection, connections, action) =>
          this.#persist(mutationLock, selection, connections, action),
      })
    })
  }

  test(input: {
    readonly operationId: string
    readonly connectionId: string
  }): Promise<ConnectionTestResult> {
    return this.#serialize(async () => {
      const app = this.#options.currentApp()
      const result = await this.#service(app).test(input)
      const updated = app.state().connections.find((record) => record.id === input.connectionId)
      if (updated !== undefined && this.#options.currentCatalog().get(updated.id) !== undefined) {
        this.#options.currentCatalog().upsert(updated)
      }
      return result
    })
  }

  previewRemoval(connectionId: string): ConnectionRemovalPreview {
    return connectionRemovalPreview(
      this.#options.currentApp(),
      this.#options.currentCatalog(),
      connectionId,
    )
  }

  #service(
    app = this.#options.currentApp(),
    catalog: () => readonly ConnectionRecord[] = () => this.#options.currentCatalog().list(),
  ): ConnectionActionService {
    return new ConnectionActionService({
      host: {
        state: () => app.state(),
        configuration: app.configuration,
        runtime: app.runtimeSelection,
      },
      catalog,
      probeFor: (record) => createProductionConnectionAdapter(record, this.#productionConnection),
      now: () => this.#now(),
    })
  }

  #persist<T>(
    mutationLock: ProductionConfigMutationLock,
    selection: ConfigurationSelection,
    connections: readonly ConnectionRecord[],
    action: () => Promise<T>,
  ): Promise<T> {
    return withPersistedConnectionCatalog({
      configPath: this.#options.configPath,
      mutationLock,
      startupOptions: this.#options.startupOptions,
      selection,
      connections,
      action,
    })
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action, action)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #mutate<T>(action: (lock: ProductionConfigMutationLock) => Promise<T>): Promise<T> {
    return this.#serialize(() => withProductionConfigMutationLock(this.#options.configPath, action))
  }

  #now(): IsoDateTime {
    return this.#options.now?.() ?? new Date().toISOString()
  }
}
