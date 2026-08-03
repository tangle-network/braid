import { streamAgentTurn, type AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import type {
  CancelRunInput,
  CancelRunResult,
  ExecuteTurnInput,
  ExecutionPort,
} from '../../ports/execution.js'

export type AgentTurnBackendResolver = (
  input: ExecuteTurnInput,
) => AgentTurnBackend | Promise<AgentTurnBackend>

export type AgentTurnCancelResolver = (
  input: CancelRunInput,
) => CancelRunResult | Promise<CancelRunResult>

export class AgentRuntimeExecutionPort implements ExecutionPort {
  readonly #resolveBackend: AgentTurnBackendResolver
  readonly #cancel: AgentTurnCancelResolver | undefined

  constructor(resolveBackend: AgentTurnBackendResolver, cancel?: AgentTurnCancelResolver) {
    this.#resolveBackend = resolveBackend
    this.#cancel = cancel
  }

  get capabilities(): { readonly cancel: boolean } {
    return { cancel: this.#cancel !== undefined }
  }

  async *streamTurn(input: ExecuteTurnInput) {
    const backend = await this.#resolveBackend(input)
    yield* streamAgentTurn(backend, input.text, {
      signal: input.signal,
      timeoutMs: 30_000,
      preserveToolParts: true,
    })
  }

  async cancelRun(input: CancelRunInput): Promise<CancelRunResult> {
    if (!this.#cancel) {
      return {
        status: 'unknown',
        reason:
          'Cancellation outcome could not be confirmed because the runtime adapter does not expose provider cancellation',
      }
    }
    return this.#cancel(input)
  }
}
