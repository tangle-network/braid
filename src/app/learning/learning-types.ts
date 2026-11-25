import type { AgentProfile } from '@tangle-network/agent-interface'

/**
 * A held-out task: one finished Braid run the user marked with a check.
 * The prompt and check stay in the user's local learning store.
 */
export interface LearningTask {
  readonly id: string
  readonly runId: string
  readonly recordedAt: string
  readonly prompt: string
  /** Run in the replay directory after the agent finishes; exit 0 passes. */
  readonly check: { readonly argv: readonly string[]; readonly timeoutMs: number }
  /** Worst-family success is computed over these groups. */
  readonly family: string
  /** Where a replay starts: the repository at the commit the run started from, or an empty directory. */
  readonly workspace:
    | { readonly kind: 'git'; readonly root: string; readonly commit: string }
    | { readonly kind: 'empty' }
}

export type LearningCandidateKind = 'skill' | 'workflow' | 'instructions' | 'removal'

export interface LearningCandidate {
  readonly id: string
  readonly kind: LearningCandidateKind
  readonly name: string
  readonly summary: string
  /** Why it was proposed, as counts from the sources. */
  readonly evidence: readonly string[]
  /** The text the candidate adds, or for a removal, the text it removes. */
  readonly unitText: string
  /** The procedure version: sha256 of the unit's body, as the procedure registry keys it. */
  readonly unitDigest: string
  readonly profile: AgentProfile
  readonly profileDigest: string
  readonly loadedTokens: number
}

export interface LearningHarnessSource {
  readonly harness: string
  readonly sessions: number
  readonly skillInvocations: number
  readonly unreadable: number
}

export interface LearningSourceSummary {
  readonly sinceDays: number
  readonly braid: {
    readonly runs: number
    readonly feedback: number
    readonly lessons: number
    readonly tasks: number
  }
  readonly harnesses: readonly LearningHarnessSource[]
}

export interface LearningProposal {
  readonly id: string
  readonly createdAt: string
  readonly baseProfileDigest: string
  readonly baseLoadedTokens: number
  readonly sources: LearningSourceSummary
  readonly candidates: readonly LearningCandidate[]
  /** Kinds the sources supported no candidate for, with the reason. */
  readonly skipped: readonly string[]
}

export interface FamilyPass {
  readonly family: string
  readonly passed: number
  readonly known: number
  readonly rate: number | null
}

export interface ArmSummary {
  readonly profileDigest: string
  readonly loadedTokens: number
  readonly passed: number
  readonly known: number
  readonly errored: number
  readonly worstFamily: FamilyPass | null
  readonly families: readonly FamilyPass[]
  readonly costUsd: number | null
}

export interface CandidateMeasurement {
  readonly candidateId: string
  readonly kind: LearningCandidateKind
  readonly name: string
  readonly decision: 'keep' | 'cut' | 'inconclusive'
  readonly reason: string
  readonly headroom: string
  readonly wins: number
  readonly losses: number
  readonly ties: number
  readonly notJudged: number
  readonly base: ArmSummary
  readonly candidate: ArmSummary
  readonly gate: { readonly promotable: boolean; readonly rule: string; readonly reason: string }
  readonly failures: readonly string[]
}

export interface LearningMeasurement {
  readonly id: string
  readonly proposalId: string
  readonly createdAt: string
  readonly procedureDigest: string
  readonly tasks: number
  readonly families: readonly string[]
  readonly searchId: string
  readonly ledgerPath: string
  readonly results: readonly CandidateMeasurement[]
  /** The candidate the ledger selected, or null when the base profile stays. */
  readonly selected: string | null
}

export interface LearningVersion {
  readonly version: string
  readonly action: 'promote' | 'rollback'
  readonly at: string
  readonly profileDigest: string
  readonly parentDigest: string
  readonly profilePath: string
  readonly candidateId: string | null
  readonly measurementId: string | null
  readonly override: boolean
  readonly reason: string
}

/** A Braid run served by a learned version, read from its profile snapshot. */
export interface ServedRun {
  readonly runId: string
  readonly version: string
  readonly profileDigest: string
  readonly runner: string | null
  readonly status: string
}

export interface LearningStatus {
  readonly directory: string
  readonly tasks: readonly LearningTask[]
  readonly proposal: LearningProposal | null
  readonly measurement: LearningMeasurement | null
  readonly versions: readonly LearningVersion[]
  readonly active: LearningVersion | null
  readonly served: ServedRun | null
}

export interface LearningConfiguration {
  /** The user's local learning store. */
  readonly directory: string
  /** Claude Code's transcript root, usually `~/.claude/projects`. */
  readonly claudeCodeProjects?: string
  /** Sessions older than this are not read. Default 30. */
  readonly sinceDays?: number
  /** Per-replay agent deadline. Default 15 minutes. */
  readonly replayTimeoutMs?: number
}
