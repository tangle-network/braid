import { streamAgentTurn, type AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { ExecuteTurnInput, ExecutionPort } from '../../ports/execution.js'
import type { InteractionRuntimePort } from '../../ports/interactions.js'

export type AgentTurnBackendResolver = (
  input: ExecuteTurnInput,
) => AgentTurnBackend | Promise<AgentTurnBackend>

export class AgentRuntimeExecutionPort implements ExecutionPort {
  readonly #resolveBackend: AgentTurnBackendResolver
  readonly interactions: InteractionRuntimePort | undefined

  constructor(resolveBackend: AgentTurnBackendResolver, interactions?: InteractionRuntimePort) {
    this.#resolveBackend = resolveBackend
    this.interactions = interactions
  }

  async *streamTurn(input: ExecuteTurnInput) {
    const backend = await this.#resolveBackend(input)
    yield* streamAgentTurn(backend, input.text, {
      signal: input.signal,
      timeoutMs: 30_000,
      preserveToolParts: true,
    })
  }
}
