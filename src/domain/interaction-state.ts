import type {
  InteractionOutcome,
  NonSecretInteractionData,
  SafeInteractionRequest,
} from './interaction.js'
import { lengthDelimitedIdentity } from './identity.js'

export interface InteractionCapabilities {
  readonly kinds: readonly string[]
  readonly answerTypes: readonly ('text' | 'number' | 'boolean' | 'select' | 'secret')[]
  readonly scopes: readonly ('once' | 'session' | 'persistent' | 'deny')[]
  readonly secretAnswers: boolean
  readonly concurrentRequests: boolean
  readonly replay: boolean
  readonly responseIdempotency: boolean
}

export type InteractionStatus =
  | 'pending'
  | 'responding'
  | 'resolved'
  | 'declined'
  | 'cancelled'
  | 'expired'
  | 'unknown'
  | 'conflict'
  | 'identity_conflict'
  | 'unsupported'
  | 'unknown_interaction'
  | 'unknown_run'
  | 'transport_error'

export function interactionStatusIsUncertain(status: InteractionStatus): boolean {
  return (
    status === 'unknown' ||
    status === 'transport_error' ||
    status === 'unknown_interaction' ||
    status === 'unknown_run'
  )
}

export interface InteractionResolution {
  readonly outcome: InteractionOutcome
  readonly operationId: string
  readonly publicData?: NonSecretInteractionData
  readonly dataDigest?: string
  readonly responseDigest?: string
  readonly containsSecret: boolean
  readonly resolvedAt: string
}

export interface PendingInteractionResponse {
  readonly operationId: string
  readonly outcome: InteractionOutcome
  readonly requestDigest: string
  readonly responseDigest: string
  readonly requestRevision?: number
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly model?: string
  readonly runner?: string
}

export interface InteractionRecord {
  readonly key: string
  readonly runId: string
  readonly interactionId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly model?: string
  readonly runner?: string
  readonly request: SafeInteractionRequest
  readonly requestDigest?: string
  readonly requestRevision?: number
  readonly status: InteractionStatus
  readonly arrivalSequence: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly deadlineAt?: string
  readonly pendingResponse?: PendingInteractionResponse
  readonly resolution?: InteractionResolution
}

export interface InteractionQueueState {
  readonly revision: number
  readonly sequence: number
  readonly appliedEventIds: readonly string[]
  readonly interactions: readonly InteractionRecord[]
  readonly queue: readonly string[]
  readonly rules: readonly AutomationRuleRecord[]
  readonly audits: readonly AutomationAuditRecord[]
  readonly feedbackDecisions: readonly FeedbackDecisionRecord[]
}

export interface AutomationRuleMatcher {
  readonly interactionKind?: string
  readonly subjectType?: string
  readonly subjectValue?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly runner?: string
  readonly workspaceId?: string
  readonly providerSessionId?: string
}

export type AutomationScope = 'once' | 'session' | 'persistent'

export interface AutomationRuleRecord {
  readonly id: string
  readonly enabled: boolean
  readonly interactionKey?: string
  readonly matcher: AutomationRuleMatcher
  readonly answer: NonSecretInteractionData
  readonly responseScope: AutomationScope
  readonly createdAt: string
  readonly expiresAt?: string
  readonly maximumUses?: number
  readonly uses: number
  readonly priority: number
  readonly operationId?: string
  readonly commandDigest?: string
}

export interface AutomationDryRunRecord {
  readonly key: string
  readonly eligible: boolean
  readonly candidates: readonly {
    readonly ruleId: string
    readonly eligible: boolean
    readonly reason?: string
    readonly responseScope: AutomationRuleRecord['responseScope']
  }[]
  readonly replayed: boolean
}

export type AutomationAuditOutcome =
  | 'dry-run'
  | 'matched'
  | 'skipped'
  | 'conflict'
  | 'expired'
  | 'use-limit'
  | 'applied'
  | 'disabled'
  | 'deleted'
  | 'secret-rejected'

