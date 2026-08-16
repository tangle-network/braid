import { dirname, resolve } from 'node:path'
import { ProductionAnalysisAnalyst } from '../adapters/analysis/production-analysis-analyst.js'
import {
  createTraceAnalysisAdapter,
  createTraceAnalysisAnalyst,
} from '../adapters/analysis/trace-analysis-adapter.js'
import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import type { HeadlessKeySource } from '../adapters/credentials/headless-key.js'
import type { BraidApplication } from '../app/application.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import { ConnectionActionService } from '../app/connection-actions.js'
import { ConnectionRegistry } from '../app/connections.js'
import {
  createProductionComposition,
  type ProductionCompositionConfig,
} from '../app/production-composition.js'
import { profileModelSettings } from '../app/profile-model-settings.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { CredentialPort } from '../ports/credentials.js'
import { createDurableBraidApplication } from '../startup/durable-runtime.js'
import {
  createProductionCredentialContext,
  type ProductionCredentialContext,
} from './production-credential-context.js'
import { productionConfigPath, resolveProductionDatabaseKeyFile } from './production-key-path.js'
import { productionConnectionsForSelection } from './production-setup-persistence.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

export interface ProductionApplicationOpenOptions {
  readonly workspace: string
  readonly statePath: string
  readonly startupOptions: ProductionStartupLoadOptions
  readonly production: ProductionCompositionConfig
}

export function productionConfigForSelection(
  selection: ConfigurationSelection,
  options: ProductionStartupLoadOptions,
  connections: readonly import('../domain/entities.js').ConnectionRecord[] = [],
): ProductionCompositionConfig {
  const connectionOptions: ProductionConnectionOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.credentialStore === undefined ? {} : { credentials: options.credentialStore }),
    ...(options.credentialRefResolver === undefined
      ? {}
      : { credentialRefResolver: options.credentialRefResolver }),
    ...(options.bridgeModelCredential === undefined
      ? {}
      : { bridgeModelCredential: options.bridgeModelCredential }),
  }
  return {
    profile: selection.profile.profile,
    connections: productionConnectionsForSelection(selection, connections),
    connectionId: selection.connection.id,
    workspaceRoot: resolve(options.workspace),
    ...(options.databaseKeyFile === undefined ? {} : { databaseKeyFile: options.databaseKeyFile }),
    ...(Object.keys(connectionOptions).length === 0 ? {} : { connectionOptions }),
  }
}

export async function activateProductionConnection(
  app: BraidApplication,
  connectionId: string,
  connections: readonly import('../domain/entities.js').ConnectionRecord[],
): Promise<void> {
  const digest = canonicalDigest({
    connectionId,
    connections: connections.map((connection) => ({
      id: connection.id,
      updatedAt: connection.updatedAt,
    })),
  }).replace(/^sha256:/u, '')
  const service = new ConnectionActionService({
    host: {
      state: () => app.state(),
      configuration: app.configuration,
      runtime: app.runtimeSelection,
    },
    connections,
  })
  await service.select({
    operationId: `operation-startup-connection-${digest.slice(0, 32)}`,
    connectionId,
  })
}

function databaseKeySource(
  options: ProductionApplicationOpenOptions,
  context: ProductionCredentialContext | undefined,
): HeadlessKeySource | undefined {
  if (context !== undefined) return context.databaseKeySource
  const keyFile = options.startupOptions.databaseKeyFile ?? options.production.databaseKeyFile
  if (keyFile === undefined) return undefined
  const configPath = productionConfigPath(options.workspace, options.startupOptions.configPath)
  return {
    type: 'file',
    path: resolveProductionDatabaseKeyFile(keyFile, configPath, options.workspace),
    workspaceRoot: resolve(options.workspace),
  }
}

async function productionIntelligence(production: ProductionCompositionConfig): Promise<{
  readonly analyst: ProductionAnalysisAnalyst
}> {
  const selected = createProductionComposition(production)
  const modelSettings = profileModelSettings(selected.profile)
  const analysis = await createTraceAnalysisAdapter({
    profile: selected.profile,
    connection: selected.connection,
    ...(modelSettings.maxVisibleOutputTokens === undefined
      ? {}
      : { maxOutputTokens: modelSettings.maxVisibleOutputTokens }),
    ...(modelSettings.maxReasoningTokens === undefined
      ? {}
      : { maxReasoningTokens: modelSettings.maxReasoningTokens }),
    ...(modelSettings.maxTotalOutputTokens === undefined
      ? {}
      : { maxTotalOutputTokens: modelSettings.maxTotalOutputTokens }),
    ...(production.connectionOptions ?? {}),
  })
  return {
    analyst: new ProductionAnalysisAnalyst({
      bootstrap: createTraceAnalysisAnalyst(analysis),
      ...(production.connectionOptions === undefined
        ? {}
        : { connectionOptions: production.connectionOptions }),
    }),
  }
}

function withHeadlessCredentials(
  options: ProductionApplicationOpenOptions,
  context: ProductionCredentialContext | undefined,
): {
  readonly production: ProductionCompositionConfig
  readonly credentialStore: CredentialPort | undefined
} {
  const configuredCredentials =
    options.production.connectionOptions?.credentials ??
    options.startupOptions.credentialStore ??
    context?.store
  return {
    production: {
      ...options.production,
      connectionOptions: {
        ...(options.production.connectionOptions ?? {}),
        ...(configuredCredentials === undefined ? {} : { credentials: configuredCredentials }),
      },
    },
    credentialStore: configuredCredentials,
  }
}

/** Opens, initializes, and flushes a durable app before setup publishes its config. */
export async function openProductionApplication(
  options: ProductionApplicationOpenOptions,
): Promise<{
  readonly app: BraidApplication
  readonly connections: ConnectionRegistry
  readonly close: () => Promise<void>
}> {
  const keyFile = options.startupOptions.databaseKeyFile ?? options.production.databaseKeyFile
  const context =
    options.startupOptions.credentialContext ??
    (options.startupOptions.credentialStore === undefined && keyFile !== undefined
      ? createProductionCredentialContext({
          workspace: options.workspace,
          databaseKeyFile: keyFile,
          ...(options.startupOptions.configPath === undefined
            ? {}
            : { configPath: options.startupOptions.configPath }),
        })
      : undefined)
  const source = databaseKeySource(options, context)
  const releaseContext = context?.acquire()
  const prepared = withHeadlessCredentials(options, context)
  const connections = new ConnectionRegistry(prepared.production.connections)
  try {
    const intelligence = await productionIntelligence(prepared.production)
    const { app, storage } = await createDurableBraidApplication({
      path: options.statePath,
      storageRoot: dirname(resolve(options.statePath)),
      workspaceRoot: resolve(options.workspace),
      production: { ...prepared.production, workspaceRoot: resolve(options.workspace) },
      ...(prepared.credentialStore === undefined
        ? {}
        : { credentialStore: prepared.credentialStore }),
      ...(source === undefined ? {} : { databaseKeySource: source }),
      intelligence,
      connectionRegistry: connections,
    })
    try {
      app.initialize(options.workspace)
      await app.whenDurable()
    } catch (error) {
      await app.close().catch(() => undefined)
      await storage.close().catch(() => undefined)
      throw error
    }
    return {
      app,
      connections,
      close: async () => {
        try {
          await app.close()
        } catch (error: unknown) {
          await storage.close().catch(() => undefined)
          throw error
        } finally {
          releaseContext?.()
        }
      },
    }
  } catch (error) {
    releaseContext?.()
    throw error
  }
}
