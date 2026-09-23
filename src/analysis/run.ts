import type { AnalystRegistry } from '@tangle-network/agent-eval'
import { analystIdForKind } from './analysts.js'
import type { AnalysisCancellationCoordinator } from './cancellation.js'
import { validateFindingCitations } from './citations.js'
import { dispatchAnalysis, validateAnalysisRequest } from './dispatch.js'
import {
  type AnalysisProgress,
  type AnalysisOperationRecord,
  type AnalysisRecord,
  type AnalysisRepository,
  type AnalysisRequest,
  AnalysisServiceError,
} from './model.js'
import { operationConflict, reserveInput } from './operations.js'
import {
  completeAnalysisRecord,
  failedAnalysisRecord,
  failureCode,
  unknownAnalysisRecord,
} from './result.js'
import { toJsonValue } from './serialization.js'
import type { AnalysisSourcePort, FrozenAnalysisSourceHandle } from './source.js'
import { assertSourceUnchanged, freezeAnalysisSource } from './source-freeze.js'

export interface AnalysisRunnerOptions {
  readonly source: AnalysisSourcePort
  readonly repository: AnalysisRepository
  readonly registry: AnalystRegistry
  readonly cancellation: AnalysisCancellationCoordinator
  readonly now: () => string
  readonly ownerId: string
  readonly leaseMs: number
}

export class AnalysisRunner {
  constructor(private readonly options: AnalysisRunnerOptions) {}

  get(analysisId: string): Promise<AnalysisRecord | null> {
    return this.options.repository.get(analysisId)
  }

  async run(request: AnalysisRequest, requestDigest: string): Promise<AnalysisRecord> {
    const { repository, now } = this.options
    validateAnalysisRequest(request, this.options.registry)
    const reservation = await repository.reserve(
      reserveInput(
        request.operationId,
        'analysis',
        request.analysisId,
        { kind: 'analysis', targetId: request.analysisId, request },
        now(),
        this.options.ownerId,
        new Date(Date.parse(now()) + this.options.leaseMs).toISOString(),
      ),
    )
    if (reservation.record.requestDigest !== requestDigest)
      operationConflict(reservation.record, requestDigest)
    if (reservation.reclaimed) return this.#reconcileUncertain(request, requestDigest)
    const existing = await repository.get(request.analysisId)
    if (
      reservation.created &&
      existing &&
      existing.operationId === request.operationId &&
      existing.status !== 'running'
    ) {
      if (existing.status === 'unknown') {
        return this.#markUnknown(request, requestDigest)
      }
      try {
        if (await repository.commitRecord(existing, requestDigest, now(), this.options.ownerId))
          return existing
      } catch {
        return this.#reconcileUncertain(request, requestDigest)
      }
      return this.#reconcileUncertain(request, requestDigest)
    }
    if (!reservation.created) {
      if (reservation.record.status === 'terminal' || reservation.record.status === 'unknown') {
        if (reservation.record.result) return reservation.record.result as unknown as AnalysisRecord
        return unknownAnalysisRecord(
          request,
          'A previous process left this operation without a result',
          now(),
        )
      }
      if (
        reservation.record.status === 'pending' &&
        reservation.record.ownerId &&
        reservation.record.ownerId !== this.options.ownerId &&
        reservation.record.leaseUntil &&
        Date.parse(reservation.record.leaseUntil) > Date.parse(now())
      ) {
        return unknownAnalysisRecord(
          request,
          'Another process owns this operation lease; its result is not yet confirmed',
          now(),
        )
      }
      if (existing && existing.status !== 'running' && existing.status !== 'unknown') {
        try {
          await repository.complete(
            request.operationId,
            requestDigest,
            toJsonValue(existing),
            now(),
          )
          return existing
        } catch {
          return this.#reconcileUncertain(request, requestDigest)
        }
      }
      return this.#markUnknown(
        request,
        requestDigest,
        'The operation was pending after a restart; it was not repeated',
      )
    }

