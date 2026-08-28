import { performance } from 'node:perf_hooks'
import type { HeadlessKeySource } from '../adapters/credentials/headless-key.js'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import {
  AgentRuntimeExecutionPort,
  type AgentTurnBackendResolver,
} from '../adapters/runtime/agent-runtime-execution.js'
import { LazyExecutionPort } from '../adapters/runtime/lazy-execution.js'
import { UnavailableExecutionPort } from '../adapters/runtime/unavailable-execution.js'
import {
  openSqliteStorage,
  type SqliteStartupStage,
  type SqliteStorage,
} from '../adapters/storage/sqlite.js'
import { BraidApplication } from '../app/application.js'
import type { CompositionOptions } from '../app/composition.js'
import type { ConnectionRegistry } from '../app/connections.js'
import { STARTER_PROFILE } from '../app/default-profiles.js'
import type { IntelligenceActionsOptions } from '../app/intelligence-actions.js'
import type { ProductionCompositionConfig } from '../app/production-composition.js'
import { StorageJournal } from '../app/storage-journal.js'
import { UnavailableAnalyst } from '../app/unavailable-analyst.js'
import { type Clock, SystemClock } from '../ports/clock.js'
import { type CredentialPort, credentialRef } from '../ports/credentials.js'
import type { ExecutionPort } from '../ports/execution.js'
import { RandomIds } from '../ports/ids.js'
import type { NativeInteractiveExecutionControl } from '../ports/native-interactive-execution.js'

export interface DurableCompositionOptions
  extends Omit<CompositionOptions, 'fixture' | 'journal' | 'effectStorage'> {
  readonly path: string
  /** Directory that may contain Braid's encrypted database and backups. */
  readonly storageRoot?: string
  /** Project directory materialized for agent execution. */
  readonly workspaceRoot?: string
  readonly credentialStore?: CredentialPort
  readonly databaseKeyRef?: import('../ports/credentials.js').CredentialRef
  readonly databaseKeySource?: HeadlessKeySource
  readonly backupDirectory?: string
  readonly execution?: ExecutionPort
  readonly backendResolver?: AgentTurnBackendResolver
  /** Mutable catalog shared with the product connection service. */
  readonly connectionRegistry?: ConnectionRegistry
  readonly startupObserver?: (stage: DurableStartupStage) => void
}

export interface DurableStartupStage {
  readonly name:
    | 'production-composition'
    | 'storage-open'
    | `storage.${SqliteStartupStage['name']}`
    | 'journal-restore'
    | 'application-create'
  readonly durationMs: number
}

export interface DurableBraidApplication {
  readonly app: BraidApplication
  readonly storage: SqliteStorage
  readonly nativeInteractive?: NativeInteractiveExecutionControl
}

function withProductionCredentialOptions(
  config: ProductionCompositionConfig,
  credentialStore: CredentialPort,
): ProductionCompositionConfig {
  const connectionOptions = config.connectionOptions ?? {}
  return {
    ...config,
    connectionOptions: {
      ...connectionOptions,
      credentials: connectionOptions.credentials ?? credentialStore,
      credentialRefResolver:
        connectionOptions.credentialRefResolver ?? ((ref) => credentialRef(`cred:v1:${ref}`)),
    },
  }
}

