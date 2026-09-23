import {
  AnalysisServiceError,
  type AnalysisCancellationReceipt,
  type AnalysisRepository,
} from './model.js'
import { operationConflict, operationDigest, reserveInput } from './operations.js'
import { toJsonValue } from './serialization.js'

export class AnalysisCancellationCoordinator {
  private readonly cancellations = new Map<string, AbortController>()
  private readonly operations = new Map<string, Map<string, { readonly requestDigest: string }>>()

  constructor(
    private readonly repository: AnalysisRepository,
    private readonly now: () => string,
  ) {}

  register(analysisId: string, controller: AbortController): void {
    this.cancellations.set(analysisId, controller)
  }

  unregister(analysisId: string): void {
    this.cancellations.delete(analysisId)
  }

  async complete(analysisId: string, status: AnalysisCancellationReceipt['status']): Promise<void> {
    const operations = this.operations.get(analysisId)
    if (!operations) return
    for (const [operationId, operation] of operations) {
      await this.repository.complete(
        operationId,
        operation.requestDigest,
        toJsonValue({ operationId, analysisId, status }),
        this.now(),
      )
    }
    this.operations.delete(analysisId)
  }

  async request(
    analysisId: string,
    operationId: string,
    reason = 'Cancelled by user',
  ): Promise<AnalysisCancellationReceipt> {
    const request = { analysisId, reason }
    const digest = operationDigest('cancel', analysisId, request)
    const operations = this.operations.get(analysisId) ?? new Map()
    const active = operations.get(operationId)
    if (active) {
      if (active.requestDigest !== digest)
        throw new AnalysisServiceError(
          'OPERATION_CONFLICT',
          'The cancellation operation ID is already bound to another request',
        )
      return { operationId, analysisId, status: 'pending' }
    }
    operations.set(operationId, { requestDigest: digest })
    this.operations.set(analysisId, operations)
    try {
      const reservation = await this.repository.reserve(
        reserveInput(
          operationId,
          'cancel',
          analysisId,
          { kind: 'cancel', targetId: analysisId, request },
          this.now(),
        ),
      )
      if (reservation.record.requestDigest !== digest) {
        operations.delete(operationId)
        operationConflict(reservation.record, digest)
      }
      if (!reservation.created && reservation.record.status === 'terminal') {
        operations.delete(operationId)
        return (reservation.record.result ?? {
          operationId,
          analysisId,
          status: 'unknown',
        }) as unknown as AnalysisCancellationReceipt
      }
      const controller = this.cancellations.get(analysisId)
      if (!controller) {
        const record = await this.repository.get(analysisId)
        operations.delete(operationId)
        if (record?.status === 'cancelled') {
          const receipt = { operationId, analysisId, status: 'cancelled' as const }
          await this.repository.complete(operationId, digest, toJsonValue(receipt), this.now())
          return receipt
        }
        await this.repository.markUnknown(operationId, digest, this.now())
        return { operationId, analysisId, status: 'unknown' }
      }
      controller.abort(new DOMException(reason, 'AbortError'))
      return { operationId, analysisId, status: 'pending' }
    } catch (error) {
      if (operations.get(operationId)?.requestDigest === digest) operations.delete(operationId)
      throw error
    }
  }
}
