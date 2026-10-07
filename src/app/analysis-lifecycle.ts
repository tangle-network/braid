import type { AnalysisRecord } from '../domain/entities.js'
import type { ExactAnalystRunEvent } from '@tangle-network/agent-eval'
import type { RetainedRunAdmissionRecord } from '../domain/run-contracts.js'
import {
  type AnalysisIdentity,
  type AnalysisOperationReservation,
  operationResult,
  reconcileAnalysisState,
  reserveAnalysisOperation,
  updateAnalysisOperation,
} from './analysis-operation.js'
import { commitAnalysisEvent } from './analysis-persistence.js'
import { recordAnalysisRetainedAdmission } from './analysis-retained-admission.js'
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

  async running(record: AnalysisRecord, analystIds: readonly string[]): Promise<AnalysisRecord> {
    const running: AnalysisRecord = {
      ...record,
      status: 'running',
      analysts: analystIds.map((analystId) => ({ analystId, status: 'pending' })),
      updatedAt: this.#host.now(),
    }
    await commitAnalysisEvent(this.#host, { kind: 'analysis.updated', analysis: running })
    return running
  }

  async progress(record: AnalysisRecord, event: ExactAnalystRunEvent): Promise<AnalysisRecord> {
    const analysts = analystProgress(record, event)
    if (sameAnalystProgress(record.analysts ?? [], analysts)) return record
    const next: AnalysisRecord = {
      ...record,
      analysts,
      updatedAt: this.#host.now(),
    }
    await commitAnalysisEvent(this.#host, { kind: 'analysis.updated', analysis: next })
    return next
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

function analystProgress(
  record: AnalysisRecord,
  event: ExactAnalystRunEvent,
): NonNullable<AnalysisRecord['analysts']> {
  if (event.type === 'run-started') {
    return event.analyst_ids.map((analystId) => ({ analystId, status: 'pending' }))
  }
  if (event.type === 'run-completed') {
    return event.result.per_analyst.map((summary) =>
      progressFromSummary(
        summary,
        record.analysts?.find((candidate) => candidate.analystId === summary.analyst_id),
      ),
    )
  }
  const analystId = event.type === 'analyst-started' ? event.analyst_id : event.summary.analyst_id
  const current = record.analysts ?? []
  const update =
    event.type === 'analyst-started'
      ? { analystId, status: 'running' as const, startedAt: event.started_at }
      : progressFromSummary(
          event.summary,
          current.find((candidate) => candidate.analystId === analystId),
        )
  const found = current.some((candidate) => candidate.analystId === analystId)
  return found
    ? current.map((candidate) => (candidate.analystId === analystId ? update : candidate))
    : [...current, update]
}

function progressFromSummary(
  summary: Extract<ExactAnalystRunEvent, { type: 'analyst-completed' }>['summary'],
  previous?: NonNullable<AnalysisRecord['analysts']>[number],
): NonNullable<AnalysisRecord['analysts']>[number] {
  return {
    analystId: summary.analyst_id,
    status:
      summary.status === 'ok' ? 'completed' : summary.status === 'skipped' ? 'skipped' : 'failed',
    findingsCount: summary.findings_count,
    latencyMs: summary.latency_ms,
    ...(previous?.startedAt === undefined ? {} : { startedAt: previous.startedAt }),
    ...(summary.reason === undefined
      ? summary.error === undefined
        ? {}
        : { detail: summary.error.message }
      : { detail: summary.reason }),
  }
}

function sameAnalystProgress(
  left: readonly NonNullable<AnalysisRecord['analysts']>[number][],
  right: readonly NonNullable<AnalysisRecord['analysts']>[number][],
): boolean {
  if (left.length !== right.length) return false
  return left.every((analyst, index) => {
    const candidate = right[index]
    return (
      candidate !== undefined &&
      analyst.analystId === candidate.analystId &&
      analyst.status === candidate.status &&
      analyst.startedAt === candidate.startedAt &&
      analyst.findingsCount === candidate.findingsCount &&
      analyst.latencyMs === candidate.latencyMs &&
      analyst.detail === candidate.detail
    )
  })
}
