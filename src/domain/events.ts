import type { AgentTaskStatus } from '@tangle-network/agent-runtime'
import type { JsonValue } from '../analysis/serialization.js'

export interface TurnUsage {
  readonly input: number | null
  readonly output: number | null
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
  | {
      readonly kind: 'operation.receipt'
      readonly operationId: string
      readonly targetId: string
      readonly receipt: JsonValue
    }

export interface BraidEventEnvelope {
  /** The journal-issued identity used by source freezes and graph provenance. */
  readonly eventId?: string
  readonly sequence: number
  readonly revision: number
  readonly occurredAt: string
  readonly event: BraidEvent
}
