import {
  type ComparePairedArmsOptions,
  comparePairedArms,
  type PairedArmRow,
  type PairedArmsComparison,
} from '@tangle-network/agent-eval'
import { canonicalDigest } from '../domain/canonical.js'
import type { AnalysisRecord } from '../domain/entities.js'
import type {
  AnalysisComparisonRequest,
  AnalysisComparisonResult,
} from './analysis-comparison-contracts.js'
import { capturedFields } from './analysis-comparison-evidence.js'
import type { FrozenAnalysisEvidence } from './analysis-types.js'
import { AnalysisSourceError } from './analysis-types.js'

function finiteMetric(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : value
}

function latencyMs(evidence: FrozenAnalysisEvidence): number | undefined {
  const run = evidence.run
  if (run === undefined) return undefined
  const started = Date.parse(run.startedAt)
  const ended = Date.parse(run.terminalAt ?? run.updatedAt)
  return Number.isFinite(started) && Number.isFinite(ended)
    ? Math.max(0, ended - started)
    : undefined
}

function toolCount(evidence: FrozenAnalysisEvidence): number {
  return evidence.events.filter((event) => event.event.kind === 'run.tool.call').length
}

function row(
  evidence: FrozenAnalysisEvidence,
  arm: 'baseline' | 'candidate',
  pairKey: string,
): PairedArmRow {
  const run = evidence.run
  if (run === undefined || evidence.source.runId === undefined) {
    throw new AnalysisSourceError('Paired comparison requires two frozen run sources')
  }
  const metrics: Record<string, number> = {
    event_count: run.eventCount,
    tool_calls: toolCount(evidence),
  }
  const costUsd = finiteMetric(run.costUsd)
  const latency = latencyMs(evidence)
  const inputTokens = finiteMetric(run.inputTokens)
  const outputTokens = finiteMetric(run.outputTokens)
  const reasoningTokens = finiteMetric(run.reasoningTokens)
  if (costUsd !== undefined) metrics.cost_usd = costUsd
  if (latency !== undefined) metrics.latency_ms = latency
  if (inputTokens !== undefined) metrics.input_tokens = inputTokens
  if (outputTokens !== undefined) metrics.output_tokens = outputTokens
  if (reasoningTokens !== undefined) metrics.reasoning_tokens = reasoningTokens
  return {
    pairKey,
    arm,
    pass: run.status === 'completed' && run.complete,
    metrics,
  }
}

export function compareFrozenRuns(input: AnalysisComparisonRequest): AnalysisComparisonResult {
  const baselineRunId = input.baseline.source.runId
  const candidateRunId = input.candidate.source.runId
  if (baselineRunId === undefined || candidateRunId === undefined) {
    throw new AnalysisSourceError('Paired comparison requires two frozen run sources')
  }
  if (baselineRunId === candidateRunId) {
    throw new AnalysisSourceError('Paired comparison requires two distinct runs')
  }
  const pairKey = canonicalDigest({
    baselineRunId,
    candidateRunId,
    baselineSourceDigest: input.baseline.source.digest,
    candidateSourceDigest: input.candidate.source.digest,
  })
  const rows = [
    row(input.baseline, 'baseline', pairKey),
    row(input.candidate, 'candidate', pairKey),
  ]
  const options: ComparePairedArmsOptions = {
    baselineArm: 'baseline',
    treatmentArm: 'candidate',
    ...(input.metricNames === undefined ? {} : { metricNames: [...input.metricNames] }),
    ...(input.bootstrapSeed === undefined ? {} : { bootstrap: { seed: input.bootstrapSeed } }),
  }
  const paired = comparePairedArms(rows, options)
  return {
    baselineSourceDigest: String(input.baseline.source.digest),
    candidateSourceDigest: String(input.candidate.source.digest),
    baselineRunId: String(baselineRunId),
    candidateRunId: String(candidateRunId),
    fields: capturedFields(input.baseline, input.candidate),
    rows,
    paired,
    semantic: {
      status: 'unavailable',
      reason:
        'The current Braid worker has deterministic paired facts only; a semantic judge must be supplied by agent-eval before any semantic conclusion is shown.',
    },
  }
}

export function comparisonIdentity(result: AnalysisComparisonResult): string {
  return canonicalDigest({
    baselineSourceDigest: result.baselineSourceDigest,
    candidateSourceDigest: result.candidateSourceDigest,
    fields: result.fields,
    rows: result.rows,
    paired: result.paired,
  })
}

export function resultFromComparisonRecord(record: AnalysisRecord): AnalysisComparisonResult {
  if (record.comparison === undefined) {
    throw new Error(`Comparison ${String(record.id)} is incomplete`)
  }
  const comparison = record.comparison
  return {
    baselineSourceDigest: String(comparison.baseline.digest),
    candidateSourceDigest: String(comparison.candidate.digest),
    baselineRunId: String(comparison.baseline.runId),
    candidateRunId: String(comparison.candidate.runId),
    fields: comparison.fields,
    rows: comparison.rows as unknown as readonly PairedArmRow[],
    paired: comparison.paired as unknown as PairedArmsComparison,
    semantic: comparison.semantic,
    replayed: true,
  }
}
