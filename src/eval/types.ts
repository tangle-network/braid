import type {
  CampaignResult,
  ChatClient,
  JudgeDimension,
  JudgeScore,
  Scenario,
} from '@tangle-network/agent-eval/contract'

export type SemanticEvalCaseId =
  | 'EVAL-01'
  | 'EVAL-02'
  | 'EVAL-03'
  | 'EVAL-04'
  | 'EVAL-05'
  | 'EVAL-06'

export const SEMANTIC_EVAL_CASE_IDS: readonly SemanticEvalCaseId[] = [
  'EVAL-01',
  'EVAL-02',
  'EVAL-03',
  'EVAL-04',
  'EVAL-05',
  'EVAL-06',
]

export const SEMANTIC_EVAL_CATEGORIES: Readonly<Record<SemanticEvalCaseId, string>> = {
  'EVAL-01': 'fork-explanation',
  'EVAL-02': 'permission-decision',
  'EVAL-03': 'analysis-usefulness',
  'EVAL-04': 'comparison-honesty',
  'EVAL-05': 'reconnect-status',
  'EVAL-06': 'profile-compatibility',
}

export type CalibrationLabel = 'good' | 'bad' | 'trivial'

export interface ProductOutput {
  /** Text returned by an existing Braid projection, plain formatter, or TUI panel. */
  readonly text: string
  readonly path: 'tui' | 'plain' | 'semantic-projection' | 'unavailable'
  readonly available: boolean
  readonly missingReason: string | null
  readonly sourceDigest: string
}

export interface CalibrationFixture {
  readonly id: string
  /** A value produced by Braid application or view code. */
  readonly semanticOutput: unknown
  readonly goodOutput: string
  readonly badOutput: string
  readonly trivialOutput: string
}

export interface ReleaseFixture {
  readonly id: string
  /** A held-out Braid semantic value, distinct from calibration inputs. */
  readonly semanticOutput: unknown
  /** Produced by the real current Braid presentation path. */
  readonly productOutput: ProductOutput
}

export interface SemanticReferenceCriteria {
  readonly requiredSignals: readonly string[]
  readonly forbiddenSignals: readonly string[]
  readonly passThreshold: number
}

export interface SemanticEvalCase {
  readonly id: SemanticEvalCaseId
  readonly question: string
  readonly category: string
  readonly prompt: string
  readonly dimensions: readonly JudgeDimension[]
  readonly criteria: SemanticReferenceCriteria
  readonly calibrationFixtures: readonly [
    CalibrationFixture,
    CalibrationFixture,
    CalibrationFixture,
  ]
  readonly releaseFixtures: readonly [ReleaseFixture, ReleaseFixture, ReleaseFixture]
}

export interface SemanticEvalScenario extends Scenario {
  readonly caseId: SemanticEvalCaseId
  readonly fixtureId: string
  readonly semanticOutput: unknown
  readonly candidateOutput: string
  readonly candidateLabel?: CalibrationLabel
  readonly productPath?: ProductOutput
}

export interface SemanticEvalArtifact {
  readonly caseId: SemanticEvalCaseId
  readonly fixtureId: string
  readonly semanticOutput: unknown
  readonly candidateOutput: string
  readonly productPath?: ProductOutput
}

export interface RecordedJudgeCall {
  readonly callId: string | null
  readonly request: unknown
  readonly response: unknown | null
  readonly error: {
    readonly name: string
    readonly message: string
  } | null
  readonly startedAt: string
  readonly finishedAt: string
  readonly wallTimeMs: number
}

export interface CalibrationCellRecord {
  readonly scenarioId: string
  readonly pairId: string
  readonly caseId: SemanticEvalCaseId
  readonly fixtureId: string
  readonly semanticOutput: unknown
  readonly label: CalibrationLabel
  readonly output: string
  readonly score: JudgeScore | null
  readonly campaignCell: string | null
}

export type PairPreference = 'good' | 'bad' | 'tie' | 'unscorable'

export interface CalibrationPairOutcome {
  readonly pairId: string
  readonly caseId: SemanticEvalCaseId
  readonly category: string
  readonly fixtureId: string
  readonly goodScore: number | null
  readonly badScore: number | null
  readonly delta: number | null
  readonly preference: PairPreference
  readonly tieTolerance: number
  readonly independentlyScored: boolean
}

export interface CalibrationCategoryOutcome {
  readonly caseId: SemanticEvalCaseId
  readonly category: string
  readonly pairCount: number
  readonly goodPreferred: number
  readonly ties: number
  readonly reversals: number
  readonly trivialComparisons: number
  readonly trivialRejected: boolean
  readonly goodMean: number
  readonly badMean: number
  readonly trivialMean: number
}

export interface CalibrationSummary {
  readonly passed: boolean
  readonly pairedExamples: number
  readonly minimumPairedExamples: number
  readonly goodPreferred: number
  readonly minimumGoodPreferred: number
  readonly ties: number
  readonly reversals: number
  readonly pairPreferenceRate: number
  readonly strongMean: number
  readonly weakMean: number
  readonly trivialMean: number
  readonly strongWeakMargin: number
  readonly trivialStrongRatio: number
  readonly minimumMargin: number
  readonly maximumTrivialRatio: number
  readonly perCategory: readonly CalibrationCategoryOutcome[]
  readonly pairOutcomes: readonly CalibrationPairOutcome[]
  readonly failures: readonly string[]
  readonly cells: readonly CalibrationCellRecord[]
}

export interface SemanticCaseEvidence {
  readonly id: SemanticEvalCaseId
  readonly category: 'eval'
  readonly command: string
  readonly question: string
  readonly referenceCriteria: SemanticReferenceCriteria
  readonly fixtureCount: number
  readonly passedFixtures: number
  readonly failedFixtures: number
  readonly artifacts: readonly SemanticEvalArtifact[]
  readonly productFailures: readonly {
    readonly fixtureId: string
    readonly reason: string
  }[]
  readonly result: 'passed' | 'failed' | 'unavailable'
  readonly campaign: CampaignResult<SemanticEvalArtifact, SemanticEvalScenario> | null
  readonly cells: readonly SemanticCellEvidence[]
  readonly disagreements: readonly string[]
}

export interface SemanticCellEvidence {
  readonly cellId: string
  readonly scenarioId: string
  readonly fixtureId: string
  readonly semanticOutput: unknown
  readonly candidateOutput: string
  readonly productPath: ProductOutput | null
  readonly judgeScores: Record<string, JudgeScore>
  readonly pass: boolean
  readonly rawJudgeCallIds: readonly string[]
  readonly cost: {
    readonly usd: number
    readonly provenance: unknown
    readonly inputTokens: number
    readonly outputTokens: number
    readonly reasoningTokens: number | null
    readonly cachedTokens: number
    readonly wallTimeMs: number
  }
}

export interface EvalProviderIdentity {
  readonly transport: ChatClient['transport']
  readonly baseUrl: string
  readonly model: string
  readonly endpointSha256: string
  readonly bearerPresent: boolean
}
