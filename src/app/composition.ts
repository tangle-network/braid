import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import { AgentRuntimeExecutionPort } from '../adapters/runtime/agent-runtime-execution.js'
import { UnavailableExecutionPort } from '../adapters/runtime/unavailable-execution.js'
import { FixedClock, SystemClock } from '../ports/clock.js'
import { type CredentialPort, credentialRef } from '../ports/credentials.js'
import type { EffectStoragePort, JournalPort } from '../ports/effect-storage.js'
import { RandomIds, SequenceIds } from '../ports/ids.js'
import { deterministicBackend } from '../testing/deterministic-backend.js'
import { BraidApplication } from './application.js'
import type { CompositionOptions } from './composition-options.js'
import { DETERMINISTIC_PROFILE, STARTER_PROFILE } from './default-profiles.js'
import { FailClosedJournal } from './fail-closed-journal.js'
import type { IntelligenceActionsOptions } from './intelligence-actions.js'
import { createMemoryJournal } from './journal.js'
import {
  createProductionComposition,
  type ProductionCompositionConfig,
  ProductionCompositionError,
} from './production-composition.js'
import { UnavailableAnalyst } from './unavailable-analyst.js'

export {
  createDurableBraidApplication,
  type DurableBraidApplication,
  type DurableCompositionOptions,
  type DurableStartupStage,
} from '../startup/durable-runtime.js'
export { DETERMINISTIC_PROFILE, STARTER_PROFILE } from './default-profiles.js'
export type { CompositionOptions } from './composition-options.js'

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
          { admissionMode: 'async' },
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
  const configuredIntelligence: IntelligenceActionsOptions | undefined =
    options.intelligence ?? (isFixture ? undefined : { analyst: new UnavailableAnalyst() })
  const intelligence =
    production?.supervisorController === undefined
      ? configuredIntelligence
      : {
          ...(configuredIntelligence ?? {}),
          supervisorController:
            configuredIntelligence?.supervisorController ?? production.supervisorController,
        }
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
