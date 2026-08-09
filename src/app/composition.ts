import { type AgentProfile, defineAgentProfile } from '@tangle-network/agent-interface'
import type { HeadlessKeySource } from '../adapters/credentials/headless-key.js'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import {
  AgentRuntimeExecutionPort,
  type AgentTurnBackendResolver,
} from '../adapters/runtime/agent-runtime-execution.js'
import { UnavailableExecutionPort } from '../adapters/runtime/unavailable-execution.js'
import { openSqliteStorage, type SqliteStorage } from '../adapters/storage/sqlite.js'
import { type Clock, FixedClock, SystemClock } from '../ports/clock.js'
import { type CredentialPort, credentialRef } from '../ports/credentials.js'
import type { EffectStoragePort, JournalPort } from '../ports/effect-storage.js'
import type { ExecutionPort } from '../ports/execution.js'
import { type IdSource, RandomIds, SequenceIds } from '../ports/ids.js'
import { deterministicBackend } from '../testing/deterministic-backend.js'
import { BraidApplication } from './application.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import { FailClosedJournal } from './fail-closed-journal.js'
import type { IntelligenceActionsOptions } from './intelligence-actions.js'
import { createMemoryJournal } from './journal.js'
import {
  createProductionComposition,
  type ProductionCompositionConfig,
  ProductionCompositionError,
} from './production-composition.js'
import type { ConnectionRegistry } from './connections.js'
import { StorageJournal } from './storage-journal.js'
import { UnavailableAnalyst } from './unavailable-analyst.js'

export const STARTER_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
})

export const DETERMINISTIC_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
  harness: 'pi',
  model: {
    default: 'fixture/deterministic',
    reasoningEffort: 'none',
  },
})

export interface CompositionOptions {
  readonly fixture?: 'deterministic'
  readonly clock?: Clock
  readonly ids?: IdSource
  readonly profile?: Readonly<AgentProfile>
  readonly chunkDelayMs?: number
  readonly journal?: JournalPort
  readonly effectStorage?: EffectStoragePort
  readonly effectCoordinator?: SerializedEffectCoordinator
  readonly cancelTimeoutMs?: number
  readonly interactionResponseTimeoutMs?: number
  readonly execution?: ExecutionPort
  readonly backendResolver?: AgentTurnBackendResolver
  readonly production?: ProductionCompositionConfig
  readonly intelligence?: IntelligenceActionsOptions
}

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
}

export interface DurableBraidApplication {
  readonly app: BraidApplication
  readonly storage: SqliteStorage
}

export type ProductionBraidApplicationOptions = Omit<CompositionOptions, 'fixture'>

function isEffectStorage(value: JournalPort): value is JournalPort & EffectStoragePort {
  return (
    typeof (value as Partial<EffectStoragePort>).reserveEffect === 'function' &&
    typeof (value as Partial<EffectStoragePort>).current === 'function' &&
    typeof (value as Partial<EffectStoragePort>).latest === 'function' &&
    typeof (value as Partial<EffectStoragePort>).appendEffect === 'function' &&
    typeof (value as Partial<EffectStoragePort>).history === 'function'
  )
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

export function createBraidApplication(options: CompositionOptions = {}): BraidApplication {
  const isFixture = options.fixture === 'deterministic'
  if (isFixture && options.production !== undefined) {
    throw new ProductionCompositionError(
      'PRODUCTION_FIXTURE_FORBIDDEN',
      'The deterministic fixture cannot be combined with production configuration',
    )
  }
  const directCredentialStore =
    options.production?.connectionOptions?.credentials ??
    (options.production === undefined ? undefined : createOperatingSystemCredentialStore())
  const production =
    options.production === undefined
      ? undefined
      : createProductionComposition(
          withProductionCredentialOptions(
            options.production,
            directCredentialStore ?? createOperatingSystemCredentialStore(),
          ),
        )
  const execution =
    options.execution ??
    (isFixture
      ? new AgentRuntimeExecutionPort(
          (input) =>
            deterministicBackend(input, {
              ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
            }),
          async () => ({ status: 'cancelled' as const }),
          { admissionMode: 'sync' },
        )
      : (production?.execution ??
        (options.backendResolver
          ? new AgentRuntimeExecutionPort(options.backendResolver)
          : new UnavailableExecutionPort())))
  const clock = options.clock ?? (isFixture ? new FixedClock() : new SystemClock())
  const journal =
    options.journal ?? (isFixture ? createMemoryJournal(clock) : new FailClosedJournal(clock))
  const effectStorage =
    options.effectStorage ?? (isEffectStorage(journal) ? journal : new FailClosedJournal(clock))
  const intelligence =
    options.intelligence ?? (isFixture ? undefined : { analyst: new UnavailableAnalyst() })
  return new BraidApplication({
    profile:
      options.profile ??
      production?.profile ??
      (isFixture ? DETERMINISTIC_PROFILE : STARTER_PROFILE),
    execution,
    clock,
    ids: options.ids ?? (isFixture ? new SequenceIds() : new RandomIds()),
    journal,
    effectStorage,
    ...(intelligence === undefined ? {} : { intelligence }),
    ...(options.effectCoordinator === undefined
      ? {}
      : { effectCoordinator: options.effectCoordinator }),
    ...(options.cancelTimeoutMs === undefined ? {} : { cancelTimeoutMs: options.cancelTimeoutMs }),
    ...(options.interactionResponseTimeoutMs === undefined
      ? {}
      : { interactionResponseTimeoutMs: options.interactionResponseTimeoutMs }),
  })
}

/** Strict entry point used by the normal binary after production config loads. */
export function createProductionBraidApplication(
  options: ProductionBraidApplicationOptions = {},
): BraidApplication {
  if (options.production === undefined) {
    throw new ProductionCompositionError(
      'PRODUCTION_CONFIGURATION_REQUIRED',
      'Production startup requires a canonical profile and one configured connection',
    )
  }
  return createBraidApplication(options)
}

export async function createDurableBraidApplication(
  options: DurableCompositionOptions,
): Promise<DurableBraidApplication> {
  const clock = options.clock ?? new SystemClock()
  const credentialStore = options.credentialStore ?? createOperatingSystemCredentialStore()
  const production =
    options.production === undefined
      ? undefined
      : createProductionComposition(
          withProductionCredentialOptions(
            {
              ...options.production,
              ...(options.workspaceRoot === undefined
                ? {}
                : { workspaceRoot: options.workspaceRoot }),
            },
            credentialStore,
          ),
          options.connectionRegistry,
        )
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
  })
  try {
    const scopedJournal = await StorageJournal.fromStorage(storage, clock)
    const app = new BraidApplication({
      profile: options.profile ?? production?.profile ?? STARTER_PROFILE,
      execution:
        options.execution ??
        production?.execution ??
        (options.backendResolver
          ? new AgentRuntimeExecutionPort(options.backendResolver)
          : new UnavailableExecutionPort()),
      clock,
      ids: options.ids ?? new RandomIds(),
      journal: scopedJournal,
      effectStorage: storage,
      conversationStorage: storage,
      ...(options.intelligence === undefined
        ? { intelligence: { analyst: new UnavailableAnalyst() } }
        : { intelligence: options.intelligence }),
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
    return { app, storage }
  } catch (error) {
    await storage.close().catch(() => undefined)
    throw error
  }
}
