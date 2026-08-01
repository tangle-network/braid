import type { AgentTaskStatus } from '@tangle-network/agent-runtime'

export interface TurnUsage {
  readonly input: number
  readonly output: number
  readonly costUsd?: number
  readonly model?: string
}

export type BraidEvent =
  | {
      readonly kind: 'workspace.opened'
      readonly workspace: string
    }
  | {
      readonly kind: 'draft.changed'
      readonly text: string
    }
  | {
      readonly kind: 'run.requested'
      readonly operationId: string
      readonly runId: string
      readonly turnId: string
      readonly userMessageId: string
      readonly assistantMessageId: string
      readonly text: string
    }
  | {
      readonly kind: 'run.text.delta'
      readonly runId: string
      readonly text: string
    }
  | {
      readonly kind: 'run.finished'
      readonly runId: string
      readonly status: AgentTaskStatus
      readonly finalText: string
      readonly usage: TurnUsage
      readonly error?: string
    }

export interface BraidEventEnvelope {
  readonly sequence: number
  readonly revision: number
  readonly occurredAt: string
  readonly event: BraidEvent
}
