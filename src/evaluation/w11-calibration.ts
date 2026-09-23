import { calibrateJudge } from '@tangle-network/agent-eval'
import { W11_CALIBRATION_PAIRS, type CalibrationPair } from './w11-cases.js'
import {
  type W11CalibrationObservation,
  type W11CalibrationResult,
  type W11CalibrationRole,
  type W11Judge,
  w11Scenario,
} from './w11-types.js'

async function judgeCalibrationPair(
  judge: W11Judge,
  pair: CalibrationPair,
  signal?: AbortSignal,
): Promise<W11CalibrationObservation[]> {
  const candidates = [
    { label: pair.good.label, text: pair.good.text },
    { label: pair.bad.label, text: pair.bad.text },
    { label: pair.trivial.label, text: pair.trivial.text },
  ] as const
  return Promise.all(
    candidates.map(async (candidate) => ({
      pairId: pair.id,
      category: pair.category,
      role: candidate.label,
      observation: await judge.judge({
        candidate: candidate.text,
        reference: pair.good.text,
        scenario: w11Scenario(
          `calibration:${pair.id}:${candidate.label}`,
          'w11-calibration',
          pair.category,
        ),
        ...(signal ? { signal } : {}),
      }),
    })),
  )
}

export async function calibrateW11Judge(
  judge: W11Judge,
  signal?: AbortSignal,
): Promise<W11CalibrationResult> {
  const observations = (
    await Promise.all(
      W11_CALIBRATION_PAIRS.map((pair) => judgeCalibrationPair(judge, pair, signal)),
    )
  ).flat()
  const golden = W11_CALIBRATION_PAIRS.flatMap((pair) => [
    { itemId: `${pair.id}:good`, humanScore: 1 },
    { itemId: `${pair.id}:bad`, humanScore: 0 },
    { itemId: `${pair.id}:trivial`, humanScore: 0 },
  ])
  const candidate = observations.map((item) => ({
    itemId: `${item.pairId}:${item.role}`,
    score: item.observation.score,
  }))
  const metrics = calibrateJudge(golden, candidate)
  const byLabel = (label: W11CalibrationRole): number[] =>
    observations.filter((item) => item.role === label).map((item) => item.observation.score)
  const mean = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length
  const goodMean = mean(byLabel('good'))
  const badMean = mean(byLabel('bad'))
  const trivialMean = mean(byLabel('trivial'))
  const scoreFor = (pairId: string, role: W11CalibrationRole): number => {
    const item = observations.find(
      (observation) => observation.pairId === pairId && observation.role === role,
    )
    if (!item) throw new Error(`W11 calibration observation is missing: ${pairId}:${role}`)
    return item.observation.score
  }
  const goodWins = W11_CALIBRATION_PAIRS.filter(
    (pair) => scoreFor(pair.id, 'good') > scoreFor(pair.id, 'bad'),
  ).length
  const trivialWins = W11_CALIBRATION_PAIRS.filter(
    (pair) => scoreFor(pair.id, 'good') > scoreFor(pair.id, 'trivial'),
  ).length
  const categories = [...new Set(W11_CALIBRATION_PAIRS.map((pair) => pair.category))]
  const trivialRejectedCategories = categories.filter((category) =>
    W11_CALIBRATION_PAIRS.filter((pair) => pair.category === category).every(
      (pair) => scoreFor(pair.id, 'good') > scoreFor(pair.id, 'trivial'),
    ),
  )
  if (
    goodWins < 11 ||
    trivialWins !== W11_CALIBRATION_PAIRS.length ||
    trivialRejectedCategories.length !== categories.length
  )
    throw new Error(
      `W11 judge calibration failed: good wins ${goodWins}/12 (required 11), trivial wins ${trivialWins}/12 (required 12), categories ${trivialRejectedCategories.length}/${categories.length}`,
    )
  return {
    metrics,
    observations,
    goodMean,
    badMean,
    trivialMean,
    goodWins,
    requiredGoodWins: 11,
    trivialWins,
    requiredTrivialWins: 12,
    trivialRejectedCategories,
  }
}
