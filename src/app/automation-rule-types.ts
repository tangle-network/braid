import type { InteractionRequest, InteractionResponse } from '@tangle-network/agent-interface'
import type {
  AutomationAuditRecord,
  AutomationRuleScope,
  NonSecretInteractionData,
} from '../domain/entities-interactions.js'
import type { AutomationRuleMatcher } from '../domain/entities-runtime.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { Digest, RuleId } from '../domain/ids.js'
import type { BraidInteraction } from '../domain/runtime-projection.js'
import type { BraidState } from '../domain/state.js'
import type { JournalWriter } from './application-ports.js'
import type { InteractionReceipt } from './application-types.js'
import type {
  AutomationEvaluation,
  AutomationEvaluationContext,
  AutomationRuleMetadata,
  StoredAutomationRule,
} from './automation-matching.js'

export interface AutomationContext {
  readonly profileDigest?: Digest
  readonly connectionId?: string
  readonly runner?: string
  readonly workspaceId?: string
  readonly providerSessionId?: string
}

export interface AutomationStoreInput {
  readonly state: () => BraidState
  readonly events: () => readonly BraidEventEnvelope[]
  readonly commitAndWait: JournalWriter['commitAndWait']
  readonly now?: () => string
}

export interface CreateAutomationRuleInput extends AutomationStoreInput {
  readonly operationId: string
  readonly ruleId: string
  readonly request: InteractionRequest
  readonly answer: NonSecretInteractionData
  readonly responseScope: AutomationRuleScope
  readonly matcher?: AutomationRuleMatcher
  readonly context?: AutomationContext
  readonly expiresAt?: string
  readonly maximumUses?: number
  readonly confirmPersistent?: boolean
  readonly creationSource?: AutomationRuleMetadata['creationSource']
}

export interface AutomationRuleReceipt {
  readonly operationId: string
  readonly ruleId: RuleId
  readonly rule: StoredAutomationRule
  readonly replayed: boolean
  readonly revision: number
}

export interface RuleMutationReceipt {
  readonly operationId: string
  readonly ruleId: RuleId
  readonly rule?: StoredAutomationRule
  readonly replayed: boolean
  readonly revision: number
}

export interface AutomationDryRunInput extends AutomationStoreInput {
  readonly operationId: string
  readonly interaction: BraidInteraction
  readonly context: AutomationContext
}

export interface AutomationDryRunReceipt {
  readonly operationId: string
  readonly replayed: boolean
  readonly evaluation: AutomationEvaluation
  readonly revision: number
}

export interface ApplyAutomationInput extends AutomationStoreInput {
  readonly operationId: string
  readonly interaction: BraidInteraction
  readonly context: AutomationContext
  readonly respond: (
    response: InteractionResponse,
    options: { readonly automated: true },
  ) => Promise<InteractionReceipt>
}

export interface ApplyAutomationReceipt {
  readonly operationId: string
  readonly replayed: boolean
  readonly evaluation: AutomationEvaluation
  readonly response?: InteractionReceipt
  readonly revision: number
}

export type { AutomationAuditRecord, AutomationRuleScope, NonSecretInteractionData }
export type {
  AutomationEvaluation,
  AutomationEvaluationContext,
  AutomationRuleMetadata,
  StoredAutomationRule,
}
