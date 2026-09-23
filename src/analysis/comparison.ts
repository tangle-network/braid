import {
  comparePairedArms,
  type PairedArmRow,
  type PairedArmsComparison,
  pairRunRecords,
  type RunRecord,
  validateRunRecord,
} from '@tangle-network/agent-eval'

import type { AnalysisSourcePort, FrozenAnalysisSource } from './source.js'

export type ComparisonRunRecord = RunRecord

export function validateComparisonRunRecord(value: unknown): RunRecord {
  return validateRunRecord(value)
}

export interface ComparisonArmBinding {
  readonly experimentId: string
  readonly arm: 'baseline' | 'treatment'
  readonly sourceDigest: string
  readonly sourceRunId: string
  readonly profileDigest: string
  readonly model: string
  readonly receiptId: string
}

export interface PairedComparison {
  readonly baselineSource?: FrozenAnalysisSource
  readonly treatmentSource?: FrozenAnalysisSource
  readonly baselineRuns: readonly RunRecord[]
  readonly treatmentRuns: readonly RunRecord[]
  readonly pairs: ReturnType<typeof pairRunRecords>['pairs']
  readonly unpairedBaseline: readonly RunRecord[]
  readonly unpairedTreatment: readonly RunRecord[]
  readonly rows: readonly PairedArmRow[]
  readonly statistics: PairedArmsComparison
  readonly unknownMetrics: Readonly<Record<string, readonly string[]>>
  readonly asymmetries: Readonly<Record<string, number | string | null>>
}

function row(record: RunRecord, arm: string): PairedArmRow {
  const pass = record.outcome.raw.pass
  const metrics: Record<string, number> = {
    wall_ms: record.wallMs,
    input_tokens: record.tokenUsage.input,
    output_tokens: record.tokenUsage.output,
  }
  if (record.costUsd !== null) metrics.cost_usd = record.costUsd
  for (const [key, value] of Object.entries(record.outcome.raw)) metrics[key] = value
  return {
    pairKey: `${record.experimentId}:${record.scenarioId}:${record.seed}`,
    repKey: record.runId,
    arm,
    ...(typeof pass === 'number' ? { pass: pass === 1 } : {}),
    metrics,
  }
}

function metricNames(records: readonly RunRecord[]): string[] {
  const names = [
    ...new Set(records.flatMap((record) => Object.keys(row(record, 'arm').metrics ?? {}))),
  ]
  if (records.some((record) => record.costProvenance?.kind === 'uncaptured')) names.push('cost_usd')
  return [...new Set(names)].sort()
}

function assertSourceRows(
  source: FrozenAnalysisSource,
  records: readonly RunRecord[],
  arm: 'baseline' | 'treatment',
  binding?: ComparisonArmBinding,
): void {
  if (!binding) throw new Error(`Comparison ${arm} source requires an exact arm binding`)
  if (source.experimentId !== binding.experimentId)
    throw new Error(`Comparison ${arm} source is outside experiment ${binding.experimentId}`)
  if (source.arm !== binding.arm) throw new Error(`Comparison ${arm} source arm is not bound`)
  if (source.receiptId !== binding.receiptId)
    throw new Error(`Comparison ${arm} source receipt is not bound`)
  if (source.digest !== binding.sourceDigest)
    throw new Error(`Comparison ${arm} source digest is not bound`)
  if (source.profileDigest !== binding.profileDigest)
    throw new Error(`Comparison ${arm} source profile is not bound`)
  if (source.model !== binding.model) throw new Error(`Comparison ${arm} source model is not bound`)
  if (source.runId !== binding.sourceRunId)
    throw new Error(`Comparison ${arm} source run is not bound`)
  for (const record of records) {
    if (record.experimentId !== binding.experimentId)
      throw new Error(`Comparison row ${record.runId} is outside experiment ${source.sourceId}`)
    if (binding.arm !== arm) throw new Error(`Comparison row arm is not ${arm}`)
    if (record.candidateId !== binding.arm)
      throw new Error(`Comparison row ${record.runId} is outside arm ${binding.arm}`)
    if (binding.sourceRunId !== record.runId)
      throw new Error(`Comparison row ${record.runId} is outside its frozen source run`)
    if (record.model !== binding.model)
      throw new Error(`Comparison row ${record.runId} has a foreign model`)
  }
}

