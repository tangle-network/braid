import type {
  AnalystFinding,
  AnalystRegistry,
  ExactAnalystRunEvent,
  ExactAnalystRunResult,
} from '@tangle-network/agent-eval'
import type { W11AnalysisKind } from './analysts.js'
import type { CitationValidation } from './citations.js'
import type { JsonObject, JsonValue } from './serialization.js'
import { diagnosticFor, sanitizeDiagnosticText } from './diagnostics.js'
import type {
  AnalysisSourcePort,
  FrozenAnalysisSource,
  FrozenAnalysisSourceHandle,
} from './source.js'

export type { JsonObject, JsonValue } from './serialization.js'

export type AnalysisStatus = 'running' | 'complete' | 'partial' | 'failed' | 'cancelled' | 'unknown'

export interface AnalysisBudget {
  readonly totalUsd: number
  readonly weights?: Readonly<Record<string, number>>
}

export interface AnalysisRequest {
  readonly operationId: string
  readonly analysisId: string
  readonly sourceId: string
  readonly kind: W11AnalysisKind
  readonly question?: string
  readonly analystIds?: readonly string[]
  readonly budget?: AnalysisBudget
  readonly timeoutMs?: number
  readonly tags?: Readonly<Record<string, string>>
}

export type AnalysisProgress =
  | { readonly type: 'source-frozen'; readonly sourceDigest: string; readonly at: string }
  | {
      readonly type: 'dispatch-planned'
      readonly analystIds: readonly string[]
      readonly at: string
    }
  | {
      readonly type: ExactAnalystRunEvent['type']
      readonly event: ExactAnalystRunEvent
      readonly at: string
    }
  | {
      readonly type: 'citations-validated'
      readonly validation: CitationValidation
      readonly at: string
    }
  | { readonly type: 'persisted'; readonly at: string }
  | {
      readonly type: 'failed'
      readonly code: string
      readonly message: string
      readonly at: string
    }

export interface AnalysisTelemetry {
  readonly totalCostUsd: number | null
  readonly costProvenance: JsonValue | null
  readonly latencyMs: number | null
  readonly calls: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly totalTokens: number | null
  readonly perAnalyst: JsonValue
}

export interface AnalysisError {
  readonly code:
    | 'INVALID_REQUEST'
    | 'SOURCE_CHANGED'
    | 'CITATION_UNRESOLVED'
    | 'ANALYST_FAILED'
    | 'CANCELLED'
    | 'SOURCE_INCOMPLETE'
    | 'SOURCE_REPLAY_UNAVAILABLE'
    | 'OPERATION_CONFLICT'
    | 'OPERATION_UNKNOWN'
    | 'UNKNOWN'
  readonly message: string
  readonly details?: JsonObject
}

export interface AnalysisRecord {
  readonly analysisId: string
  readonly operationId: string
  readonly sourceId: string
  readonly sourceDigest: string
  readonly source: FrozenAnalysisSource | null
  readonly kind: W11AnalysisKind
  readonly question?: string
  readonly analystIds: readonly string[]
  readonly budget: AnalysisBudget | null
  readonly registryRun?: ExactAnalystRunResult
  readonly telemetry?: AnalysisTelemetry
  readonly findings: readonly AnalystFinding[]
  readonly citations: CitationValidation | null
  readonly progress: readonly AnalysisProgress[]
  readonly status: AnalysisStatus
  readonly error?: AnalysisError
  readonly startedAt: string
  readonly endedAt: string
  readonly promotedFindingIds?: readonly string[]
}

export type AnalysisOperationKind = 'analysis' | 'promotion' | 'fork' | 'cancel'
export type AnalysisOperationStatus = 'pending' | 'terminal' | 'unknown'

export interface AnalysisOperationRecord {
  readonly operationId: string
  readonly kind: AnalysisOperationKind
  readonly targetId: string
  readonly requestDigest: string
  readonly status: AnalysisOperationStatus
  readonly result?: JsonValue
  readonly ownerId?: string
  readonly leaseUntil?: string
  readonly updatedAt: string
}

export interface AnalysisOperationReservation {
  readonly record: AnalysisOperationRecord
  readonly created: boolean
  readonly reclaimed?: boolean
}

export interface AnalysisOperationRepository {
  reserve(
    input: Omit<AnalysisOperationRecord, 'status' | 'result' | 'updatedAt'> & {
      readonly updatedAt: string
    },
  ): Promise<AnalysisOperationReservation>
  renew(
    operationId: string,
    requestDigest: string,
    updatedAt: string,
    leaseUntil: string,
    ownerId: string,
  ): Promise<boolean>
  complete(
    operationId: string,
    requestDigest: string,
    result: JsonValue,
    updatedAt: string,
    ownerId?: string,
  ): Promise<void>
  markUnknown(
    operationId: string,
    requestDigest: string,
    updatedAt: string,
    ownerId?: string,
  ): Promise<void>
  getOperation(operationId: string): Promise<AnalysisOperationRecord | null>
}

export interface AnalysisRepository extends AnalysisOperationRepository {
  save(record: AnalysisRecord): Promise<void>
  /** Atomically publishes a terminal record only while its operation lease is owned. */
  commitRecord(
    record: AnalysisRecord,
    requestDigest: string,
    updatedAt: string,
    ownerId?: string,
  ): Promise<boolean>
  commitUnknownRecord(
    record: AnalysisRecord,
    requestDigest: string,
    updatedAt: string,
  ): Promise<boolean>
  get(analysisId: string): Promise<AnalysisRecord | null>
  list(): Promise<readonly AnalysisRecord[]>
}

export interface AnalysisPromotionPort {
  attach(input: {
    readonly operationId: string
    readonly analysisId: string
    readonly sourceId: string
    readonly sourceDigest: string
    readonly findingIds: readonly string[]
  }): Promise<void>
}

export interface AnalysisForkPort {
  forkFromAnalysis(input: {
    readonly operationId: string
    readonly analysisId: string
    readonly sourceId: string
    readonly sourceDigest: string
    readonly findingIds: readonly string[]
  }): Promise<{ readonly branchId: string }>
}

export interface AnalysisServiceOptions {
  readonly source: AnalysisSourcePort
  readonly repository: AnalysisRepository
  readonly registry?: AnalystRegistry
  readonly promotion?: AnalysisPromotionPort
  readonly fork?: AnalysisForkPort
  readonly now?: () => string
  readonly ownerId?: string
  readonly leaseMs?: number
}

export interface AnalysisCancellationReceipt {
  readonly operationId: string
  readonly analysisId: string
  readonly status: 'pending' | 'cancelled' | 'unknown'
}

export class AnalysisServiceError extends Error {
  readonly code: AnalysisError['code']
  readonly details?: JsonObject

  constructor(code: AnalysisError['code'], message: string, details?: JsonObject) {
    super(sanitizeDiagnosticText(message))
    this.name = 'AnalysisServiceError'
    this.code = code
    const safeDetails = details ? diagnosticFor({ message, details }, code).details : undefined
    if (safeDetails) this.details = safeDetails
  }
}

export type { AnalysisSourcePort, FrozenAnalysisSource, FrozenAnalysisSourceHandle }