export interface AutomationAuditRecord {
  readonly id: string
  readonly operationId?: string
  readonly interactionKey?: string
  readonly ruleId?: string
  readonly kind: string
  readonly outcome: AutomationAuditOutcome
  readonly reason?: string
  readonly answerDigest?: string
  readonly createdAt: string
}

export type FeedbackDecisionCategory =
  | 'approval'
  | 'rejection'
  | 'revision'
  | 'selection'
  | 'automation'

export interface FeedbackDecisionRecord {
  readonly id: string
  readonly interactionKey: string
  readonly runId: string
  readonly interactionId: string
  readonly category: FeedbackDecisionCategory
  readonly chosenOption: string
  readonly dataDigest?: string
  readonly feedback?: string
  readonly automated: boolean
  readonly containsSecret: boolean
  readonly createdAt: string
}

export type InteractionEvent =
  | {
      readonly kind: 'interaction.requested'
      readonly interaction: InteractionRecord
    }
  | {
      readonly kind: 'interaction.response.requested'
      readonly key: string
      readonly runId: string
      readonly interactionId: string
      readonly operationId: string
      readonly outcome: InteractionOutcome
      readonly requestDigest?: string
      readonly responseDigest?: string
      readonly requestRevision?: number
      readonly providerSessionId?: string
      readonly profileDigest?: string
      readonly connectionId?: string
      readonly workspaceId?: string
      readonly conversationId?: string
      readonly branchId?: string
      readonly model?: string
      readonly runner?: string
      readonly publicData?: NonSecretInteractionData
      readonly dataDigest?: string
      readonly containsSecret: boolean
    }
  | {
      readonly kind: 'interaction.resolved'
      readonly key: string
      readonly status: Extract<
        InteractionStatus,
        | 'resolved'
        | 'declined'
        | 'cancelled'
        | 'expired'
        | 'unknown'
        | 'conflict'
        | 'identity_conflict'
        | 'unsupported'
        | 'unknown_interaction'
        | 'unknown_run'
        | 'transport_error'
      >
      readonly resolution?: InteractionResolution
      readonly reason?: string
    }
  | {
      readonly kind: 'automation.rule.created'
      readonly rule: AutomationRuleRecord
    }
  | {
      readonly kind: 'automation.rule.disabled'
      readonly ruleId: string
      readonly operationId?: string
      readonly commandDigest?: string
    }
  | {
      readonly kind: 'automation.rule.updated'
      readonly rule: AutomationRuleRecord
    }
  | {
      readonly kind: 'automation.command.recorded'
      readonly operationId: string
      readonly commandDigest: string
      readonly result: boolean | AutomationDryRunRecord
    }
  | {
      readonly kind: 'automation.rule.deleted'
      readonly ruleId: string
      readonly operationId?: string
      readonly commandDigest?: string
    }
  | {
      readonly kind: 'automation.rule.used'
      readonly ruleId: string
    }
  | {
      readonly kind: 'automation.rule.applied'
      readonly ruleId: string
      readonly audit: AutomationAuditRecord
    }
  | {
      readonly kind: 'automation.audit.recorded'
      readonly audit: AutomationAuditRecord
    }
  | {
      readonly kind: 'feedback.decision.recorded'
      readonly decision: FeedbackDecisionRecord
    }

export interface InteractionEventEnvelope {
  readonly eventId?: string
  readonly sequence: number
  readonly revision: number
  readonly occurredAt: string
  readonly event: InteractionEvent
}

export function interactionKey(runId: string, interactionId: string): string {
  return lengthDelimitedIdentity(runId, interactionId)
}

export function initialInteractionState(): InteractionQueueState {
  return {
    revision: 0,
    sequence: 0,
    appliedEventIds: [],
    interactions: [],
    queue: [],
    rules: [],
    audits: [],
    feedbackDecisions: [],
  }
}
