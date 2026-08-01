import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'

export interface ExecuteTurnInput {
  readonly operationId: string
  readonly runId: string
  readonly text: string
  readonly profile: Readonly<AgentProfile>
  readonly signal: AbortSignal
}

export interface ExecutionPort {
  streamTurn(input: ExecuteTurnInput): AsyncIterable<RuntimeStreamEvent>
}
