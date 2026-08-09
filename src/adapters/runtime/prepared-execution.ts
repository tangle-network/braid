import type {
  AgentEnvironmentCapabilities,
  CreateAgentEnvironmentInput,
} from '@tangle-network/agent-interface/environment-provider'
import type { AgentTurnBackend, SandboxClient } from '@tangle-network/agent-runtime/kernel'
import type { PromptOptions } from '@tangle-network/sandbox'

export interface SandboxLifecyclePolicy {
  readonly mode: 'ephemeral' | 'retained'
  readonly cleanup: 'delete-after-turn' | 'explicit'
  readonly continuity: 'session' | 'unavailable'
  readonly reason?: string
}

/**
 * An admission-time provider binding with no live remote environment.
 * `client.create()` is deliberately deferred until after `run.requested` is
 * durable, so a journal failure cannot orphan a billable sandbox.
 */
export interface PreparedSandboxExecution {
  readonly kind: 'sandbox-plan'
  readonly client: SandboxClient
  readonly createInput: Readonly<CreateAgentEnvironmentInput>
  readonly prompt: string
  readonly turnOptions: Readonly<Omit<PromptOptions, 'signal'>>
  readonly agentRunName: string
  readonly capabilities: AgentEnvironmentCapabilities
  readonly environmentId: string
  readonly lifecycle: SandboxLifecyclePolicy
  readonly providerSessionId?: string
  readonly materializationReceipt: Readonly<Record<string, unknown>>
}

export type PreparedExecution = AgentTurnBackend | PreparedSandboxExecution

export function isPreparedSandboxExecution(
  value: PreparedExecution,
): value is PreparedSandboxExecution {
  return value.kind === 'sandbox-plan'
}
