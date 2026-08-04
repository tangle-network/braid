import type { CostLedger } from '@tangle-network/agent-eval'
import {
  type CampaignResult,
  type ChatClient,
  type JudgeConfig,
  type JudgeScore,
  llmJudge,
  runCampaign,
} from '@tangle-network/agent-eval/contract'
import { artifactForScenario, scenariosForCalibration } from './cases.js'
import type {
  CalibrationCategoryOutcome,
  CalibrationCellRecord,
  CalibrationPairOutcome,
  CalibrationSummary,
  SemanticEvalArtifact,
  SemanticEvalCase,
  SemanticEvalScenario,
} from './types.js'

export const CALIBRATION_MIN_PAIRS = 12
export const CALIBRATION_MIN_GOOD_RATE = 11 / 12
export const CALIBRATION_TIE_TOLERANCE = 0.02
export const CALIBRATION_MIN_MARGIN = 0.2
export const CALIBRATION_MAX_TRIVIAL_RATIO = 0.8

export interface CalibrationCampaign {
  readonly label: 'good' | 'bad' | 'trivial'
  readonly definition: SemanticEvalCase
  readonly result: CampaignResult<SemanticEvalArtifact, SemanticEvalScenario>
}

export interface CalibrationRun {
  readonly summary: CalibrationSummary
  readonly campaigns: readonly CalibrationCampaign[]
  readonly ledger: CostLedger
}

export function semanticJudge(
  definition: SemanticEvalCase,
  chat: ChatClient,
): JudgeConfig<SemanticEvalArtifact, SemanticEvalScenario> {
  const model = chat.defaultModel
  return llmJudge<SemanticEvalArtifact, SemanticEvalScenario>(
    `braid-${definition.id}-semantic-quality`,
    definition.prompt,
    {
      chat,
      ...(model === undefined ? {} : { model }),
      judgeVersion: `braid-semantic-quality-v2-${definition.id}`,
      dimensions: [...definition.dimensions],
      temperature: 0,
      maxTokens: 320,
      renderUser: ({ artifact }) =>
        JSON.stringify(
          {
            semanticOutput: artifact.semanticOutput,
            userFacingAnswer: artifact.candidateOutput,
            candidateLabel: artifact.productPath === undefined ? null : 'release-product-output',
            productPath: artifact.productPath ?? null,
          },
          null,
          2,
        ),
    },
  )
}

type CampaignSet = Record<
  'good' | 'bad' | 'trivial',
  CampaignResult<SemanticEvalArtifact, SemanticEvalScenario>
>

function scoreFor(
  result: CampaignResult<SemanticEvalArtifact, SemanticEvalScenario>,
  scenarioId: string,
  judgeName: string,
): JudgeScore | null {
  const cell = result.cells.find((candidate) => candidate.scenarioId === scenarioId)
  const score = cell?.judgeScores[judgeName]
  return score === undefined || score.failed === true ? null : score
}

