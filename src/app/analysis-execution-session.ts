import type { ExactAnalystRunEvent, ExactAnalystRunResult } from '@tangle-network/agent-eval'
import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'
import type { AnalystDescriptor, EvalAnalystRequest } from '../adapters/analysis/eval-analyst.js'
import type { AnalysisIdentity } from './analysis-operation.js'
import type { AnalysisRequest, FrozenAnalysisEvidence } from './analysis-types.js'

export interface AnalysisExecutionEvent {
  readonly event: ExactAnalystRunEvent
  readonly result?: ExactAnalystRunResult
}

export interface AnalysisAnalyst {
  list(): ReadonlyArray<AnalystDescriptor>
  resolveAnalystIds(request: AnalysisRequest): readonly string[]
  stream(request: EvalAnalystRequest): AsyncGenerator<AnalysisExecutionEvent, void, void>
  modelExecutions?(runId: string): readonly ExternalOptimizerModelExecutionObservation[]
}

export class AnalysisExecutionSession {
  readonly #analyst: AnalysisAnalyst
  readonly #active = new Map<string, AbortController>()
  readonly #cancelled = new Set<string>()

  constructor(analyst: AnalysisAnalyst) {
    this.#analyst = analyst
  }

  listAnalysts() {
    return this.#analyst.list()
  }

  resolveAnalystIds(request: AnalysisRequest): readonly string[] {
    return this.#analyst.resolveAnalystIds(request)
  }

  modelExecutions(runId: string): readonly ExternalOptimizerModelExecutionObservation[] {
    return this.#analyst.modelExecutions?.(runId) ?? []
  }

  cancel(analysisId: string, reason = 'cancelled by user'): boolean {
    const controller = this.#active.get(analysisId)
    if (controller === undefined) return false
    this.#cancelled.add(analysisId)
    controller.abort(reason)
    return true
  }

  wasCancelled(analysisId: string): boolean {
    const cancelled = this.#cancelled.delete(analysisId)
    return cancelled
  }

  async *stream(input: {
    readonly identity: AnalysisIdentity
    readonly evidence: FrozenAnalysisEvidence
    readonly request: AnalysisRequest
    readonly analystIds: readonly string[]
  }): AsyncGenerator<AnalysisExecutionEvent, void, void> {
    const controller = new AbortController()
    this.#active.set(String(input.identity.analysisId), controller)
    const { buildAnalysisTraceStore } = await import('../adapters/analysis/trace-store.js')
    const trace = buildAnalysisTraceStore(input.evidence)
    const request: EvalAnalystRequest = {
      runId: String(input.identity.analysisRunId),
      sourceDigest: String(input.evidence.source.digest),
      trace,
      analystIds: input.analystIds,
      ...(input.request.question === undefined ? {} : { question: input.request.question }),
      ...(input.request.recipe === undefined ? {} : { recipe: input.request.recipe }),
      ...(input.request.budgetUsd === undefined ? {} : { budgetUsd: input.request.budgetUsd }),
      ...(input.request.totalTimeoutMs === undefined
        ? {}
        : { totalTimeoutMs: input.request.totalTimeoutMs }),
      signal: controller.signal,
    }
    try {
      for await (const item of this.#analyst.stream(request)) yield item
    } finally {
      this.#active.delete(String(input.identity.analysisId))
    }
  }
}
