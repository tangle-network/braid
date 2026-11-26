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
  /** What the sessions behind a skill or workflow came to; null for a candidate no session suggested. */
  readonly changes: ChangeOutcomeCounts | null
}

/**
 * What recorded sessions came to, one count per session. A session's changes
 * are its own and those of the sessions that spawned it, as Eval's procedure
 * registry joins them. `unknown` is never counted as `none`.
 */
export interface ChangeOutcomeCounts {
  /** The change ledger or the transcript names at least one commit or pull request. */
  readonly changed: number
  /** The ledger's writer observed the session, and it recorded no change. */
  readonly none: number
  /** Never observed, a change the ledger could not place, or a turn its writer marked incomplete. */
  readonly unknown: number
}

export interface LearningHarnessSource {
  readonly harness: string
  readonly sessions: number
  readonly skillInvocations: number
  readonly unreadable: number
  readonly changes: ChangeOutcomeCounts
}

/** The change ledger the proposal joined to the sessions. */
export interface LearningChangeLedgerSource {
  readonly rows: number
  /** Lines that are not rows of the ledger format; Eval counts them and reads nothing from them. */
  readonly malformed: number
  /** Sessions read from the harnesses that the ledger holds rows for. */
  readonly joinedSessions: number
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
  /** null when no change ledger file exists. */
  readonly changeLedger: LearningChangeLedgerSource | null
}

/** The learner a proposal or measurement ran under: its version, or null for Braid's default. */
export interface LearnerRef {
  readonly version: string | null
  readonly digest: string
}

export interface LearningProposal {
  readonly id: string
  readonly createdAt: string
  readonly learner: LearnerRef
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
  readonly learner: LearnerRef
  /** The learner's digest: the procedure revision the ledger names. */
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
  /** The profile this entry replaced, so a rollback can restore it. */
  readonly parentPath: string
  readonly candidateId: string | null
  readonly measurementId: string | null
  /** The learner whose measurement chose this profile version; absent on learner versions. */
  readonly learner?: LearnerRef
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

/** What the learner proposes and how it measures, carried in the learner profile's `extensions.braid.learning`. */
export interface LearnerSettings {
  /** What it reads. Recorded with the procedure; the sources themselves decide what is present. */
  readonly sources: readonly string[]
  /** How a session's changes are counted for a candidate's evidence. */
  readonly changes: string
  readonly candidates: {
    readonly kinds: readonly LearningCandidateKind[]
    /** Skill candidates mounted from the most-invoked pinnable skills. */
    readonly maxSkills: number
    /** Removal candidates, one per carried skill. */
    readonly maxRemovals: number
    /** Skill rows read from the sessions before pinning. */
    readonly rowsTried: number
    /** Sessions that must run two skills in the same order before they become a workflow. */
    readonly workflowMinSessions: number
  }
  readonly measure: string
  readonly gate: string
  readonly seed: number
  readonly concurrency: number
}

/** One learner in a learner round: what it proposed, what it picked, and how the pick did on tasks it never saw. */
export interface LearnerArm {
  /** `active`, or the variant's name. */
  readonly name: string
  readonly summary: string
  readonly learnerDigest: string
  readonly settings: LearnerSettings
  readonly candidates: number
  readonly skipped: readonly string[]
  readonly pick: {
    readonly candidateId: string | null
    readonly kind: LearningCandidateKind | null
    readonly name: string
    readonly profileDigest: string
    readonly loadedTokens: number
  }
  /** The pick on the tasks the learner chose it on. */
  readonly selection: ArmSummary
  /** The pick on the held-out tasks. */
  readonly heldOut: ArmSummary
  readonly gate: { readonly promotable: boolean; readonly rule: string; readonly reason: string }
}

export interface LearnerMeasurement {
  readonly id: string
  readonly createdAt: string
  readonly active: LearnerRef
  readonly seed: number
  /** Each learner picks a candidate on these. */
  readonly selectionTasks: readonly string[]
  /** Each pick is judged on these. */
  readonly heldOutTasks: readonly string[]
  readonly families: readonly string[]
  readonly arms: readonly LearnerArm[]
  /** The variant the round selected, or null when the active learner stays. */
  readonly selected: string | null
  readonly searchId: string
  readonly ledgerPath: string
}

export interface LearnerStatus {
  readonly active: LearnerRef
  readonly settings: LearnerSettings
  readonly measurement: LearnerMeasurement | null
  readonly versions: readonly LearningVersion[]
}

export interface LearningStatus {
  readonly directory: string
  readonly tasks: readonly LearningTask[]
  readonly proposal: LearningProposal | null
  readonly measurement: LearningMeasurement | null
  readonly versions: readonly LearningVersion[]
  readonly active: LearningVersion | null
  readonly served: ServedRun | null
  readonly learner: LearnerStatus
}

export interface LearningConfiguration {
  /** The user's local learning store. */
  readonly directory: string
  /** Claude Code's transcript root, usually `~/.claude/projects`. */
  readonly claudeCodeProjects?: string
  /** Codex's rollout root, usually `~/.codex/sessions`. */
  readonly codexSessions?: string
  /** The change ledger the harness hooks and CLI Bridge append to, usually `~/.local/state/change-ledger/changes.jsonl`. */
  readonly changeLedger?: string
  /** Sessions older than this are not read. Default 30. */
  readonly sinceDays?: number
  /** Per-replay agent deadline. Default 15 minutes. */
  readonly replayTimeoutMs?: number
}
