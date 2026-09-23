import type {
  AnalysisForkPort,
  AnalysisPromotionPort,
  AnalysisRecord,
  AnalysisRepository,
  AnalysisSourcePort,
} from './model.js'
import { AnalysisServiceError } from './model.js'
import { operationConflict, operationDigest, reserveInput } from './operations.js'
import { toJsonValue } from './serialization.js'
import { assertCurrentSourceDigest, assertSourceReplay } from './source-freeze.js'

export class AnalysisPromotionCoordinator {
  constructor(
    private readonly source: AnalysisSourcePort,
    private readonly repository: AnalysisRepository,
    private readonly promotion: AnalysisPromotionPort | undefined,
    private readonly fork: AnalysisForkPort | undefined,
    private readonly now: () => string,
  ) {}

  async promote(
    analysisId: string,
    operationId: string,
    findingIds?: readonly string[],
  ): Promise<AnalysisRecord> {
    const record = await this.repository.get(analysisId)
    if (!record) throw new Error(`Analysis not found: ${analysisId}`)
    if (record.status !== 'complete' || !record.citations?.valid)
      throw new Error('Only a complete, cited analysis can be promoted')
    const selected = selectFindings(record, findingIds, 'Promotion')
    const replayHandle = await this.source.freeze(record.sourceId)
    if (replayHandle.source.digest !== record.sourceDigest)
      throw new AnalysisServiceError(
        'SOURCE_CHANGED',
        'The source changed before promotion (digest mismatch)',
      )
    await assertSourceReplay(this.source, replayHandle)
    await assertCurrentSourceDigest(this.source, record.sourceId, record.sourceDigest, 'promotion')
    if (!this.promotion) throw new Error('Promotion integration is unavailable')
    const request = {
      analysisId,
      sourceId: record.sourceId,
      sourceDigest: record.sourceDigest,
      findingIds: selected,
    }
    const digest = operationDigest('promotion', analysisId, request)
    const reservation = await this.repository.reserve(
      reserveInput(
        operationId,
        'promotion',
        analysisId,
        { kind: 'promotion', targetId: analysisId, request },
        this.now(),
      ),
    )
    if (reservation.record.requestDigest !== digest) operationConflict(reservation.record, digest)
    if (!reservation.created) {
      if (reservation.record.status === 'terminal' && reservation.record.result)
        return reservation.record.result as unknown as AnalysisRecord
      if (reservation.record.status !== 'pending')
        throw new AnalysisServiceError(
          'OPERATION_UNKNOWN',
          'Promotion outcome is unknown and was not repeated',
        )
      await this.repository.markUnknown(operationId, digest, this.now())
      throw new AnalysisServiceError(
        'OPERATION_UNKNOWN',
        'Promotion was pending after a restart and was not repeated',
      )
    }
    await assertCurrentSourceDigest(this.source, record.sourceId, record.sourceDigest, 'promotion')
    await this.promotion.attach({ operationId, ...request })
    const promoted = { ...record, promotedFindingIds: selected }
    await this.repository.save(promoted)
    await this.repository.complete(operationId, digest, toJsonValue(promoted), this.now())
    return promoted
  }

  async forkFromAnalysis(
    analysisId: string,
    operationId: string,
    findingIds?: readonly string[],
  ): Promise<{ readonly branchId: string }> {
    const record = await this.repository.get(analysisId)
    if (record?.status !== 'complete' || !record.citations?.valid)
      throw new Error('Only a complete, cited analysis can fork')
    const selected = selectFindings(record, findingIds, 'Fork')
    const replayHandle = await this.source.freeze(record.sourceId)
    if (replayHandle.source.digest !== record.sourceDigest)
      throw new AnalysisServiceError(
        'SOURCE_CHANGED',
        'The source changed before forking (digest mismatch)',
      )
    await assertSourceReplay(this.source, replayHandle)
    await assertCurrentSourceDigest(this.source, record.sourceId, record.sourceDigest, 'forking')
    if (!this.fork) throw new Error('Fork integration is unavailable')
    const request = {
      analysisId,
      sourceId: record.sourceId,
      sourceDigest: record.sourceDigest,
      findingIds: selected,
    }
    const digest = operationDigest('fork', analysisId, request)
    const reservation = await this.repository.reserve(
      reserveInput(
        operationId,
        'fork',
        analysisId,
        { kind: 'fork', targetId: analysisId, request },
        this.now(),
      ),
    )
    if (reservation.record.requestDigest !== digest) operationConflict(reservation.record, digest)
    if (!reservation.created) {
      if (reservation.record.status === 'terminal' && reservation.record.result)
        return reservation.record.result as { readonly branchId: string }
      await this.repository.markUnknown(operationId, digest, this.now())
      throw new AnalysisServiceError(
        'OPERATION_UNKNOWN',
        'Fork was pending after a restart and was not repeated',
      )
    }
    await assertCurrentSourceDigest(this.source, record.sourceId, record.sourceDigest, 'forking')
    const result = await this.fork.forkFromAnalysis({ operationId, ...request })
    await this.repository.complete(operationId, digest, toJsonValue(result), this.now())
    return result
  }
}

function selectFindings(
  record: AnalysisRecord,
  findingIds: readonly string[] | undefined,
  action: string,
): readonly string[] {
  const selected = findingIds ?? record.findings.map((finding) => finding.finding_id)
  if (new Set(selected).size !== selected.length)
    throw new Error(`${action} lists the same finding twice`)
  if (selected.some((id) => !record.findings.some((finding) => finding.finding_id === id)))
    throw new Error(`${action} references an unknown finding`)
  return selected
}
