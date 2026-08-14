import type { ExactAnalystRunResult } from '@tangle-network/agent-eval'
import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'
import type { AnalysisRecord } from '../domain/entities.js'
import type { AnalysisId } from '../domain/ids.js'
import { type AnalysisAnalyst, AnalysisExecutionSession } from './analysis-execution-session.js'
import { AnalysisGraphProjector } from './analysis-graph-projector.js'
import { AnalysisLifecycle } from './analysis-lifecycle.js'
import { analysisModelCallRecords } from './analysis-model-call-records.js'
import { AnalysisOperationError } from './analysis-operation.js'
import { prepareAnalysisRequest } from './analysis-request.js'
import { completedAnalysisRecord, initialAnalysisRecord } from './analysis-result-mapper.js'
import type {
  AnalysisApplicationHost,
  AnalysisProgress,
  AnalysisRequest,
  FrozenAnalysisEvidence,
} from './analysis-types.js'
import { AnalysisPersistenceError } from './analysis-types.js'
import { UnavailableAnalyst } from './unavailable-analyst.js'

export interface AnalysisExecutionResult {
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly analysis: AnalysisRecord
  readonly evidence: FrozenAnalysisEvidence
  readonly result?: ExactAnalystRunResult
  readonly error?: Error
  readonly replayed?: boolean
}

function assertSuccessfulAnalysts(result: ExactAnalystRunResult): void {
  if (result.completion.status === 'failed') throw new Error(result.completion.error.message)
  const failed = result.per_analyst.find((summary) => summary.status === 'failed')
  if (failed === undefined) return
  const reason = failed.error?.message ?? 'The analyst failed without an error message.'
  throw new Error(`Trace analyst '${failed.analyst_id}' failed: ${reason}`)
}

export class AnalysisService {
  readonly #host: AnalysisApplicationHost
  readonly #lifecycle: AnalysisLifecycle
  readonly #execution: AnalysisExecutionSession
  readonly #graph: AnalysisGraphProjector
  readonly #active = new Set<string>()
  #reconciled = false

  constructor(host: AnalysisApplicationHost, analyst: AnalysisAnalyst = new UnavailableAnalyst()) {
    this.#host = host
    this.#lifecycle = new AnalysisLifecycle(host)
    this.#execution = new AnalysisExecutionSession(analyst)
    this.#graph = new AnalysisGraphProjector(host)
  }

  listAnalysts() {
    return this.#execution.listAnalysts()
  }

  async reconcile(): Promise<void> {
    await this.#lifecycle.reconcile(this.#active)
    this.#reconciled = true
  }

  cancel(analysisId: AnalysisId, reason = 'cancelled by user'): boolean {
    return this.#execution.cancel(String(analysisId), reason)
  }

