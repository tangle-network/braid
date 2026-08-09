import type { CostLedger } from '@tangle-network/agent-eval'
import {
  type CampaignResult,
  type ChatClient,
  runCampaign,
} from '@tangle-network/agent-eval/contract'
import { semanticJudge } from './calibration.js'
import { artifactForScenario, scenariosForRelease } from './cases.js'
import type { PilotInspection } from './records.js'
import { cellCostEvidence, cellCostReceipts, cellEvidence, evalSha256 } from './records.js'
import type {
  RecordedJudgeCall,
  SemanticCaseEvidence,
  SemanticEvalArtifact,
  SemanticEvalCase,
  SemanticEvalScenario,
} from './types.js'

export interface CampaignExecution {
  readonly scenarios: readonly SemanticEvalScenario[]
  readonly productFailures: readonly { readonly fixtureId: string; readonly reason: string }[]
  readonly campaign: CampaignResult<SemanticEvalArtifact, SemanticEvalScenario> | null
  readonly ledger: CostLedger
}

function productFailures(scenarios: readonly SemanticEvalScenario[]) {
  return scenarios.flatMap((scenario) => {
    const product = scenario.productPath
    return product?.available === false
      ? [
          {
            fixtureId: scenario.fixtureId,
            reason: product.missingReason ?? 'product presenter unavailable',
          },
        ]
      : []
  })
}

function validProductScenarios(scenarios: readonly SemanticEvalScenario[]): boolean {
  return (
    productFailures(scenarios).length === 0 &&
    scenarios.every((scenario) => scenario.productPath?.available === true)
  )
}

function campaignOptions(
  definition: SemanticEvalCase,
  chat: ChatClient,
  ledger: CostLedger,
  scenarios: readonly SemanticEvalScenario[],
  runDir: string,
  dispatchRef: string,
  costPhase: string,
  costTags: Record<string, string>,
  abortOnCellError: boolean,
) {
  return {
    scenarios: [...scenarios],
    dispatch: async (scenario: SemanticEvalScenario) => artifactForScenario(scenario),
    dispatchRef,
    judges: [semanticJudge(definition, chat)],
    seed: 42,
    reps: 1,
    resumable: false,
    costLedger: ledger,
    costPhase,
    costTags,
    maxConcurrency: 1,
    abortOnCellError,
    dispatchTimeoutMs: 120_000,
    runDir,
    tracing: 'on' as const,
    // The product presenter is deterministic. Paid work happens only in the judge,
    // whose receipt is independently required and recorded by agent-eval.
    expectUsage: 'off' as const,
  }
}

export async function runPilotCampaign(input: {
  readonly definition: SemanticEvalCase
  readonly chat: ChatClient
  readonly ledger: CostLedger
  readonly runDir: string
}): Promise<CampaignExecution> {
  const scenarios = scenariosForRelease(input.definition).slice(0, 1)
  const failures = productFailures(scenarios)
  if (!validProductScenarios(scenarios)) {
    return { scenarios, productFailures: failures, campaign: null, ledger: input.ledger }
  }
  const campaign = await runCampaign(
    campaignOptions(
      input.definition,
      input.chat,
      input.ledger,
      scenarios,
      input.runDir,
      'braid-semantic-pilot-v2-EVAL-01',
      'semantic-pilot-EVAL-01',
      { braidEvalCase: 'EVAL-01', phase: 'pilot' },
      true,
    ),
  )
  return { scenarios, productFailures: failures, campaign, ledger: input.ledger }
}

export async function runReleaseCampaign(input: {
  readonly definition: SemanticEvalCase
  readonly chat: ChatClient
  readonly ledger: CostLedger
  readonly runDir: string
}): Promise<CampaignExecution> {
  const scenarios = scenariosForRelease(input.definition)
  const failures = productFailures(scenarios)
  if (!validProductScenarios(scenarios)) {
    return { scenarios, productFailures: failures, campaign: null, ledger: input.ledger }
  }
  const campaign = await runCampaign(
    campaignOptions(
      input.definition,
      input.chat,
      input.ledger,
      scenarios,
      input.runDir,
      `braid-semantic-release-v2-${input.definition.id}`,
      `semantic-release-${input.definition.id}`,
      { braidEvalCase: input.definition.id, phase: 'release' },
      true,
    ),
  )
  return { scenarios, productFailures: failures, campaign, ledger: input.ledger }
}

function scoreIsParseable(score: unknown): boolean {
  if (score === null || typeof score !== 'object') return false
  const value = score as {
    readonly composite?: unknown
    readonly dimensions?: unknown
    readonly failed?: unknown
  }
  if (
    value.failed === true ||
    typeof value.composite !== 'number' ||
    !Number.isFinite(value.composite)
  )
    return false
  if (value.dimensions === null || typeof value.dimensions !== 'object') return false
  return Object.values(value.dimensions as Record<string, unknown>).every(
    (dimension) => typeof dimension === 'number' && Number.isFinite(dimension),
  )
}