export function comparePairedRunRecords(
  baselineRuns: readonly RunRecord[],
  treatmentRuns: readonly RunRecord[],
): PairedComparison {
  const paired = pairRunRecords(baselineRuns, treatmentRuns)
  const rows = [
    ...baselineRuns.map((record) => row(record, 'baseline')),
    ...treatmentRuns.map((record) => row(record, 'treatment')),
  ]
  const statistics = comparePairedArms(rows, {
    baselineArm: 'baseline',
    treatmentArm: 'treatment',
    metricNames: metricNames([...baselineRuns, ...treatmentRuns]),
    bootstrap: { seed: 11, resamples: 2000 },
  })
  const unknownMetrics = {
    cost_usd: [
      ...new Set(
        [...baselineRuns, ...treatmentRuns]
          .filter(
            (record) => record.costProvenance?.kind === 'uncaptured' || record.costUsd === null,
          )
          .map((record) => record.runId),
      ),
    ],
  }
  return {
    baselineRuns,
    treatmentRuns,
    pairs: paired.pairs,
    unpairedBaseline: paired.unpairedBaseline,
    unpairedTreatment: paired.unpairedTreatment,
    rows,
    statistics,
    unknownMetrics,
    asymmetries: {
      baseline_count: baselineRuns.length,
      treatment_count: treatmentRuns.length,
      paired_count: paired.pairs.length,
      unpaired_baseline_count: paired.unpairedBaseline.length,
      unpaired_treatment_count: paired.unpairedTreatment.length,
      cost_unknown_count: unknownMetrics.cost_usd.length,
    },
  }
}

export async function comparePairedSources(input: {
  readonly source: AnalysisSourcePort
  readonly baselineSourceId: string
  readonly treatmentSourceId: string
  readonly baselineRuns: readonly RunRecord[]
  readonly treatmentRuns: readonly RunRecord[]
  readonly baselineBinding?: ComparisonArmBinding
  readonly treatmentBinding?: ComparisonArmBinding
}): Promise<PairedComparison> {
  const baselineHandle = await input.source.freeze(input.baselineSourceId)
  const treatmentHandle = await input.source.freeze(input.treatmentSourceId)
  const baselineSource = baselineHandle.source
  const treatmentSource = treatmentHandle.source
  assertSourceRows(baselineSource, input.baselineRuns, 'baseline', input.baselineBinding)
  assertSourceRows(treatmentSource, input.treatmentRuns, 'treatment', input.treatmentBinding)
  const comparison = comparePairedRunRecords(input.baselineRuns, input.treatmentRuns)
  const baselineCurrent = await input.source.verify(baselineHandle)
  const treatmentCurrent = await input.source.verify(treatmentHandle)
  if (!baselineCurrent.unchanged || !treatmentCurrent.unchanged)
    throw new Error('A comparison source changed before the paired result was complete')
  return {
    ...comparison,
    baselineSource,
    treatmentSource,
    asymmetries: {
      ...comparison.asymmetries,
      baseline_source_digest: baselineSource.digest,
      treatment_source_digest: treatmentSource.digest,
      baseline_profile_digest: baselineSource.profileDigest,
      treatment_profile_digest: treatmentSource.profileDigest,
      baseline_model: baselineSource.model,
      treatment_model: treatmentSource.model,
      baseline_runner: baselineSource.runner,
      treatment_runner: treatmentSource.runner,
      baseline_connection: baselineSource.connection,
      treatment_connection: treatmentSource.connection,
    },
  }
}
