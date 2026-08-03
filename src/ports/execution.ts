import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import type { InteractionRuntimePort } from './interactions.js'

export interface ExecuteTurnInput {
  readonly operationId: string
  readonly runId: string
  readonly text: string
  readonly profile: Readonly<AgentProfile>
  readonly signal: AbortSignal
}

export interface ExecutionPort {
  streamTurn(input: ExecuteTurnInput): AsyncIterable<RuntimeStreamEvent>
  readonly interactions?: InteractionRuntimePort | undefined
}
