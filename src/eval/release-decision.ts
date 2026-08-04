import type { SemanticEvalRecord } from './records.js'
import type { RecordedJudgeCall, SemanticCaseEvidence } from './types.js'
import { SEMANTIC_EVAL_CASE_IDS } from './types.js'

export interface SemanticReleaseDecisionInput {
  readonly packageReady: boolean
  readonly calibration: SemanticEvalRecord['calibration']
  readonly pilot: SemanticEvalRecord['pilot']
  readonly cases: readonly SemanticCaseEvidence[]
  readonly rawJudgeCalls: readonly RecordedJudgeCall[]
}

export interface SemanticReleaseDecision {
  readonly status: 'passed' | 'failed'
  readonly releaseAdmissible: boolean
  readonly reasons: readonly string[]
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function caseFailures(
  evidence: SemanticCaseEvidence,
  calls: ReadonlyMap<string, RecordedJudgeCall>,
): string[] {
  const failures: string[] = []
  if (evidence.result !== 'passed') failures.push(`${evidence.id} result is ${evidence.result}`)
  if (evidence.fixtureCount < 3) {
    failures.push(
      `${evidence.id} has ${evidence.fixtureCount} release fixtures; at least 3 are required`,
    )
  }
  if (
    evidence.passedFixtures !== evidence.fixtureCount ||
    evidence.failedFixtures !== 0 ||
    evidence.cells.length !== evidence.fixtureCount
  ) {
    failures.push(
      `${evidence.id} passed ${evidence.passedFixtures}/${evidence.fixtureCount} fixtures with ${evidence.cells.length} recorded cells`,
    )
  }
  if (evidence.productFailures.length > 0) {
    failures.push(
      `${evidence.id} has ${evidence.productFailures.length} product presentation failures`,
    )
  }
  if (evidence.campaign === null) failures.push(`${evidence.id} has no campaign record`)
  for (const cell of evidence.cells) {
    if (!cell.pass) failures.push(`${evidence.id}/${cell.fixtureId} did not pass`)
    if (cell.productPath?.available !== true) {
      failures.push(`${evidence.id}/${cell.fixtureId} did not use an available product presenter`)
    }
    if (cell.rawJudgeCallIds.length === 0) {
      failures.push(`${evidence.id}/${cell.fixtureId} has no raw judge call`)
    }
    for (const callId of cell.rawJudgeCallIds) {
      const call = calls.get(callId)
      if (call === undefined || call.response === null || call.error !== null) {
        failures.push(`${evidence.id}/${cell.fixtureId} judge call ${callId} is missing or failed`)
      }
    }
    const cost = cell.cost
    if (
      !finiteNonNegative(cost.usd) ||
      !finiteNonNegative(cost.inputTokens) ||
      !finiteNonNegative(cost.outputTokens) ||
      !finiteNonNegative(cost.cachedTokens) ||
      !finiteNonNegative(cost.wallTimeMs) ||
      cost.wallTimeMs === 0 ||
      cost.provenance === null ||
      cost.provenance === undefined
    ) {
      failures.push(
        `${evidence.id}/${cell.fixtureId} has incomplete usage, cost, or timing evidence`,
      )
    }
  }
  return failures
}

/** Decide semantic release eligibility from complete recorded evidence only. */
export function semanticReleaseDecision(
  input: SemanticReleaseDecisionInput,
): SemanticReleaseDecision {
  const reasons: string[] = []
  if (!input.packageReady) reasons.push('installed package provenance is unavailable')
  if (!input.calibration.passed) reasons.push('judge calibration did not pass')
  if (input.pilot.status !== 'passed' || !input.pilot.inspection.passed) {
    reasons.push('the pre-calibration pilot did not pass')
  }

  const calls = new Map(
    input.rawJudgeCalls.flatMap((call) =>
      call.callId === null ? [] : ([[call.callId, call]] as const),
    ),
  )
  for (const id of SEMANTIC_EVAL_CASE_IDS) {
    const matches = input.cases.filter((evidence) => evidence.id === id)
    if (matches.length !== 1) {
      reasons.push(`${id} occurs ${matches.length} times instead of exactly once`)
      continue
    }
    const evidence = matches[0]
    if (evidence !== undefined) reasons.push(...caseFailures(evidence, calls))
  }

  const releaseAdmissible = reasons.length === 0
  return {
    status: releaseAdmissible ? 'passed' : 'failed',
    releaseAdmissible,
    reasons,
  }
}
