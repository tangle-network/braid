import type { AnalysisRecord } from '../domain/entities.js'
import {
  type AnalysisIdentity,
  type AnalysisOperationReservation,
  operationResult,
  reconcileAnalysisState,
  reserveAnalysisOperation,
  updateAnalysisOperation,
} from './analysis-operation.js'
import { commitAnalysisEvent } from './analysis-persistence.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

export class AnalysisComparisonLifecycle {
  readonly #host: AnalysisApplicationHost

  constructor(host: AnalysisApplicationHost) {
    this.#host = host
  }

  async reconcile(): Promise<void> {
    for (const record of this.#host.currentState().analyses) {
      if (
        record.kind !== 'comparison' ||
        record.comparison === undefined ||
        (record.status !== 'preparing' && record.status !== 'running')
      ) {
        continue
      }
      await this.complete({ ...record, status: 'completed', updatedAt: this.#host.now() })
    }
    await reconcileAnalysisState(this.#host)
  }

  existing(identity: AnalysisIdentity): AnalysisRecord | undefined {
    const record = this.#host
      .currentState()
      .analyses.find((analysis) => analysis.id === identity.analysisId)
    if (record === undefined) return undefined
    if (record.requestDigest !== undefined && record.requestDigest !== identity.requestDigest) {
      throw new Error(`Comparison ${String(record.id)} has a conflicting request digest`)
    }
    return record
  }

  async reserve(identity: AnalysisIdentity): Promise<AnalysisOperationReservation> {
    return reserveAnalysisOperation(this.#host, {
      identity,
      kind: 'analysis',
      target: identity.analysisId,
    })
  }

  async create(record: AnalysisRecord): Promise<void> {
    await commitAnalysisEvent(this.#host, { kind: 'analysis.created', analysis: record })
  }

  async complete(record: AnalysisRecord): Promise<void> {
    await commitAnalysisEvent(this.#host, { kind: 'analysis.completed', analysis: record })
  }

  async finish(record: AnalysisRecord): Promise<void> {
    const operation = this.#host
      .currentState()
      .operations.find((candidate) => candidate.id === record.operationId)
    if (operation === undefined || operation.status === 'terminal') return
    await updateAnalysisOperation(this.#host, operation, {
      status: 'terminal',
      terminalOutcome: 'completed',
      result: operationResult({
        analysisId: String(record.id),
        sourceDigest: String(record.source.digest),
        status: record.status,
      }),
    })
  }
}