export function inspectPilot(
  execution: CampaignExecution,
  rawCalls: readonly RecordedJudgeCall[],
  threshold: number,
): PilotInspection {
  const failures: string[] = []
  const cell = execution.campaign?.cells.length === 1 ? execution.campaign.cells[0] : undefined
  const scenario = execution.scenarios[0]
  const productAvailable =
    scenario?.productPath?.available === true && execution.productFailures.length === 0
  const scores = cell === undefined ? [] : Object.values(cell.judgeScores)
  const parseableJudgeScore = scores.length === 1 && scores.every(scoreIsParseable)
  const rawJudgeCallCaptured =
    cell !== undefined &&
    (cell.costCallIds ?? []).some((callId) =>
      rawCalls.some(
        (call) => call.callId === callId && call.response !== null && call.error === null,
      ),
    )
  const judgeReceipts =
    cell === undefined
      ? []
      : cellCostReceipts(cell, execution.ledger).filter((receipt) => receipt.channel === 'judge')
  const usageCaptured =
    judgeReceipts.length > 0 &&
    judgeReceipts.every(
      (receipt) =>
        receipt.usageUnknown !== true &&
        Number.isFinite(receipt.inputTokens) &&
        receipt.inputTokens >= 0 &&
        Number.isFinite(receipt.outputTokens) &&
        receipt.outputTokens >= 0 &&
        (receipt.reasoningTokens === undefined ||
          (Number.isFinite(receipt.reasoningTokens) && receipt.reasoningTokens >= 0)),
    ) &&
    judgeReceipts.some((receipt) => receipt.inputTokens + receipt.outputTokens > 0)
  const costCaptured =
    judgeReceipts.length > 0 &&
    judgeReceipts.every(
      (receipt) =>
        Number.isFinite(receipt.costUsd) && receipt.costUsd >= 0 && receipt.costUnknown === false,
    )
  const costEvidence =
    cell === undefined ? null : cellCostEvidence(cell, rawCalls, execution.ledger)
  const wallTimeCaptured =
    costEvidence !== null && Number.isFinite(costEvidence.wallTimeMs) && costEvidence.wallTimeMs > 0
  if (!productAvailable)
    failures.push(
      ...execution.productFailures.map((failure) => `${failure.fixtureId}: ${failure.reason}`),
    )
  if (execution.campaign === null)
    failures.push('pilot produced no campaign because the product path was unavailable')
  if (cell === undefined) failures.push('pilot did not produce exactly one campaign cell')
  if (!parseableJudgeScore) failures.push('pilot did not produce one parseable judge score')
  if (!rawJudgeCallCaptured) failures.push('pilot did not capture the successful raw judge call')
  if (!usageCaptured) failures.push('pilot did not capture input/output token usage')
  if (!costCaptured) failures.push('pilot did not capture cost provenance, including zero')
  if (!wallTimeCaptured) failures.push('pilot did not capture positive wall time')
  if (cell?.error !== undefined) failures.push(`pilot cell failed: ${cell.error}`)
  const composite = scores[0]?.composite
  if (typeof composite !== 'number' || composite < threshold)
    failures.push(`pilot score is below ${threshold.toFixed(2)}`)
  return {
    passed: failures.length === 0,
    productAvailable,
    parseableJudgeScore,
    rawJudgeCallCaptured,
    usageCaptured,
    costCaptured,
    wallTimeCaptured,
    failures,
  }
}

export function caseEvidence(
  definition: SemanticEvalCase,
  execution: CampaignExecution,
  rawCalls: readonly RecordedJudgeCall[],
): SemanticCaseEvidence {
  const artifacts = execution.scenarios.map(artifactForScenario)
  const cells =
    execution.campaign === null
      ? []
      : execution.campaign.cells.map((cell) =>
          cellEvidence(cell, rawCalls, definition.criteria.passThreshold, execution.ledger),
        )
  const disagreements = [
    ...execution.productFailures.map((failure) => `${failure.fixtureId}: ${failure.reason}`),
    ...cells.flatMap((cell) =>
      cell.pass
        ? []
        : [`${cell.scenarioId} scored below ${definition.criteria.passThreshold.toFixed(2)}`],
    ),
  ]
  return {
    id: definition.id,
    category: 'eval',
    command: 'pnpm test:eval',
    question: definition.question,
    referenceCriteria: definition.criteria,
    fixtureCount: execution.scenarios.length,
    passedFixtures: cells.filter((cell) => cell.pass).length,
    failedFixtures: execution.scenarios.length - cells.filter((cell) => cell.pass).length,
    artifacts,
    productFailures: execution.productFailures,
    result:
      execution.campaign !== null &&
      execution.productFailures.length === 0 &&
      cells.length === execution.scenarios.length &&
      cells.every((cell) => cell.pass)
        ? 'passed'
        : 'failed',
    campaign: execution.campaign,
    cells,
    disagreements,
  }
}

export function unavailableCaseEvidence(
  definition: SemanticEvalCase,
  reason: string,
): SemanticCaseEvidence {
  const scenarios = scenariosForRelease(definition)
  return {
    id: definition.id,
    category: 'eval',
    command: 'pnpm test:eval',
    question: definition.question,
    referenceCriteria: definition.criteria,
    fixtureCount: scenarios.length,
    passedFixtures: 0,
    failedFixtures: scenarios.length,
    artifacts: scenarios.map(artifactForScenario),
    productFailures: scenarios.map((scenario) => ({ fixtureId: scenario.fixtureId, reason })),
    result: 'unavailable',
    campaign: null,
    cells: [],
    disagreements: [reason],
  }
}

export function assertHeldOutInputs(definitions: readonly SemanticEvalCase[]): void {
  const calibrationDigests = new Set(
    definitions.flatMap((definition) =>
      definition.calibrationFixtures.map((fixture) => evalSha256(fixture.semanticOutput)),
    ),
  )
  const collisions = definitions.flatMap((definition) =>
    definition.releaseFixtures.flatMap((fixture) => {
      const hash = evalSha256(fixture.semanticOutput)
      return calibrationDigests.has(hash)
        ? [`${definition.id}/${fixture.id} collides with calibration input ${hash}`]
        : []
    }),
  )
  if (collisions.length > 0) throw new Error(`Held-out fixture collision: ${collisions.join('; ')}`)
}
