import type { AgentTaskStatus } from '@tangle-network/agent-runtime'
import type { InteractionEvent } from './interaction-state.js'

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
      readonly requestDigest?: string
      readonly profileDigest?: string
      readonly workspaceId?: string
      readonly conversationId?: string
      readonly branchId?: string
      readonly model?: string
    }
  | {
      readonly kind: 'run.session.bound'
      readonly runId: string
      readonly providerSessionId: string
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
  | InteractionEvent

export interface BraidEventEnvelope {
  readonly eventId?: string
  readonly sequence: number
  readonly revision: number
  readonly occurredAt: string
  readonly event: BraidEvent
}

export function eventIdentity(event: BraidEvent, eventId: string | undefined): string | undefined {
  if (eventId === undefined) return undefined
  const scope =
    'runId' in event
      ? event.runId
      : event.kind === 'interaction.requested'
        ? event.interaction.runId
        : event.kind === 'interaction.resolved'
          ? event.key
          : event.kind
  return `${Buffer.byteLength(scope, 'utf8')}:${scope}|${Buffer.byteLength(eventId, 'utf8')}:${eventId}`
}
