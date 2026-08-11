import type { AnalysisRecord } from '../domain/entities.js'
import type {
  AnalysisComparisonResult,
  CompareAnalysisInput,
} from './analysis-comparison-contracts.js'
import {
  comparisonChecks,
  comparisonSnapshot,
  sourceRange,
} from './analysis-comparison-evidence.js'
import { AnalysisComparisonGraph } from './analysis-comparison-graph.js'
import { AnalysisComparisonLifecycle } from './analysis-comparison-lifecycle.js'
import {
  persistedComparisonRequest,
  prepareComparisonRequest,
} from './analysis-comparison-request.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

export class AnalysisComparisonService {
  readonly #host: AnalysisApplicationHost
  readonly #lifecycle: AnalysisComparisonLifecycle
  readonly #graph: AnalysisComparisonGraph
  #reconciled = false

  constructor(host: AnalysisApplicationHost) {
    this.#host = host
    this.#lifecycle = new AnalysisComparisonLifecycle(host)
    this.#graph = new AnalysisComparisonGraph(host)
  }

  async compare(input: CompareAnalysisInput): Promise<AnalysisComparisonResult> {
    const prepared = await prepareComparisonRequest(this.#host, input)
    const { compareFrozenRuns } = await import('./analysis-comparison-facts.js')
    return compareFrozenRuns({
      baseline: prepared.baseline,
      candidate: prepared.candidate,
      ...(input.metricNames === undefined ? {} : { metricNames: input.metricNames }),
      ...(input.bootstrapSeed === undefined ? {} : { bootstrapSeed: input.bootstrapSeed }),
    })
  }

  async compareAndStore(input: CompareAnalysisInput): Promise<AnalysisComparisonResult> {
    const { resultFromComparisonRecord } = await import('./analysis-comparison-record.js')
    if (!this.#reconciled) {
      await this.#lifecycle.reconcile()
      this.#reconciled = true
    }
    const prepared = await prepareComparisonRequest(this.#host, input)
    const existing = this.#lifecycle.existing(prepared.identity)
    if (existing !== undefined) {
      if (existing.status !== 'completed') {
        throw new Error(`Comparison ${String(existing.id)} is ${existing.status}`)
      }
      await this.#graph.project(existing)
      await this.#lifecycle.finish(existing)
      return resultFromComparisonRecord(existing)
    }
    const { compareFrozenRuns } = await import('./analysis-comparison-facts.js')
    const result = compareFrozenRuns({
      baseline: prepared.baseline,
      candidate: prepared.candidate,
      ...(input.metricNames === undefined ? {} : { metricNames: input.metricNames }),
      ...(input.bootstrapSeed === undefined ? {} : { bootstrapSeed: input.bootstrapSeed }),
    })
    const checks = comparisonChecks(prepared.baseline, prepared.candidate)
    const record: AnalysisRecord = {
      id: prepared.identity.analysisId,
      analysisRunId: prepared.identity.analysisRunId,
      kind: 'comparison',
      operationId: prepared.identity.operationId,
      requestDigest: prepared.identity.requestDigest,
      request: persistedComparisonRequest(input),
      source: prepared.baseline.source,
      sourceRange: sourceRange(prepared.baseline),
      status: 'preparing',
      findings: [],
      checks,
      provenance: {
        operationId: prepared.identity.operationId,
        requestDigest: prepared.identity.requestDigest,
        analystIds: [],
        analystVersions: [],
        tools: [],
        completeness:
          prepared.baseline.source.complete && prepared.candidate.source.complete
            ? 'complete'
            : 'incomplete',
        checks,
      },
      comparison: comparisonSnapshot(prepared.baseline, prepared.candidate, result),
      createdAt: this.#host.now(),
      updatedAt: this.#host.now(),
    }
    const operation = await this.#lifecycle.reserve(prepared.identity)
    if (!operation.created) {
      const replay = this.#lifecycle.existing(prepared.identity)
      if (replay?.status === 'completed') return resultFromComparisonRecord(replay)
      throw new Error(
        `Comparison operation ${String(operation.operation.id)} is already active or unavailable`,
      )
    }
    await this.#lifecycle.create(record)
    const complete: AnalysisRecord = {
      ...record,
      status: 'completed',
      updatedAt: this.#host.now(),
    }
    await this.#lifecycle.complete(complete)
    await this.#graph.project(complete)
    await this.#lifecycle.finish(complete)
    return result
  }
}

export type {
  AnalysisComparisonRequest,
  AnalysisComparisonResult,
  CompareAnalysisInput,
} from './analysis-comparison-contracts.js'
