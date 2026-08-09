import type { SemanticEvalRecord } from './records.js'

export interface SemanticEvalMeasurement {
  readonly kind: 'scalar'
  readonly name: string
  readonly unit: string
  readonly value: number
}

function scalar(name: string, unit: string, value: number): SemanticEvalMeasurement {
  if (!Number.isFinite(value))
    throw new Error(`Semantic evaluation measurement ${name} is not finite`)
  return { kind: 'scalar', name, unit, value }
}

function receiptNumber(receipt: unknown, key: string): number {
  if (receipt === null || typeof receipt !== 'object') return 0
  const value = (receipt as Readonly<Record<string, unknown>>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Complete scalar summary consumed by the signed outer release collector. */
export function semanticEvalMeasurements(
  record: SemanticEvalRecord,
): readonly SemanticEvalMeasurement[] {
  if (record.status !== 'passed' || !record.releaseAdmissible) {
    throw new Error('Only an admissible passed semantic evaluation can emit release measurements')
  }
  const fixtures = record.cases.flatMap((evidence) => evidence.cells)
  const successfulCalls = record.rawJudgeCalls.filter(
    (call) => call.response !== null && call.error === null,
  )
  const reasoningReceipts = record.receipts.filter(
    (receipt) => receiptNumber(receipt, 'reasoningTokens') > 0,
  )
  const measurements: SemanticEvalMeasurement[] = [
    scalar(
      'semantic-cases-passed',
      'count',
      record.cases.filter((entry) => entry.result === 'passed').length,
    ),
    scalar('semantic-fixtures-passed', 'count', fixtures.filter((entry) => entry.pass).length),
    scalar('semantic-fixtures-total', 'count', fixtures.length),
    scalar('calibration-pairs', 'count', record.calibration.pairedExamples),
    scalar('calibration-good-preferred', 'count', record.calibration.goodPreferred),
    scalar('calibration-ties', 'count', record.calibration.ties),
    scalar('calibration-reversals', 'count', record.calibration.reversals),
    scalar('calibration-preference-rate', 'ratio', record.calibration.pairPreferenceRate),
    scalar('calibration-good-mean', 'score', record.calibration.strongMean),
    scalar('calibration-bad-mean', 'score', record.calibration.weakMean),
    scalar('calibration-trivial-mean', 'score', record.calibration.trivialMean),
    scalar('calibration-good-bad-margin', 'score', record.calibration.strongWeakMargin),
    scalar('calibration-trivial-good-ratio', 'ratio', record.calibration.trivialStrongRatio),
    scalar('pilot-score', 'score', record.pilot.score ?? 0),
    scalar('judge-calls-total', 'count', record.rawJudgeCalls.length),
    scalar('judge-calls-successful', 'count', successfulCalls.length),
    scalar('cost-receipts', 'count', record.receipts.length),
    scalar(
      'input-tokens',
      'tokens',
      record.receipts.reduce<number>(
        (sum, receipt) => sum + receiptNumber(receipt, 'inputTokens'),
        0,
      ),
    ),
    scalar(
      'output-tokens',
      'tokens',
      record.receipts.reduce<number>(
        (sum, receipt) => sum + receiptNumber(receipt, 'outputTokens'),
        0,
      ),
    ),
    scalar(
      'reasoning-tokens',
      'tokens',
      record.receipts.reduce<number>(
        (sum, receipt) => sum + receiptNumber(receipt, 'reasoningTokens'),
        0,
      ),
    ),
    scalar('reasoning-token-receipts', 'count', reasoningReceipts.length),
    scalar(
      'cached-tokens',
      'tokens',
      record.receipts.reduce<number>(
        (sum, receipt) => sum + receiptNumber(receipt, 'cachedTokens'),
        0,
      ),
    ),
    scalar(
      'evaluation-cost',
      'USD',
      record.receipts.reduce<number>((sum, receipt) => sum + receiptNumber(receipt, 'costUsd'), 0),
    ),
    scalar('evaluation-wall-time', 'ms', record.durationMs),
  ]
  for (const evidence of record.cases) {
    measurements.push(
      scalar(`${evidence.id.toLowerCase()}-fixtures-passed`, 'count', evidence.passedFixtures),
    )
  }
  return measurements
}
