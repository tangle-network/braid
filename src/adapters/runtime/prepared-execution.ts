import type { AgentEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { ExecutionEnvironmentObservation } from '../../domain/execution-observation.js'

export interface SandboxLifecyclePolicy {
  readonly mode: 'ephemeral' | 'retained'
  readonly cleanup: 'delete-after-turn' | 'explicit'
  readonly continuity: 'session' | 'unavailable'
  readonly idleTtlSeconds?: number
  readonly reason?: string
}

export interface ExecutionObservationSource {
  snapshot(): Promise<ExecutionEnvironmentObservation | undefined>
}

/**
 * Runtime owns the executor and its provider cancellation operation.
 *
 * The capability is intentionally a tag rather than a provider callback.
 * Braid invokes the public Runtime `Executor.teardown` port after Runtime
 * creates the executor for the turn.
 */
export interface RuntimeCancellationCapability {
  readonly kind: 'runtime-executor-teardown'
}

/**
 * Admission facts paired with one Runtime-owned executor.
 * Creating this value must not create a remote environment or start paid work.
 */
export interface PreparedExecution {
  readonly kind: 'prepared-execution'
  readonly backend: AgentTurnBackend
  readonly capabilities?: AgentEnvironmentCapabilities
  readonly environmentId?: string
  readonly providerSessionId?: string
  readonly cancellation?: RuntimeCancellationCapability
  readonly observation?: ExecutionObservationSource
  readonly materializationReceipt: Readonly<Record<string, unknown>>
}

export type ExecutionResolution = AgentTurnBackend | PreparedExecution

export function isPreparedExecution(value: ExecutionResolution): value is PreparedExecution {
  return value.kind === 'prepared-execution'
}
