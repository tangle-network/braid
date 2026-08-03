import type {
  InteractionOutcome,
  NonSecretInteractionData,
  SafeInteractionRequest,
} from './interaction.js'

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

export interface InteractionResolution {
  readonly outcome: InteractionOutcome
  readonly operationId: string
  readonly publicData?: NonSecretInteractionData
  readonly dataDigest?: string
  readonly containsSecret: boolean
  readonly resolvedAt: string
}

export interface InteractionRecord {
  readonly key: string
  readonly runId: string
  readonly interactionId: string
  readonly providerSessionId?: string
  readonly profileDigest?: string
  readonly connectionId?: string
  readonly workspaceId?: string
  readonly runner?: string
  readonly request: SafeInteractionRequest
  readonly status: InteractionStatus
  readonly arrivalSequence: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly deadlineAt?: string
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
      readonly publicData?: NonSecretInteractionData
      readonly dataDigest?: string
      readonly containsSecret: boolean
    }
  | {
      readonly kind: 'interaction.resolved'
      readonly key: string
      readonly status: Extract<
        InteractionStatus,
        'resolved' | 'declined' | 'cancelled' | 'expired' | 'unknown' | 'conflict'
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
    }
  | {
      readonly kind: 'automation.rule.deleted'
      readonly ruleId: string
    }
  | {
      readonly kind: 'automation.rule.used'
      readonly ruleId: string
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
  return `${runId}:${interactionId}`
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