function mean(scores: readonly (JudgeScore | null)[]): number {
  const values = scores.flatMap((score) => (score === null ? [] : [score.composite]))
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function cellsFor(definition: SemanticEvalCase, results: CampaignSet): CalibrationCellRecord[] {
  const judgeName = `braid-${definition.id}-semantic-quality`
  return definition.calibrationFixtures.flatMap((fixture, index) => {
    const scenarioId = `${definition.id}-calibration-${index + 1}`
    const pairId = `${definition.id}-pair-${index + 1}`
    return (['good', 'bad', 'trivial'] as const).map((label) => {
      const scenario = scenariosForCalibration(definition, label)[index]
      const campaign = results[label]
      return {
        scenarioId,
        pairId,
        caseId: definition.id,
        fixtureId: fixture.id,
        semanticOutput: fixture.semanticOutput,
        label,
        output: scenario?.candidateOutput ?? '',
        score: scoreFor(campaign, scenarioId, judgeName),
        campaignCell: campaign.cells.find((cell) => cell.scenarioId === scenarioId)?.cellId ?? null,
      }
    })
  })
}

function pairOutcomes(
  definitions: readonly SemanticEvalCase[],
  cells: readonly CalibrationCellRecord[],
): CalibrationPairOutcome[] {
  return definitions.flatMap((definition) =>
    definition.calibrationFixtures.map((fixture, index) => {
      const pairId = `${definition.id}-pair-${index + 1}`
      const pair = cells.filter((cell) => cell.pairId === pairId)
      const good = pair.find((cell) => cell.label === 'good')?.score ?? null
      const bad = pair.find((cell) => cell.label === 'bad')?.score ?? null
      const goodScore = good?.composite ?? null
      const badScore = bad?.composite ?? null
      const delta = goodScore === null || badScore === null ? null : goodScore - badScore
      const preference =
        delta === null
          ? 'unscorable'
          : delta > CALIBRATION_TIE_TOLERANCE
            ? 'good'
            : delta < -CALIBRATION_TIE_TOLERANCE
              ? 'bad'
              : 'tie'
      return {
        pairId,
        caseId: definition.id,
        category: definition.category,
        fixtureId: fixture.id,
        goodScore,
        badScore,
        delta,
        preference,
        tieTolerance: CALIBRATION_TIE_TOLERANCE,
        independentlyScored: goodScore !== null && badScore !== null,
      }
    }),
  )
}

function categoryOutcomes(
  definitions: readonly SemanticEvalCase[],
  cells: readonly CalibrationCellRecord[],
): CalibrationCategoryOutcome[] {
  return definitions.map((definition) => {
    const categoryCells = cells.filter((cell) => cell.caseId === definition.id)
    const good = categoryCells.filter((cell) => cell.label === 'good').map((cell) => cell.score)
    const bad = categoryCells.filter((cell) => cell.label === 'bad').map((cell) => cell.score)
    const trivial = categoryCells
      .filter((cell) => cell.label === 'trivial')
      .map((cell) => cell.score)
    const pairs = pairOutcomes([definition], categoryCells)
    const trivialValues = trivial.flatMap((score) => (score === null ? [] : [score.composite]))
    const goodValues = good.flatMap((score) => (score === null ? [] : [score.composite]))
    const goodMean = mean(good)
    const trivialMean = mean(trivial)
    return {
      caseId: definition.id,
      category: definition.category,
      pairCount: pairs.length,
      goodPreferred: pairs.filter((pair) => pair.preference === 'good').length,
      ties: pairs.filter((pair) => pair.preference === 'tie').length,
      reversals: pairs.filter((pair) => pair.preference === 'bad').length,
      trivialComparisons: trivialValues.length,
      trivialRejected:
        trivialValues.length === definition.calibrationFixtures.length &&
        trivialValues.every((value) => value < definition.criteria.passThreshold) &&
        goodValues.length === definition.calibrationFixtures.length &&
        trivialMean < goodMean,
      goodMean,
      badMean: mean(bad),
      trivialMean,
    }
  })
}

export function summarizeCalibration(
  definitions: readonly SemanticEvalCase[],
  cells: readonly CalibrationCellRecord[],
): CalibrationSummary {
  const pairs = pairOutcomes(definitions, cells)
  const categories = categoryOutcomes(definitions, cells)
  const goodScores = cells.filter((cell) => cell.label === 'good').map((cell) => cell.score)
  const badScores = cells.filter((cell) => cell.label === 'bad').map((cell) => cell.score)
  const trivialScores = cells.filter((cell) => cell.label === 'trivial').map((cell) => cell.score)
  const strongMean = mean(goodScores)
  const weakMean = mean(badScores)
  const trivialMean = mean(trivialScores)
  const strongWeakMargin = strongMean - weakMean
  const trivialStrongRatio = strongMean <= 0 ? 1 : trivialMean / strongMean
  const goodPreferred = pairs.filter((pair) => pair.preference === 'good').length
  const ties = pairs.filter((pair) => pair.preference === 'tie').length
  const reversals = pairs.filter((pair) => pair.preference === 'bad').length
  const minimumGoodPreferred = Math.ceil(pairs.length * CALIBRATION_MIN_GOOD_RATE)
  const failures: string[] = []
  if (pairs.length < CALIBRATION_MIN_PAIRS) {
    failures.push(
      `only ${pairs.length} paired examples; at least ${CALIBRATION_MIN_PAIRS} are required`,
    )
  }
  if (goodPreferred < minimumGoodPreferred) {
    failures.push(
      `good preference ${goodPreferred}/${pairs.length} is below ${minimumGoodPreferred}/${pairs.length}`,
    )
  }
  if (pairs.some((pair) => !pair.independentlyScored)) {
    failures.push('at least one good-versus-bad pair has a missing or failed judge score')
  }
  if (strongWeakMargin < CALIBRATION_MIN_MARGIN) {
    failures.push(
      `supplementary good-versus-bad mean margin ${strongWeakMargin.toFixed(3)} is below ${CALIBRATION_MIN_MARGIN.toFixed(3)}`,
    )
  }
  if (trivialStrongRatio >= CALIBRATION_MAX_TRIVIAL_RATIO) {
    failures.push(
      `supplementary trivial-to-good mean ratio ${trivialStrongRatio.toFixed(3)} is not below ${CALIBRATION_MAX_TRIVIAL_RATIO.toFixed(3)}`,
    )
  }
  for (const category of categories) {
    if (!category.trivialRejected)
      failures.push(`${category.caseId} trivial baseline was not rejected`)
  }
  return {
    passed: failures.length === 0,
    pairedExamples: pairs.length,
    minimumPairedExamples: CALIBRATION_MIN_PAIRS,
    goodPreferred,
    minimumGoodPreferred,
    ties,
    reversals,
    pairPreferenceRate: pairs.length === 0 ? 0 : goodPreferred / pairs.length,
    strongMean,
    weakMean,
    trivialMean,
    strongWeakMargin,
    trivialStrongRatio,
    minimumMargin: CALIBRATION_MIN_MARGIN,
    maximumTrivialRatio: CALIBRATION_MAX_TRIVIAL_RATIO,
    perCategory: categories,
    pairOutcomes: pairs,
    failures,
    cells,
  }
}

async function campaign(
  definition: SemanticEvalCase,
  chat: ChatClient,
  label: 'good' | 'bad' | 'trivial',
  runDir: string,
  ledger: CostLedger,
): Promise<CampaignResult<SemanticEvalArtifact, SemanticEvalScenario>> {
  const scenarios = scenariosForCalibration(definition, label)
  return runCampaign({
    scenarios,
    dispatch: async (scenario) => artifactForScenario(scenario),
    dispatchRef: `braid-semantic-calibration-v2-${definition.id}-${label}`,
    judges: [semanticJudge(definition, chat)],
    seed: 42,
    reps: 1,
    resumable: false,
    costLedger: ledger,
    costPhase: `semantic-calibration-${definition.id}-${label}`,
    costTags: { braidEvalCase: definition.id, calibrationLabel: label },
    maxConcurrency: 1,
    abortOnCellError: false,
    dispatchTimeoutMs: 120_000,
    runDir,
    tracing: 'on',
    // Calibration scores deterministic Braid output; only the judge makes a paid call.
    expectUsage: 'off',
  })
}

export async function runCalibration(input: {
  readonly definitions: readonly SemanticEvalCase[]
  readonly chat: ChatClient
  readonly runDir: string
  readonly ledger: CostLedger
}): Promise<CalibrationRun> {
  const campaigns: CalibrationCampaign[] = []
  const allCells: CalibrationCellRecord[] = []
  for (const definition of input.definitions) {
    const good = await campaign(
      definition,
      input.chat,
      'good',
      `${input.runDir}/${definition.id}/good`,
      input.ledger,
    )
    campaigns.push({ label: 'good', definition, result: good })
    const bad = await campaign(
      definition,
      input.chat,
      'bad',
      `${input.runDir}/${definition.id}/bad`,
      input.ledger,
    )
    campaigns.push({ label: 'bad', definition, result: bad })
    const trivial = await campaign(
      definition,
      input.chat,
      'trivial',
      `${input.runDir}/${definition.id}/trivial`,
      input.ledger,
    )
    campaigns.push({ label: 'trivial', definition, result: trivial })
    allCells.push(...cellsFor(definition, { good, bad, trivial }))
  }
  return {
    summary: summarizeCalibration(input.definitions, allCells),
    campaigns,
    ledger: input.ledger,
  }
}
