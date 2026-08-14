import type { IsoDateTime, JsonValue, MissingHistoryRange } from './entities-base.js'

export type {
  NonSecretInteractionData,
  NonSecretInteractionValue,
} from './entities-base.js'

import type { AnalysisModelCallRecord } from './analysis-model-call.js'
import type { TurnUsage } from './entities-core.js'
import type {
  AnalysisId,
  AnalysisRunId,
  AttachmentId,
  BranchId,
  CitationId,
  ConversationId,
  Digest,
  EventId,
  FeedbackDecisionId,
  InteractionId,
  MessageId,
  MessagePartId,
  OperationId,
  ProfileId,
  RuleId,
  RunId,
  TraceId,
} from './ids.js'

export type AutomationRuleScope = 'once' | 'session' | 'persistent'

export type AutomationAuditOutcome =
  | 'matched'
  | 'skipped'
  | 'conflict'
  | 'expired'
  | 'use-limit'
  | 'applied'
  | 'dry-run'
  | 'disabled'
  | 'deleted'

/**
 * A durable automation audit contains only identifiers, digests, and safe
 * outcome metadata. It never contains the answer submitted to a provider.
 */
export interface AutomationAuditRecord {
  readonly id: FeedbackDecisionId
  readonly runId: RunId
  readonly interactionId: InteractionId
  readonly ruleId?: RuleId
  readonly operationId?: OperationId
  readonly requestDigest: Digest
  readonly responseDigest?: Digest
  readonly responseScope?: AutomationRuleScope
  readonly outcome: AutomationAuditOutcome
  readonly detail?: string
  readonly createdAt: IsoDateTime
}

export interface TraceReference {
  readonly id: TraceId
  readonly provider: 'runtime' | 'agent-eval' | 'external'
  readonly reference: string
  readonly digest: Digest
}

export interface FrozenAnalysisSource {
  readonly conversationId: ConversationId
  readonly branchId: BranchId
  readonly runId?: RunId
  readonly throughMessageId?: MessageId
  readonly trace?: TraceReference
  readonly digest: Digest
  readonly complete: boolean
  readonly missingHistory?: MissingHistoryRange
}

export interface AnalysisCitation {
  readonly id: CitationId
  readonly eventId?: EventId
  readonly messageId?: MessageId
  readonly partId?: MessagePartId
  readonly start?: number
  readonly end?: number
  readonly quote?: string
}

export interface AnalysisFinding {
  readonly id: string
  readonly text: string
  readonly severity?: 'info' | 'low' | 'medium' | 'high' | 'critical'
  readonly confidence?: number
  readonly citations: readonly AnalysisCitation[]
  readonly supported: boolean
  readonly supportError?: string
}

export interface AnalysisSourceRange {
  readonly eventIds: readonly EventId[]
  readonly messageIds: readonly MessageId[]
  readonly messagePartIds: readonly MessagePartId[]
  readonly firstSequence?: number
  readonly lastSequence?: number
}

export interface AnalysisCheck {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'unavailable'
  readonly detail?: string
}

export interface AnalysisProvenance {
  readonly operationId: OperationId
  readonly requestDigest: Digest
  readonly analystIds: readonly string[]
  readonly analystVersions: readonly { readonly id: string; readonly version: string }[]
  readonly agentEvalVersion?: string
  readonly profileId?: ProfileId
  readonly profileDigest?: Digest
  readonly model?: string
  readonly runner?: string
  readonly connectionId?: import('./ids.js').ConnectionId
  readonly connectionDigest?: Digest
  readonly tools: readonly string[]
  readonly completeness: 'complete' | 'incomplete' | 'unknown'
  readonly checks: readonly AnalysisCheck[]
}

export interface AnalysisComparisonField {
  readonly name: string
  readonly baseline?: JsonValue
  readonly candidate?: JsonValue
  readonly baselinePresent: boolean
  readonly candidatePresent: boolean
  readonly asymmetry: 'none' | 'baseline-only' | 'candidate-only' | 'both-missing'
}

export interface AnalysisComparisonSnapshot {
  readonly baseline: FrozenAnalysisSource
  readonly candidate: FrozenAnalysisSource
  readonly fields: readonly AnalysisComparisonField[]
  readonly rows: readonly JsonValue[]
  readonly paired: JsonValue
  readonly semantic: {
    readonly status: 'unavailable'
    readonly reason: string
  }
}

export type AnalysisStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unknown'

export interface AnalysisRecord {
  readonly id: AnalysisId
  readonly analysisRunId?: AnalysisRunId
  readonly kind?: 'analysis' | 'comparison'
  readonly operationId?: OperationId
  readonly requestDigest?: Digest
  readonly request?: JsonValue
  readonly source: FrozenAnalysisSource
  readonly sourceRange?: AnalysisSourceRange
  readonly question?: string
  readonly recipe?: string
  readonly analystProfileId?: ProfileId
  readonly analystProfileDigest?: Digest
  readonly status: AnalysisStatus
  readonly findings: readonly AnalysisFinding[]
  readonly provenance?: AnalysisProvenance
  readonly checks?: readonly AnalysisCheck[]
  readonly comparison?: AnalysisComparisonSnapshot
  readonly usage?: TurnUsage
  readonly modelCalls?: readonly AnalysisModelCallRecord[]
  readonly costUsd?: number
  readonly wallTimeMs?: number
  readonly error?: string
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}

export interface PromotedAnalysisFindingRecord {
  readonly id: string
  readonly text: string
  readonly citations: readonly AnalysisCitation[]
}

export interface AnalysisAttachmentRecord {
  readonly id: AttachmentId
  readonly operationId: OperationId
  readonly analysisId: AnalysisId
  readonly analysisRunId?: AnalysisRunId
  readonly sourceConversationId: ConversationId
  readonly sourceBranchId: BranchId
  readonly sourceRunId?: RunId
  readonly sourceDigest: Digest
  readonly destinationConversationId: ConversationId
  readonly destinationBranchId: BranchId
  readonly selectedFindings: readonly PromotedAnalysisFindingRecord[]
  readonly provenance: Readonly<{
    readonly analysisId: AnalysisId
    readonly sourceDigest: Digest
    readonly analystProfileDigest?: Digest
    readonly model?: string
    readonly runner?: string
    readonly agentEvalVersion?: string
  }>
  readonly createdAt: IsoDateTime
}
