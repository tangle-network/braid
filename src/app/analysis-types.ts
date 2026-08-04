import type {
  AnalysisRecord,
  FrozenAnalysisSource,
  MessagePartRecord,
  MessageRecord,
  RunRecord,
} from '../domain/entities.js'
import type { BraidEvent, BraidEventEnvelope } from '../domain/events.js'
import type {
  AnalysisId,
  AnalysisRunId,
  BranchId,
  ConversationId,
  Digest,
  EventId,
  MessageId,
  ProfileId,
  RunId,
} from '../domain/ids.js'
import type { BraidState } from '../domain/state.js'

export type AnalysisRecipe = 'ask' | 'failure' | 'cost' | 'tools' | 'improvement' | (string & {})

export interface AnalysisSourceRequest {
  readonly conversationId?: ConversationId
  readonly branchId?: BranchId
  readonly runId?: RunId
  readonly throughMessageId?: MessageId
}

export interface AnalysisRequest extends AnalysisSourceRequest {
  readonly operationId?: string
  readonly question?: string
  readonly recipe?: AnalysisRecipe
  readonly analystIds?: readonly string[]
  readonly analystProfileId?: ProfileId
  readonly analystProfileDigest?: Digest
  readonly budgetUsd?: number
  readonly totalTimeoutMs?: number
}

export interface FrozenAnalysisEvent {
  readonly id: EventId
  readonly sequence: number
  readonly revision: number
  readonly occurredAt: string
  readonly event: BraidEvent
}

export interface FrozenAnalysisEvidence {
  readonly source: FrozenAnalysisSource
  readonly run?: RunRecord
  readonly events: readonly FrozenAnalysisEvent[]
  readonly messages: readonly MessageRecord[]
  readonly messageParts: readonly MessagePartRecord[]
}

export interface AnalysisApplicationHost {
  readonly currentState: () => BraidState
  readonly eventHistory: () => readonly BraidEventEnvelope[]
  readonly commit: (event: BraidEvent) => void | Promise<void>
  readonly commitAndWait?: (event: BraidEvent) => void | Promise<void>
  readonly now: () => string
}

export interface AnalysisProgressStarted {
  readonly type: 'started'
  readonly analysis: AnalysisRecord
  readonly replayed?: boolean
}

export interface AnalysisProgressRunning {
  readonly type: 'running'
  readonly analysis: AnalysisRecord
}

export interface AnalysisProgressAnalyst {
  readonly type: 'analyst'
  readonly analysisId: AnalysisId
  readonly analysisRunId: AnalysisRunId
  readonly event: unknown
}

export interface AnalysisProgressCompleted {
  readonly type: 'completed'
  readonly analysis: AnalysisRecord
  readonly evidence: FrozenAnalysisEvidence
  readonly result: unknown
  readonly replayed?: boolean
}

export interface AnalysisProgressFailed {
  readonly type: 'failed'
  readonly analysis: AnalysisRecord
  readonly evidence: FrozenAnalysisEvidence
  readonly error: AnalysisCapabilityError | Error
  readonly result?: unknown
  readonly replayed?: boolean
}

export interface AnalysisProgressCancelled {
  readonly type: 'cancelled'
  readonly analysis: AnalysisRecord
  readonly evidence: FrozenAnalysisEvidence
  readonly reason?: string
  readonly replayed?: boolean
}

export type AnalysisProgress =
  | AnalysisProgressStarted
  | AnalysisProgressRunning
  | AnalysisProgressAnalyst
  | AnalysisProgressCompleted
  | AnalysisProgressFailed
  | AnalysisProgressCancelled

export interface AnalysisCapabilityIssue {
  readonly capability: string
  readonly packageName: string
  readonly packageVersion: string
  readonly reason: string
  readonly reproduction: string
}

export class AnalysisCapabilityError extends Error {
  readonly code = 'ANALYSIS_CAPABILITY_UNAVAILABLE'
  readonly issue: AnalysisCapabilityIssue

  constructor(issue: AnalysisCapabilityIssue) {
    super(`${issue.capability} is unavailable: ${issue.reason}`)
    this.name = 'AnalysisCapabilityError'
    this.issue = issue
  }
}

export class AnalysisSourceError extends Error {
  readonly code = 'ANALYSIS_SOURCE_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'AnalysisSourceError'
  }
}

export class AnalysisCitationError extends Error {
  readonly code = 'ANALYSIS_CITATION_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'AnalysisCitationError'
  }
}

export class AnalysisPersistenceError extends Error {
  readonly code = 'ANALYSIS_PERSISTENCE_UNKNOWN'

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AnalysisPersistenceError'
  }
}
