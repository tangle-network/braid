import type { InteractionRequest, InteractionData } from '@tangle-network/agent-interface'
import type {
  InteractionEventEnvelope,
  InteractionQueueState,
  AutomationRuleMatcher,
  AutomationRuleRecord,
} from '../domain/interaction-state.js'
import type { Clock } from '../ports/clock.js'
import type { IdSource } from '../ports/ids.js'
import type { InteractionRuntimePort } from '../ports/interactions.js'

export interface InteractionControllerOptions {
  readonly runtime: InteractionRuntimePort
  readonly clock: Clock
  readonly ids: IdSource
  readonly initialState?: InteractionQueueState
  readonly initialEvents?: readonly InteractionEventEnvelope[]
  readonly feedbackCapture?: boolean
  readonly defaultContext?: {
    readonly profileDigest?: string
    readonly connectionId?: string
    readonly workspaceId?: string
    readonly runner?: string
  }
}

export interface CreateAutomationRuleInput {
  readonly operationId: string
  readonly interactionKey?: string
  readonly request?: InteractionRequest
  readonly matcher?: AutomationRuleMatcher
  readonly answer: InteractionData
  readonly responseScope: 'once' | 'session' | 'persistent'
  readonly expiresAt?: string
  readonly maximumUses?: number
  readonly priority?: number
}

export interface AutomationDryRunInput {
  readonly operationId: string
  readonly key: string
}

export interface AutomationCandidate {
  readonly ruleId: string
  readonly eligible: boolean
  readonly reason?: string
  readonly responseScope: AutomationRuleRecord['responseScope']
}

export interface AutomationDryRunResult {
  readonly key: string
  readonly eligible: boolean
  readonly candidates: readonly AutomationCandidate[]
  readonly replayed: boolean
}

export type InteractionSubscriber = (
  state: InteractionQueueState,
  envelope: InteractionEventEnvelope,
) => void
