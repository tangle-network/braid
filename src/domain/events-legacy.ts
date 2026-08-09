import type { InteractionBinding, InteractionRequest } from '@tangle-network/agent-interface'
import type { AgentTaskStatus } from '@tangle-network/agent-runtime'
import type { BraidMessagePart } from './state.js'
import type { Digest } from './ids.js'
import type { AutomationRuleRecord } from './entities-runtime.js'
import type { RunAdmissionReceipt } from './receipts.js'
import type { RuntimeEventEnvelope } from './runtime-events.js'
import type { TurnUsage } from './entities.js'

export interface ProviderEventMeta {
  readonly eventId: string
  readonly providerSequence: number
  readonly cursor?: string
  readonly occurredAt?: string
  readonly receivedAt?: string
}

export type RunTerminalStatus = AgentTaskStatus | 'cancelled' | 'expired' | 'unknown'

export type BraidControlKind = 'cancel' | 'steer' | 'queue' | 'detach' | 'reconnect'

/** The W0 stream used these five events before the complete domain existed. */
export type LegacyBraidEvent =
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
      readonly receipt?: RunAdmissionReceipt
    }
  | {
      readonly kind: 'run.text.delta'
      readonly runId: string
      readonly text: string
      readonly provider?: ProviderEventMeta
    }
  | {
      readonly kind: 'run.part.updated'
      readonly runId: string
      readonly part: BraidMessagePart
      readonly delta?: string
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.reasoning.delta'
      readonly runId: string
      readonly partId: string
      readonly text: string
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.tool.call'
      readonly runId: string
      readonly partId: string
      readonly toolName: string
      readonly callId?: string
      readonly input?: unknown
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.tool.result'
      readonly runId: string
      readonly partId: string
      readonly toolName: string
      readonly callId?: string
      readonly result?: unknown
      readonly error?: string
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.artifact'
      readonly runId: string
      readonly artifactId: string
      readonly name?: string
      readonly mimeType?: string
      readonly uri?: string
      readonly metadata?: Readonly<Record<string, unknown>>
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.proposal'
      readonly runId: string
      readonly proposalId: string
      readonly title: string
      readonly status?: 'pending' | 'approved' | 'rejected'
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.warning'
      readonly runId: string
      readonly code: string
      readonly message: string
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.usage'
      readonly runId: string
      readonly usage: TurnUsage
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.cost'
      readonly runId: string
      readonly costUsd: number
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.error'
      readonly runId: string
      readonly message: string
      readonly recoverable: boolean
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.interaction'
      readonly runId: string
      readonly request: InteractionRequest
      readonly responseBinding: InteractionBinding
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.interaction.cancelled'
      readonly runId: string
      readonly interactionId: string
      readonly reason?: string
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.interaction.response.requested'
      readonly runId: string
      readonly interactionId: string
      readonly operationId: string
      readonly outcome: 'accepted' | 'declined' | 'cancelled'
      readonly dataDigest?: Digest
      readonly containsSecret: boolean
      readonly automationRule?: AutomationRuleRecord
    }
  | {
      readonly kind: 'run.interaction.responded'
      readonly runId: string
      readonly interactionId: string
      readonly operationId: string
      readonly outcome: 'accepted' | 'declined' | 'cancelled' | 'unknown'
      readonly dataDigest?: Digest
      readonly containsSecret: boolean
      readonly detail?: string
    }
  | {
      readonly kind: 'run.provider.event'
      readonly runId: string
      readonly envelope: RuntimeEventEnvelope
      readonly provider: ProviderEventMeta
    }
  | {
      readonly kind: 'run.cancel.requested'
      readonly operationId: string
      readonly runId: string
      readonly reason?: string
    }
  | {
      readonly kind: 'run.finished'
      readonly runId: string
      readonly status: RunTerminalStatus
      readonly finalText: string
      readonly usage: TurnUsage
      readonly error?: string
      readonly reason?: string
      readonly provider?: ProviderEventMeta
    }
  | {
      readonly kind: 'run.control.requested'
      readonly runId: string
      readonly operationId: string
      readonly control: BraidControlKind
      readonly digest: string
      readonly text?: string
      readonly reason?: string
    }
  | {
      readonly kind: 'run.control.acknowledged'
      readonly runId: string
      readonly operationId: string
      readonly control: BraidControlKind
      readonly outcome: 'accepted' | 'already-applied' | 'rejected' | 'unknown'
      readonly detail?: string
    }
  | {
      readonly kind: 'run.queue.added'
      readonly runId: string
      readonly operationId: string
      readonly text: string
      readonly position: number
    }
  | {
      readonly kind: 'run.queue.removed'
      readonly runId: string
      readonly operationId: string
    }
  | {
      readonly kind: 'run.detached'
      readonly runId: string
      readonly cursor?: string
      readonly detail?: string
    }
  | {
      readonly kind: 'run.reconnecting'
      readonly runId: string
      readonly after?: string
    }
  | {
      readonly kind: 'run.unknown'
      readonly runId: string
      readonly detail: string
    }
  | {
      readonly kind: 'application.shutdown.requested'
      readonly operationId: string
    }
