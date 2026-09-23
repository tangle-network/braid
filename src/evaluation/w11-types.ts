import type { Scenario } from '@tangle-network/agent-eval/campaign'
import type { calibrateJudge } from '@tangle-network/agent-eval'
import type { CalibrationPair } from './w11-cases.js'

export interface W11JudgeObservation {
  readonly input: {
    readonly candidate: string
    readonly reference: string
    readonly scenario: Scenario
  }
  readonly output: string
  readonly score: number
  readonly notes: string
  readonly costUsd: number | null
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly total: number
  } | null
  readonly disagreement: number | null
}

export interface W11Judge {
  readonly source: 'live' | 'unit-fixture'
  readonly name: string
  readonly version: string
  judge(input: {
    readonly candidate: string
    readonly reference: string
    readonly scenario: Scenario
    readonly signal?: AbortSignal
  }): Promise<W11JudgeObservation>
}

export interface W11EvaluationInput {
  readonly caseId: string
  readonly fixtureId: string
  readonly dimension: string
  readonly candidate: string
  readonly analysisId?: string
  readonly operationId?: string
  readonly sourceId?: string
  readonly sourceDigest?: string
  readonly sourceRevision?: string
  readonly conversationId?: string
  readonly branchId?: string
  readonly runId?: string
  readonly runtime?: string
  readonly profileDigest?: string
  readonly model?: string
  readonly receiptId?: string
}

export type W11CalibrationRole = 'good' | 'bad' | 'trivial'
export type W11EvaluationRole = 'candidate' | 'seeded-bad' | 'trivial'

export interface W11CalibrationObservation {
  readonly pairId: string
  readonly category: CalibrationPair['category']
  readonly role: W11CalibrationRole
  readonly observation: W11JudgeObservation
}

export interface W11EvaluationObservation {
  readonly caseId: string
  readonly fixtureId: string
  readonly dimension: string
  readonly role: W11EvaluationRole
  readonly observation: W11JudgeObservation
}

export interface W11CalibrationResult {
  readonly metrics: ReturnType<typeof calibrateJudge>
  readonly observations: readonly W11CalibrationObservation[]
  readonly goodMean: number
  readonly badMean: number
  readonly trivialMean: number
  readonly goodWins: number
  readonly requiredGoodWins: 11
  readonly trivialWins: number
  readonly requiredTrivialWins: 12
  readonly trivialRejectedCategories: readonly CalibrationPair['category'][]
}

export interface W11Verdict {
  readonly status: 'passed' | 'failed'
  readonly passedCases: number
  readonly requiredCases: number
  readonly candidateMean: number
  readonly seededBadMean: number
  readonly trivialMean: number
  readonly failedFixtureIds: readonly string[]
}

export interface W11EvaluationResult {
  readonly provenance: {
    readonly source: W11Judge['source']
    readonly judgeName: string
    readonly judgeVersion: string
    readonly fixtureCount: number
    readonly observationCount: number
    readonly calibrationCount: number
  }
  readonly calibration: W11CalibrationResult
  readonly observations: readonly W11EvaluationObservation[]
  readonly verdict: W11Verdict
}

export function w11Scenario(id: string, kind: string, seedGroup: string): Scenario {
  return { id, kind, seedGroup }
}
