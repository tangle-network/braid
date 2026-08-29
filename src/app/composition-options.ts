import type { AgentProfile } from '@tangle-network/agent-interface'
import type { AgentTurnBackendResolver } from '../adapters/runtime/agent-runtime-execution.js'
import type { Clock } from '../ports/clock.js'
import type { EffectStoragePort, JournalPort } from '../ports/effect-storage.js'
import type { ExecutionPort } from '../ports/execution.js'
import type { IdSource } from '../ports/ids.js'
import type { SerializedEffectCoordinator } from './effect-coordinator.js'
import type { IntelligenceActionsOptions } from './intelligence-actions.js'
import type { ProductionCompositionConfig } from './production-composition.js'

/** Shared inputs for in-memory, production, and durable application composition. */
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
