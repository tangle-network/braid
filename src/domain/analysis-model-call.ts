import type { IsoDateTime } from './entities-base.js'

export type AnalysisModelCallOutcome = 'succeeded' | 'failed'

export type AnalysisModelCallCostStatus = 'observed' | 'estimated' | 'unknown'

export interface AnalysisModelCallCost {
  readonly status: AnalysisModelCallCostStatus
  readonly usd?: number
}

/**
 * Sanitized model-call facts retained with one trace analysis.
 *
 * This shape is deliberately smaller than the Runtime and Agent Eval records.
 * It contains no prompt, response body, endpoint host or query, credential, or arbitrary metadata.
 */
export interface AnalysisModelCallRecord {
  readonly sequence: number
  readonly callId: string
  readonly callRef: string
  readonly path: '/v1/chat/completions' | '/v1/responses' | 'unknown-path'
  readonly model: string
  readonly provider?: string
  readonly route?: string
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedTokens?: number
  readonly cacheWriteTokens?: number
  readonly tokensKnown: boolean
  readonly cost: AnalysisModelCallCost
  readonly latencyMs?: number
  readonly outcome: AnalysisModelCallOutcome
  readonly responseStatus?: number
  readonly failureCode?: string
  readonly startedAt?: IsoDateTime
  readonly endedAt?: IsoDateTime
}