/** Open durable local state without loading provider adapters until a connection needs them. */
export async function createDurableBraidApplication(
  options: DurableCompositionOptions,
): Promise<DurableBraidApplication> {
  const clock: Clock = options.clock ?? new SystemClock()
  const credentialStore = options.credentialStore ?? createOperatingSystemCredentialStore()
  const productionConfig =
    options.production === undefined
      ? undefined
      : withProductionCredentialOptions(
          {
            ...options.production,
            ...(options.workspaceRoot === undefined
              ? {}
              : { workspaceRoot: options.workspaceRoot }),
          },
          credentialStore,
        )
  const selectedConnection = productionConfig?.connections.find(
    (connection) => connection.id === productionConfig.connectionId,
  )
  const deferProductionComposition = selectedConnection?.kind === 'cli-bridge'
  let stageStarted = performance.now()
  const production =
    productionConfig === undefined || deferProductionComposition
      ? undefined
      : (await import('../app/production-composition.js')).createProductionComposition(
          productionConfig,
          options.connectionRegistry,
        )
  reportStartupStage(options.startupObserver, 'production-composition', stageStarted)
  stageStarted = performance.now()
  const storage = await openSqliteStorage({
    path: options.path,
    credentialStore,
    ...(options.storageRoot === undefined && options.workspaceRoot === undefined
      ? {}
      : { workspaceRoot: options.storageRoot ?? options.workspaceRoot }),
    ...(options.databaseKeyRef === undefined ? {} : { databaseKeyRef: options.databaseKeyRef }),
    ...(options.databaseKeySource === undefined
      ? {}
      : { databaseKeySource: options.databaseKeySource }),
    ...(options.backupDirectory === undefined ? {} : { backupDirectory: options.backupDirectory }),
    startupObserver: (stage) =>
      reportObservedStartupStage(
        options.startupObserver,
        `storage.${stage.name}`,
        stage.durationMs,
      ),
  })
  reportStartupStage(options.startupObserver, 'storage-open', stageStarted)
  try {
    stageStarted = performance.now()
    const scopedJournal = await StorageJournal.fromStorage(storage, clock)
    reportStartupStage(options.startupObserver, 'journal-restore', stageStarted)
    stageStarted = performance.now()
    const configuredIntelligence: IntelligenceActionsOptions = options.intelligence ?? {
      analyst: new UnavailableAnalyst(),
    }
    const intelligence =
      production?.supervisorController === undefined
        ? configuredIntelligence
        : {
            ...configuredIntelligence,
            supervisorController:
              configuredIntelligence.supervisorController ?? production.supervisorController,
          }
    const app = new BraidApplication({
      profile: options.profile ?? productionConfig?.profile ?? STARTER_PROFILE,
      execution:
        options.execution ??
        production?.execution ??
        (productionConfig === undefined
          ? options.backendResolver
            ? new AgentRuntimeExecutionPort(options.backendResolver)
            : new UnavailableExecutionPort()
          : new LazyExecutionPort({
              load: async () => {
                const loaded = await import('../app/production-composition.js')
                return loaded.createProductionComposition(
                  productionConfig,
                  options.connectionRegistry,
                ).execution
              },
            })),
      clock,
      ids: options.ids ?? new RandomIds(),
      journal: scopedJournal,
      effectStorage: storage,
      conversationStorage: storage,
      intelligence,
      ...(options.effectCoordinator === undefined
        ? {}
        : { effectCoordinator: options.effectCoordinator }),
      ...(options.cancelTimeoutMs === undefined
        ? {}
        : { cancelTimeoutMs: options.cancelTimeoutMs }),
      ...(options.interactionResponseTimeoutMs === undefined
        ? {}
        : { interactionResponseTimeoutMs: options.interactionResponseTimeoutMs }),
    })
    reportStartupStage(options.startupObserver, 'application-create', stageStarted)
    return {
      app,
      storage,
      ...(production?.nativeInteractive === undefined
        ? {}
        : { nativeInteractive: production.nativeInteractive }),
    }
  } catch (error) {
    await storage.close().catch(() => undefined)
    throw error
  }
}

function reportObservedStartupStage(
  observer: DurableCompositionOptions['startupObserver'],
  name: DurableStartupStage['name'],
  durationMs: number,
): void {
  try {
    observer?.({ name, durationMs })
  } catch {
    // Diagnostics cannot change application startup.
  }
}

function reportStartupStage(
  observer: DurableCompositionOptions['startupObserver'],
  name: DurableStartupStage['name'],
  startedAt: number,
): void {
  try {
    observer?.({ name, durationMs: performance.now() - startedAt })
  } catch {
    // Diagnostics cannot change application startup.
  }
}
