import { AnalysisCancellationCoordinator } from './cancellation.js'
import { type AnalysisRequest, AnalysisServiceError, type AnalysisServiceOptions } from './model.js'
import { operationDigest } from './operations.js'
import { AnalysisPromotionCoordinator } from './promotion.js'
import { AnalysisRunner } from './run.js'
import { randomUUID } from 'node:crypto'

export type {
  AnalysisBudget,
  AnalysisCancellationReceipt,
  AnalysisError,
  AnalysisForkPort,
  AnalysisOperationKind,
  AnalysisOperationRecord,
  AnalysisOperationRepository,
  AnalysisOperationReservation,
  AnalysisOperationStatus,
  AnalysisProgress,
  AnalysisPromotionPort,
  AnalysisRecord,
  AnalysisRepository,
  AnalysisRequest,
  AnalysisServiceOptions,
  AnalysisStatus,
} from './model.js'
export { AnalysisServiceError } from './model.js'
export { EncryptedAnalysisRepository, InMemoryAnalysisRepository } from './repository.js'
export type { AnalysisState } from './repository.js'
export {
  EnvironmentStateKeyPort,
  MemoryStateKeyPort,
  StateConflictError,
  type BraidStateKeyPort,
  type BraidStatePort,
  type BraidStateSnapshot,
} from './state-port.js'
export {
  EncryptedBraidStatePort,
  type EncryptedBraidStatePortOptions,
} from './encrypted-state-port.js'
export { analysisDigest } from './result.js'
export type { JsonObject, JsonPrimitive, JsonValue } from './serialization.js'
export { toJsonValue } from './serialization.js'

export class AnalysisService {
  private readonly runner: AnalysisRunner
  private readonly cancellation: AnalysisCancellationCoordinator
  private readonly promotion: AnalysisPromotionCoordinator
  private readonly activeRuns = new Map<
    string,
    {
      readonly requestDigest: string
      readonly promise: Promise<import('./model.js').AnalysisRecord>
    }
  >()

  constructor(options: AnalysisServiceOptions) {
    const now = options.now ?? (() => new Date().toISOString())
    const ownerId = options.ownerId ?? `analysis-owner-${randomUUID()}`
    const registry =
      options.registry ??
      (() => {
        throw new Error(
          'A configured analyst registry is required; use createW11FixtureAnalystRegistry only in tests',
        )
      })()
    this.cancellation = new AnalysisCancellationCoordinator(options.repository, now)
    this.runner = new AnalysisRunner({
      source: options.source,
      repository: options.repository,
      registry,
      cancellation: this.cancellation,
      now,
      ownerId,
      leaseMs: options.leaseMs ?? 30_000,
    })
    this.promotion = new AnalysisPromotionCoordinator(
      options.source,
      options.repository,
      options.promotion,
      options.fork,
      now,
    )
  }

  async run(request: AnalysisRequest): Promise<import('./model.js').AnalysisRecord> {
    const requestDigest = operationDigest('analysis', request.analysisId, request)
    const active = this.activeRuns.get(request.operationId)
    if (active) {
      if (active.requestDigest !== requestDigest)
        throw new AnalysisServiceError(
          'OPERATION_CONFLICT',
          'The operation ID is already running another request',
        )
      return active.promise
    }
    const promise = this.runner.run(request, requestDigest)
    this.activeRuns.set(request.operationId, { requestDigest, promise })
    try {
      return await promise
    } finally {
      this.activeRuns.delete(request.operationId)
    }
  }

  get(analysisId: string): Promise<import('./model.js').AnalysisRecord | null> {
    return this.runner.get(analysisId)
  }

  cancel(
    analysisId: string,
    operationId: string,
    reason = 'Cancelled by user',
  ): Promise<import('./model.js').AnalysisCancellationReceipt> {
    return this.requestCancel(analysisId, operationId, reason)
  }

  requestCancel(
    analysisId: string,
    operationId: string,
    reason = 'Cancelled by user',
  ): Promise<import('./model.js').AnalysisCancellationReceipt> {
    return this.cancellation.request(analysisId, operationId, reason)
  }

  promote(
    analysisId: string,
    operationId: string,
    findingIds?: readonly string[],
  ): Promise<import('./model.js').AnalysisRecord> {
    return this.promotion.promote(analysisId, operationId, findingIds)
  }

  forkFromAnalysis(
    analysisId: string,
    operationId: string,
    findingIds?: readonly string[],
  ): Promise<{ readonly branchId: string }> {
    return this.promotion.forkFromAnalysis(analysisId, operationId, findingIds)
  }
}
