import type { ExternalOptimizerModelExecutionObservation } from '@tangle-network/agent-eval/campaign'
import type { AnalysisAnalyst } from '../../app/analysis-execution-session.js'
import type { AnalysisExecutionTarget } from '../../app/analysis-types.js'
import { profileModelSettings } from '../../app/profile-model-settings.js'
import type { ProductionConnectionOptions } from '../connections/production-connections.js'
import type { EvalAnalystRequest, EvalAnalystStreamEvent } from './eval-analyst.js'
import {
  createTraceAnalysisAdapter,
  createTraceAnalysisAnalyst,
  createUnavailableTraceAnalysisAnalyst,
} from './trace-analysis-adapter.js'

const MAX_COMPLETED_RUNS = 256

/** Builds one trace-analysis adapter from the exact route captured for each request. */
export class ProductionAnalysisAnalyst implements AnalysisAnalyst {
  readonly #bootstrap: AnalysisAnalyst
  readonly #create: (
    target: AnalysisExecutionTarget,
    request: Pick<EvalAnalystRequest, 'onRetainedAdmission' | 'signal' | 'totalTimeoutMs'>,
  ) => Promise<AnalysisAnalyst>
  readonly #completed = new Map<string, readonly ExternalOptimizerModelExecutionObservation[]>()

  constructor(input: {
    readonly bootstrap: AnalysisAnalyst
    readonly connectionOptions?: ProductionConnectionOptions
    readonly create?: (
      target: AnalysisExecutionTarget,
      request: Pick<EvalAnalystRequest, 'onRetainedAdmission' | 'signal' | 'totalTimeoutMs'>,
    ) => Promise<AnalysisAnalyst>
  }) {
    this.#bootstrap = input.bootstrap
    const connectionOptions = input.connectionOptions ?? {}
    this.#create =
      input.create ??
      (async (target, request) => {
        if (target.connection === undefined) {
          return createUnavailableTraceAnalysisAnalyst(
            'The captured analysis route has no matching connection record.',
          )
        }
        const modelSettings = profileModelSettings(target.profile)
        return createTraceAnalysisAnalyst(
          await createTraceAnalysisAdapter({
            profile: target.profile,
            connection: target.connection,
            ...(modelSettings.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokens: modelSettings.maxOutputTokens }),
            ...connectionOptions,
            managedRuntimeReadiness: 'complete',
            ...(request.onRetainedAdmission === undefined
              ? {}
              : { onRetainedAdmission: request.onRetainedAdmission }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.totalTimeoutMs === undefined
              ? {}
              : { pythonProbeTimeoutMs: request.totalTimeoutMs }),
          }),
        )
      })
  }

  list() {
    return this.#bootstrap.list()
  }

  resolveAnalystIds(request: Parameters<AnalysisAnalyst['resolveAnalystIds']>[0]) {
    return this.#bootstrap.resolveAnalystIds(request)
  }

  modelExecutions(runId: string): readonly ExternalOptimizerModelExecutionObservation[] {
    const observations = this.#completed.get(runId)
    if (observations === undefined) return []
    this.#completed.delete(runId)
    return observations.map((observation) => structuredClone(observation))
  }

  async *stream(request: EvalAnalystRequest): AsyncGenerator<EvalAnalystStreamEvent, void, void> {
    const target = request.executionTarget
    const analyst =
      target === undefined
        ? createUnavailableTraceAnalysisAnalyst(
            'The analysis request has no captured execution route.',
          )
        : await this.#create(target, {
            ...(request.onRetainedAdmission === undefined
              ? {}
              : { onRetainedAdmission: request.onRetainedAdmission }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.totalTimeoutMs === undefined
              ? {}
              : { totalTimeoutMs: request.totalTimeoutMs }),
          })
    try {
      for await (const item of analyst.stream(request)) yield item
    } finally {
      this.#remember(request.runId, analyst.modelExecutions?.(request.runId) ?? [])
    }
  }

  #remember(
    runId: string,
    observations: readonly ExternalOptimizerModelExecutionObservation[],
  ): void {
    this.#completed.delete(runId)
    this.#completed.set(
      runId,
      Object.freeze(observations.map((observation) => structuredClone(observation))),
    )
    while (this.#completed.size > MAX_COMPLETED_RUNS) {
      const oldest = this.#completed.keys().next().value
      if (oldest === undefined) break
      this.#completed.delete(oldest)
    }
  }
}
