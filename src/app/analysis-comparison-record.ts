import type { PairedArmRow, PairedArmsComparison } from '@tangle-network/agent-eval'
import type { AnalysisRecord } from '../domain/entities.js'
import type { AnalysisComparisonResult } from './analysis-comparison-contracts.js'

/** Restores a saved comparison without loading the statistical comparison engine. */
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
