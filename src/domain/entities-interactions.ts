import type { InteractionRequest } from '@tangle-network/agent-interface'
import type {
  AnalysisId,
  AnalysisRunId,
  BranchId,
  CitationId,
  ConversationId,
  Digest,
  EventId,
  InteractionId,
  MessageId,
  MessagePartId,
  OperationId,
  ProfileId,
  ProviderSessionId,
  RunId,
  TraceId,
} from './ids.js'
import type { IsoDateTime, MissingHistoryRange } from './entities-base.js'
import type { TurnUsage } from './entities-core.js'

export type BraidInteractionSubject =
  | { readonly type: 'tool'; readonly toolName: string }
  | { readonly type: 'command'; readonly command: string }
  | { readonly type: 'file'; readonly path: string; readonly preview?: string }
  | { readonly type: 'resource'; readonly uri: string }

/**
 * The durable interaction request keeps the canonical answer specification and
 * public subject summary, but deliberately drops provider-owned subject input
 * and default answer values that could contain secrets.
 */
export interface BraidInteractionRequest {
  readonly id: InteractionId
  readonly kind: string
  readonly title: string
  readonly body?: string
  readonly subject?: BraidInteractionSubject
  readonly answerSpec: InteractionRequest['answerSpec']
  readonly timeoutMs?: number
  readonly onTimeout?: 'default' | 'fail' | 'wait'
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

export type NonSecretInteractionValue = string | number | boolean | readonly string[]
export type NonSecretInteractionData = Readonly<Record<string, NonSecretInteractionValue>>

export interface InteractionResolutionRecord {
  readonly outcome: 'accepted' | 'declined' | 'cancelled'
  readonly operationId: OperationId
  readonly publicData?: NonSecretInteractionData
  readonly dataDigest?: Digest
  readonly containsSecret: boolean
  readonly resolvedAt: IsoDateTime
}

export interface InteractionRecord {
  readonly id: InteractionId
  readonly runId: RunId
  readonly providerSessionId?: ProviderSessionId
  readonly request: BraidInteractionRequest
  readonly status: InteractionStatus
  readonly resolution?: InteractionResolutionRecord
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
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
  readonly source: FrozenAnalysisSource
  readonly question?: string
  readonly recipe?: string
  readonly analystProfileId?: ProfileId
  readonly analystProfileDigest?: Digest
  readonly status: AnalysisStatus
  readonly findings: readonly AnalysisFinding[]
  readonly usage?: TurnUsage
  readonly costUsd?: number
  readonly wallTimeMs?: number
  readonly createdAt: IsoDateTime
  readonly updatedAt: IsoDateTime
}