  async *stream(request: AnalysisRequest): AsyncGenerator<AnalysisProgress, void, void> {
    if (!this.#reconciled) await this.reconcile()
    const prepared = await prepareAnalysisRequest(this.#host, request)
    const existing = this.#lifecycle.existing(prepared.identity)
    if (existing !== undefined) {
      if (existing.status === 'preparing' || existing.status === 'running') {
        throw new Error(`Analysis ${String(existing.id)} is already active`)
      }
      yield { type: 'started', analysis: existing, replayed: true }
      await this.#graph.project(existing)
      await this.#lifecycle.repairTerminal(existing)
      yield this.#lifecycle.replay(existing, prepared.evidence)
      return
    }

    const record = initialAnalysisRecord({
      host: this.#host,
      evidence: prepared.evidence,
      request,
      identity: prepared.identity,
      executionTarget: prepared.executionTarget,
      at: this.#host.now(),
    })
    this.#active.add(String(record.id))
    let current = record
    let resultCommitted = false
    let modelExecutions: readonly ExternalOptimizerModelExecutionObservation[] = []
    try {
      const operation = await this.#lifecycle.reserve(prepared.identity)
      if (!operation.created) {
        const replay = this.#lifecycle.existing(prepared.identity)
        if (replay !== undefined && replay.status !== 'preparing' && replay.status !== 'running') {
          yield { type: 'started', analysis: replay, replayed: true }
          yield this.#lifecycle.replay(replay, prepared.evidence)
          return
        }
        throw new Error(
          `Analysis operation ${String(operation.operation.id)} is already active or unavailable`,
        )
      }
      await this.#lifecycle.create(current)
      yield { type: 'started', analysis: current }
      current = await this.#lifecycle.running(current)
      yield { type: 'running', analysis: current }

      const analystIds = this.#execution.resolveAnalystIds(request)
      let exactResult: ExactAnalystRunResult | undefined
      for await (const item of this.#execution.stream({
        identity: prepared.identity,
        evidence: prepared.evidence,
        request,
        analystIds,
        executionTarget: prepared.executionTarget,
        onRetainedAdmission: (callId, admission) =>
          this.#lifecycle.recordRetainedAdmission(prepared.identity, callId, admission),
      })) {
        if (item.result !== undefined) exactResult = item.result
        yield {
          type: 'analyst',
          analysisId: prepared.identity.analysisId,
          analysisRunId: prepared.identity.analysisRunId,
          event: item.event,
        }
      }
      if (exactResult === undefined)
        throw new Error('agent-eval exact stream ended without a result')
      assertSuccessfulAnalysts(exactResult)
      modelExecutions = this.#execution.modelExecutions(String(prepared.identity.analysisRunId))
      current = await completedAnalysisRecord({
        host: this.#host,
        base: current,
        evidence: prepared.evidence,
        request,
        identity: prepared.identity,
        executionTarget: prepared.executionTarget,
        analystIds,
        descriptors: this.#execution.listAnalysts(),
        modelExecutions,
        result: exactResult,
        at: this.#host.now(),
      })
      await this.#lifecycle.completed(current)
      resultCommitted = true
      await this.#graph.project(current)
      await this.#lifecycle.finish(current)
      yield {
        type: 'completed',
        analysis: current,
        evidence: prepared.evidence,
        result: exactResult,
      }
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value))
      if (resultCommitted) throw error
      if (error instanceof AnalysisPersistenceError || error instanceof AnalysisOperationError) {
        throw error
      }
      modelExecutions = this.#execution.modelExecutions(String(prepared.identity.analysisRunId))
      current = { ...current, modelCalls: analysisModelCallRecords(modelExecutions) }
      const cancelled = this.#execution.wasCancelled(String(current.id))
      const failed = await this.#lifecycle.failed(current, error, cancelled)
      if (cancelled) {
        yield {
          type: 'cancelled',
          analysis: failed,
          evidence: prepared.evidence,
          reason: error.message,
        }
      } else {
        yield {
          type: 'failed',
          analysis: failed,
          evidence: prepared.evidence,
          error,
        }
      }
    } finally {
      this.#active.delete(String(record.id))
    }
  }

  async run(request: AnalysisRequest): Promise<AnalysisExecutionResult> {
    let terminal: AnalysisProgress | undefined
    for await (const progress of this.stream(request)) terminal = progress
    if (terminal === undefined) throw new Error('analysis stream produced no terminal result')
    if (terminal.type === 'completed') {
      return {
        status: 'completed',
        analysis: terminal.analysis,
        evidence: terminal.evidence,
        ...(terminal.result === undefined
          ? {}
          : { result: terminal.result as ExactAnalystRunResult }),
        ...(terminal.replayed === undefined ? {} : { replayed: terminal.replayed }),
      }
    }
    if (terminal.type === 'failed') {
      return {
        status: 'failed',
        analysis: terminal.analysis,
        evidence: terminal.evidence,
        error: terminal.error,
        ...(terminal.result === undefined
          ? {}
          : { result: terminal.result as ExactAnalystRunResult }),
        ...(terminal.replayed === undefined ? {} : { replayed: terminal.replayed }),
      }
    }
    if (terminal.type === 'cancelled') {
      return {
        status: 'cancelled',
        analysis: terminal.analysis,
        evidence: terminal.evidence,
        ...(terminal.replayed === undefined ? {} : { replayed: terminal.replayed }),
      }
    }
    throw new Error(`analysis stream ended before a terminal result (${terminal.type})`)
  }
}
