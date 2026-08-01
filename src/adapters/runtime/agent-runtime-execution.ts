import { streamAgentTurn, type AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type { ExecuteTurnInput, ExecutionPort } from '../../ports/execution.js'

export type AgentTurnBackendResolver = (
  input: ExecuteTurnInput,
) => AgentTurnBackend | Promise<AgentTurnBackend>

export class AgentRuntimeExecutionPort implements ExecutionPort {
  readonly #resolveBackend: AgentTurnBackendResolver

  constructor(resolveBackend: AgentTurnBackendResolver) {
    this.#resolveBackend = resolveBackend
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
