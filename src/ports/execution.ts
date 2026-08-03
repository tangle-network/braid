import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'

export interface ExecuteTurnInput {
  readonly operationId: string
  readonly runId: string
  readonly text: string
  readonly profile: Readonly<AgentProfile>
  readonly signal: AbortSignal
}

export interface CancelRunInput {
  readonly operationId: string
  readonly runId: string
  readonly reason: string
}

export type CancelRunResult =
  | { readonly status: 'cancelled' }
  | { readonly status: 'unknown'; readonly reason: string }

export interface ExecutionCapabilities {
  readonly cancel: boolean
}

export interface ExecutionPort {
  readonly capabilities?: ExecutionCapabilities
  streamTurn(input: ExecuteTurnInput): AsyncIterable<RuntimeStreamEvent>
  cancelRun?(input: CancelRunInput): Promise<CancelRunResult>
}
