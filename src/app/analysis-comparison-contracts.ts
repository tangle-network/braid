import type { PairedArmRow, PairedArmsComparison } from '@tangle-network/agent-eval'
import type {
  AnalysisComparisonField,
  AnalysisComparisonSnapshot,
  AnalysisRecord,
} from '../domain/entities.js'
import type { AnalysisSourceRequest, FrozenAnalysisEvidence } from './analysis-types.js'

export interface AnalysisComparisonRequest {
  readonly baseline: FrozenAnalysisEvidence
  readonly candidate: FrozenAnalysisEvidence
  readonly metricNames?: readonly string[]
  readonly bootstrapSeed?: number
}

export interface AnalysisComparisonResult {
  readonly baselineSourceDigest: string
  readonly candidateSourceDigest: string
  readonly baselineRunId: string
  readonly candidateRunId: string
  readonly fields: readonly AnalysisComparisonField[]
  readonly rows: readonly PairedArmRow[]
  readonly paired: PairedArmsComparison
  readonly semantic: {
    readonly status: 'unavailable'
    readonly reason: string
  }
  readonly replayed?: boolean
}

export interface CompareAnalysisInput {
  readonly operationId?: string
  readonly baseline: AnalysisSourceRequest
  readonly candidate: AnalysisSourceRequest
  readonly metricNames?: readonly string[]
  readonly bootstrapSeed?: number
}

export interface PreparedComparisonRequest {
  readonly baseline: FrozenAnalysisEvidence
  readonly candidate: FrozenAnalysisEvidence
  readonly identity: import('./analysis-operation.js').AnalysisIdentity
}

export interface PersistedComparison {
  readonly record: AnalysisRecord
  readonly result: AnalysisComparisonResult
}

export type { AnalysisComparisonSnapshot }