    const startedAt = now()
    const controller = new AbortController()
    const progress: AnalysisProgress[] = []
    let frozen: FrozenAnalysisSourceHandle | undefined
    this.options.cancellation.register(request.analysisId, controller)
    const lease = this.#startLeaseRenewal(request, requestDigest, controller)
    try {
      frozen = await freezeAnalysisSource(this.options.source, request.sourceId, controller.signal)
      progress.push({ type: 'source-frozen', sourceDigest: frozen.source.digest, at: now() })
      const analystIds = request.analystIds ?? [analystIdForKind(request.kind)]
      progress.push({ type: 'dispatch-planned', analystIds, at: now() })
      const dispatched = await dispatchAnalysis({
        request,
        source: frozen,
        registry: this.options.registry,
        signal: controller.signal,
        now,
        progress,
      })
      await assertSourceUnchanged(this.options.source, frozen)
      const citations = await validateFindingCitations(frozen, dispatched.result.findings)
      progress.push({ type: 'citations-validated', validation: citations, at: now() })
      if (!citations.valid)
        throw new AnalysisServiceError(
          'CITATION_UNRESOLVED',
          'At least one finding citation does not resolve',
          { issues: toJsonValue(citations.issues) },
        )
      await assertSourceUnchanged(this.options.source, frozen)
      const persistedAt = now()
      const endedAt = now()
      const record = completeAnalysisRecord({
        request,
        source: frozen,
        analystIds: dispatched.analystIds,
        result: dispatched.result,
        citations,
        progress,
        startedAt,
        endedAt: persistedAt,
      })
      const completeRecord = { ...record, endedAt }
      let committed = false
      try {
        committed = await repository.commitRecord(
          completeRecord,
          requestDigest,
          now(),
          this.options.ownerId,
        )
      } catch {
        return this.#reconcileUncertain(request, requestDigest)
      }
      if (!committed) return this.#reconcileUncertain(request, requestDigest)
      await this.options.cancellation.complete(request.analysisId, 'cancelled')
      return completeRecord
    } catch (error) {
      const code = failureCode(error, controller.signal.aborted)
      const failedAt = now()
      const endedAt = now()
      const record = failedAnalysisRecord({
        request,
        source: frozen,
        progress,
        code,
        error,
        failedAt,
        startedAt,
        endedAt,
      })
      let committed = false
      try {
        committed = await repository.commitRecord(
          record,
          requestDigest,
          now(),
          this.options.ownerId,
        )
      } catch {
        return this.#reconcileUncertain(request, requestDigest)
      }
      if (!committed) return this.#reconcileUncertain(request, requestDigest)
      await this.options.cancellation.complete(
        request.analysisId,
        record.status === 'cancelled' ? 'cancelled' : 'unknown',
      )
      return record
    } finally {
      lease.stop()
      this.options.cancellation.unregister(request.analysisId)
    }
  }

  #startLeaseRenewal(
    request: AnalysisRequest,
    requestDigest: string,
    controller: AbortController,
  ): { readonly stop: () => void } {
    let active = true
    const timer = setInterval(
      () => {
        if (!active || controller.signal.aborted) return
        const updatedAt = this.options.now()
        const leaseUntil = new Date(Date.parse(updatedAt) + this.options.leaseMs).toISOString()
        void this.options.repository
          .renew(request.operationId, requestDigest, updatedAt, leaseUntil, this.options.ownerId)
          .then((owned) => {
            if (active && !owned) controller.abort(new Error('Analysis operation lease was lost'))
          })
          .catch(() => {})
      },
      Math.max(100, Math.floor(this.options.leaseMs / 3)),
    )
    return {
      stop: () => {
        active = false
        clearInterval(timer)
      },
    }
  }

  async #markUnknown(
    request: AnalysisRequest,
    requestDigest: string,
    message = 'The operation was pending after a restart; it was not repeated',
  ): Promise<AnalysisRecord> {
    const { repository, now } = this.options
    const unknown = unknownAnalysisRecord(request, message, now())
    try {
      await repository.markUnknown(request.operationId, requestDigest, now(), this.options.ownerId)
    } catch {
      try {
        const operation = await repository.getOperation(request.operationId)
        if (
          operation &&
          (operation.status === 'terminal' || operation.status === 'unknown') &&
          operation.result
        )
          return operation.result as unknown as AnalysisRecord
      } catch {
        // The durable outcome is unavailable; return an honest ephemeral unknown.
      }
      return unknown
    }
    try {
      await repository.commitUnknownRecord(unknown, requestDigest, now())
    } catch {
      try {
        const operation = await repository.getOperation(request.operationId)
        if (
          operation &&
          (operation.status === 'terminal' || operation.status === 'unknown') &&
          operation.result
        )
          return operation.result as unknown as AnalysisRecord
      } catch {
        // The durable outcome is unavailable; return an honest ephemeral unknown.
      }
    }
    return unknown
  }

  async #reconcileUncertain(
    request: AnalysisRequest,
    requestDigest: string,
  ): Promise<AnalysisRecord> {
    const { repository, now } = this.options
    let operation: AnalysisOperationRecord | null
    try {
      operation = await repository.getOperation(request.operationId)
    } catch {
      return unknownAnalysisRecord(request, 'The analysis outcome is unknown', now())
    }
    if (!operation || operation.requestDigest !== requestDigest)
      return unknownAnalysisRecord(request, 'The analysis outcome is unknown', now())
    if ((operation.status === 'terminal' || operation.status === 'unknown') && operation.result)
      return operation.result as unknown as AnalysisRecord
    return this.#markUnknown(request, requestDigest, 'The analysis outcome is unknown')
  }
}
