import type { AnalysisRecord } from '../domain/entities.js'
import type { RetainedRunAdmissionRecord } from '../domain/run-contracts.js'
import { recordAnalysisRetainedAdmission } from './analysis-retained-admission.js'
import {
  type AnalysisIdentity,
  type AnalysisOperationReservation,
  operationResult,
  reconcileAnalysisState,
  reserveAnalysisOperation,
  updateAnalysisOperation,
} from './analysis-operation.js'
import { commitAnalysisEvent } from './analysis-persistence.js'
import type {
  AnalysisApplicationHost,
  AnalysisProgress,
  FrozenAnalysisEvidence,
} from './analysis-types.js'

export class AnalysisLifecycle {
  readonly #host: AnalysisApplicationHost

  constructor(host: AnalysisApplicationHost) {
    this.#host = host
  }

  async reconcile(activeAnalysisIds: ReadonlySet<string>): Promise<void> {
    await reconcileAnalysisState(this.#host, activeAnalysisIds)
  }

  existing(identity: AnalysisIdentity): AnalysisRecord | undefined {
    const record = this.#host
      .currentState()
      .analyses.find((analysis) => analysis.id === identity.analysisId)
    if (record === undefined) return undefined
    if (record.operationId !== undefined && record.operationId !== identity.operationId) {
      throw new Error(`Analysis ${String(record.id)} has a conflicting operation identity`)
    }
    if (record.requestDigest !== undefined && record.requestDigest !== identity.requestDigest) {
      throw new Error(`Analysis ${String(record.id)} has a conflicting request digest`)
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

  async running(record: AnalysisRecord): Promise<AnalysisRecord> {
    const running: AnalysisRecord = { ...record, status: 'running', updatedAt: this.#host.now() }
    await commitAnalysisEvent(this.#host, { kind: 'analysis.updated', analysis: running })
    return running
  }

  async recordRetainedAdmission(
    identity: AnalysisIdentity,
    callId: string,
    admission: RetainedRunAdmissionRecord,
  ): Promise<void> {
    await recordAnalysisRetainedAdmission(this.#host, identity, callId, admission)
  }

  async completed(record: AnalysisRecord): Promise<void> {
    await commitAnalysisEvent(this.#host, { kind: 'analysis.completed', analysis: record })
  }

  async failed(record: AnalysisRecord, error: Error, cancelled: boolean): Promise<AnalysisRecord> {
    const failed: AnalysisRecord = {
      ...record,
      status: cancelled ? 'cancelled' : 'failed',
      error: error.message,
      updatedAt: this.#host.now(),
    }
    await commitAnalysisEvent(this.#host, { kind: 'analysis.updated', analysis: failed })
    const operation = this.#host
      .currentState()
      .operations.find((candidate) => candidate.id === record.operationId)
    if (operation !== undefined) {
      await updateAnalysisOperation(this.#host, operation, {
        status: 'terminal',
        terminalOutcome: cancelled ? 'cancelled' : 'failed',
        failureCode: cancelled ? 'ANALYSIS_CANCELLED' : 'ANALYSIS_FAILED',
        failureMessage: error.message,
        result: {
          ...(operation.result ?? {}),
          ...operationResult({
            analysisId: String(failed.id),
            sourceDigest: String(failed.source.digest),
            status: failed.status,
          }),
        },
      })
    }
    return failed
  }

  async finish(record: AnalysisRecord): Promise<void> {
    const operation = this.#host
      .currentState()
      .operations.find((candidate) => candidate.id === record.operationId)
    if (operation === undefined || operation.status === 'terminal') return
    await updateAnalysisOperation(this.#host, operation, {
      status: 'terminal',
      terminalOutcome:
        record.status === 'completed'
          ? 'completed'
          : record.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      result: {
        ...(operation.result ?? {}),
        ...operationResult({
          analysisId: String(record.id),
          sourceDigest: String(record.source.digest),
          status: record.status,
        }),
      },
    })
  }

  async repairTerminal(record: AnalysisRecord): Promise<void> {
    await this.finish(record)
  }

  replay(record: AnalysisRecord, evidence: FrozenAnalysisEvidence): AnalysisProgress {
    if (record.status === 'completed') {
      return { type: 'completed', analysis: record, evidence, result: undefined, replayed: true }
    }
    if (record.status === 'cancelled') {
      return { type: 'cancelled', analysis: record, evidence, replayed: true }
    }
    return {
      type: 'failed',
      analysis: record,
      evidence,
      error: new Error(record.error ?? `Analysis ${String(record.id)} is ${record.status}`),
      replayed: true,
    }
  }
}
