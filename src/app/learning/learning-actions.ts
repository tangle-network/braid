import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { BraidState } from '../../domain/state.js'
import type { BraidApplication } from '../application.js'
import { AppError } from '../errors.js'
import { ProfileActionService } from '../profile-actions.js'
import { createProfileRecord } from '../profile-sources.js'
import { proposeCandidates } from './learning-candidates.js'
import { recordLearningLedger } from './learning-ledger.js'
import { measureCandidates } from './learning-measure.js'
import { loadedTokens, profileDigest, sha256Hex } from './learning-profile.js'
import { braidHistory, readHarnessSessions } from './learning-sources.js'
import { LearningStore } from './learning-store.js'
import type {
  LearningConfiguration,
  LearningMeasurement,
  LearningProposal,
  LearningStatus,
  LearningTask,
  LearningVersion,
  ServedRun,
} from './learning-types.js'

const run = promisify(execFile)
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_SINCE_DAYS = 30
const DEFAULT_REPLAY_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_CHECK_TIMEOUT_MS = 5 * 60 * 1000
const VERSION_PREFIX = 'learn.'

/**
 * The learning procedure's own settings. Its digest names the procedure in
 * every ledger it writes, so a change to how Braid learns is a new version.
 */
export const LEARNING_PROCEDURE = Object.freeze({
  name: 'braid-learn',
  sources: [
    'braid-feedback',
    'braid-task-checks',
    'claude-code-sessions',
    'codex-sessions',
    'change-ledger',
  ],
  changes:
    'per session, with the sessions that spawned it: changed; none when the change ledger observed it; otherwise unknown',
  candidates: ['skill', 'workflow', 'instructions', 'removal'],
  measure: 'agent-eval runSkillEval; judge: check pass beats fail, otherwise tie',
  gate: 'addition: keep and worst-family success does not fall; compression: worst-family success holds at equal or fewer loaded tokens',
  seed: 1,
  concurrency: 1,
})

export interface AddLearningTaskInput {
  readonly runId?: string
  readonly check: readonly string[]
  readonly family?: string
  readonly timeoutSeconds?: number
}

export interface LearningActions {
  readonly store: LearningStore
  status(): LearningStatus
  addTask(input: AddLearningTaskInput): Promise<LearningTask>
  propose(input?: { readonly sinceDays?: number }): Promise<LearningProposal>
  measure(input?: { readonly onProgress?: (text: string) => void }): Promise<LearningMeasurement>
  promote(input: {
    readonly operationId: string
    readonly candidateId?: string
    readonly override?: boolean
  }): Promise<LearningVersion>
  rollback(input: { readonly operationId: string }): Promise<LearningVersion>
}

function finishedRun(state: BraidState, runId: string | undefined) {
  const branchRuns = state.runs.filter(
    (item) => item.conversationId === state.conversationId && item.branchId === state.branchId,
  )
  const selected =
    runId === undefined
      ? (branchRuns.find((item) => item.id === state.focusedRunId) ?? branchRuns.at(-1))
      : state.runs.find((item) => item.id === runId)
  if (selected === undefined)
    throw new AppError('UNKNOWN_RUN', 'Select a finished run before adding it as a learning task')
  if (selected.status !== 'completed')
    throw new AppError('LEARNING_RUN_NOT_FINISHED', 'Only a completed run can become a task')
  return selected
}

/** The commit the run started from: the last commit on HEAD before it began. */
async function baseCommit(root: string, startedAt: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'rev-list', '-1', `--before=${startedAt}`, 'HEAD'],
      {
        timeout: 10_000,
      },
    )
    const commit = stdout.trim()
    return /^[0-9a-f]{40}$/u.test(commit) ? commit : undefined
  } catch {
    return undefined
  }
}

function servedRun(state: BraidState): ServedRun | null {
  for (const item of [...state.runs].reverse()) {
    const version = item.receipt.requested.profile.version
    if (version?.startsWith(VERSION_PREFIX) !== true) continue
    return {
      runId: item.id,
      version,
      profileDigest: `sha256:${item.receipt.profileDigest.replace(/^sha256:/u, '')}`,
      runner: item.receipt.requested.runner ?? item.receipt.requested.profile.harness ?? null,
      status: item.status,
    }
  }
  return null
}

export function createLearningActions(
  app: BraidApplication,
  configuration: LearningConfiguration,
): LearningActions {
  const store = new LearningStore(configuration.directory)
  const sinceDays = configuration.sinceDays ?? DEFAULT_SINCE_DAYS
  const host = {
    state: () => app.state(),
    configuration: app.configuration,
    runtime: app.runtimeSelection,
  }
  const base = (): AgentProfile => app.runtimeSelection.profile() as AgentProfile

  const select = async (operationId: string, path: string, label: string): Promise<void> => {
    const profile = store.readProfile(path)
    const record = createProfileRecord(
      { kind: 'file', reference: path, label, writable: false, trusted: true },
      profile,
    )
    await new ProfileActionService({ host, profiles: [record] }).select({ operationId, ref: path })
  }

  const active = (versions: readonly LearningVersion[]): LearningVersion | null => {
    const digest = profileDigest(base())
    const latest = versions.at(-1)
    return latest !== undefined && latest.profileDigest === digest ? latest : null
  }

  return {
    store,
    status() {
      const versions = store.versions()
      return {
        directory: store.directory,
        tasks: store.tasks(),
        proposal: store.proposal(),
        measurement: store.measurement(),
        versions,
        active: active(versions),
        served: servedRun(app.state()),
      }
    },

    async addTask(input) {
      if (input.check.length === 0 || input.check[0] === '')
        throw new AppError('INVALID_PARAMS', 'A learning task needs a check command')
      const state = app.state()
      const item = finishedRun(state, input.runId)
      const root = item.receipt.requested.workspaceRoot ?? state.workspace ?? undefined
      const commit = root === undefined ? undefined : await baseCommit(root, item.startedAt)
      const task: LearningTask = {
        id: `task-${sha256Hex(item.id).slice(0, 12)}`,
        runId: item.id,
        recordedAt: new Date().toISOString(),
        prompt: item.receipt.requested.text,
        check: {
          argv: [...input.check],
          timeoutMs:
            input.timeoutSeconds === undefined
              ? DEFAULT_CHECK_TIMEOUT_MS
              : Math.round(input.timeoutSeconds * 1000),
        },
        family: input.family ?? 'default',
        workspace:
          root !== undefined && commit !== undefined
            ? { kind: 'git', root, commit }
            : { kind: 'empty' },
      }
      store.saveTasks([...store.tasks().filter((existing) => existing.runId !== item.id), task])
      return task
    },

    async propose(input = {}) {
      const days = input.sinceDays ?? sinceDays
      const sinceMs = Date.now() - days * DAY_MS
      const profile = base()
      const feedback = await app.feedback.list({ scope: 'workspace' })
      const harness = await readHarnessSessions(configuration, sinceMs)
      const history = braidHistory(app.state(), feedback, sinceMs)
      const { candidates, skipped } = await proposeCandidates({ base: profile, harness, feedback })
      const digest = profileDigest(profile)
      const proposal: LearningProposal = {
        id: `proposal-${randomUUID()}`,
        createdAt: new Date().toISOString(),
        baseProfileDigest: digest,
        baseLoadedTokens: await loadedTokens(profile),
        sources: {
          sinceDays: days,
          braid: {
            runs: history.runs,
            feedback: history.feedback,
            lessons: history.reasons,
            tasks: store.tasks().length,
          },
          harnesses: harness.sources,
          changeLedger: harness.changeLedger,
        },
        candidates,
        skipped,
      }
      store.saveProposal(proposal)
      return proposal
    },

    async measure(input = {}) {
      const proposal = store.proposal()
      if (proposal === null || proposal.candidates.length === 0)
        throw new AppError('LEARNING_NO_CANDIDATES', 'Propose candidates first: /learn propose')
      const profile = base()
      const digest = profileDigest(profile)
      if (digest !== proposal.baseProfileDigest)
        throw new AppError(
          'LEARNING_PROPOSAL_STALE',
          'The active profile changed since the proposal; propose again: /learn propose',
        )
      const tasks = store.tasks()
      if (tasks.length === 0)
        throw new AppError(
          'LEARNING_NO_TASKS',
          'Mark finished runs as held-out tasks first: /learn task -- <check command>',
        )
      const procedureDigest = `sha256:${sha256Hex(JSON.stringify(LEARNING_PROCEDURE))}` as const
      const id = `measure-${randomUUID()}`
      const output = await measureCandidates({
        host: app,
        base: profile,
        baseDigest: digest,
        baseLoadedTokens: proposal.baseLoadedTokens,
        candidates: proposal.candidates,
        tasks,
        replayRoot: store.ensure('replays'),
        timeoutMs: configuration.replayTimeoutMs ?? DEFAULT_REPLAY_TIMEOUT_MS,
        seed: LEARNING_PROCEDURE.seed,
        concurrency: LEARNING_PROCEDURE.concurrency,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      })
      const ledgerPath = store.path('searches', id, 'ledger.jsonl')
      store.ensure('searches', id)
      await recordLearningLedger({
        path: ledgerPath,
        searchId: id,
        procedureDigest,
        seed: LEARNING_PROCEDURE.seed,
        base: { profile, digest },
        tasks,
        candidates: proposal.candidates,
        results: output.results,
        selected: output.selected,
        replays: output.replays,
        now: Date.now,
      })
      const measurement: LearningMeasurement = {
        id,
        proposalId: proposal.id,
        createdAt: new Date().toISOString(),
        procedureDigest,
        tasks: tasks.length,
        families: [...new Set(tasks.map((task) => task.family))].sort(),
        searchId: id,
        ledgerPath,
        results: output.results,
        selected: output.selected,
      }
      store.saveMeasurement(measurement)
      return measurement
    },

    async promote(input) {
      const measurement = store.measurement()
      const proposal = store.proposal()
      if (measurement === null || proposal === null || measurement.proposalId !== proposal.id)
        throw new AppError('LEARNING_NOT_MEASURED', 'Measure the proposal first: /learn measure')
      const candidateId = input.candidateId ?? measurement.selected ?? undefined
      if (candidateId === undefined)
        throw new AppError(
          'LEARNING_NOTHING_PROMOTABLE',
          'No candidate passed the gate. Name one with --override to promote it anyway.',
        )
      const result = measurement.results.find((item) => item.candidateId === candidateId)
      const candidate = proposal.candidates.find((item) => item.id === candidateId)
      if (result === undefined || candidate === undefined)
        throw new AppError('LEARNING_UNKNOWN_CANDIDATE', `No measured candidate ${candidateId}`)
      if (!result.gate.promotable && input.override !== true)
        throw new AppError(
          'LEARNING_GATE_REFUSED',
          `${candidate.name} did not pass the gate: ${result.gate.reason}. Use --override to promote it anyway.`,
        )
      const current = base()
      const parentDigest = profileDigest(current)
      if (parentDigest !== proposal.baseProfileDigest)
        throw new AppError(
          'LEARNING_PROPOSAL_STALE',
          'The active profile changed since the measurement; propose and measure again',
        )
      const versions = store.versions()
      const version = `${VERSION_PREFIX}${versions.filter((item) => item.action === 'promote').length + 1}`
      const parentPath = store.saveProfile(`parent-${parentDigest.slice(7, 23)}`, current)
      const promoted: AgentProfile = { ...candidate.profile, version }
      const path = store.saveProfile(version, promoted)
      await select(input.operationId, path, version)
      const entry: LearningVersion = {
        version,
        action: 'promote',
        at: new Date().toISOString(),
        profileDigest: profileDigest(promoted),
        parentDigest,
        profilePath: path,
        parentPath,
        candidateId,
        measurementId: measurement.id,
        override: !result.gate.promotable,
        reason: result.gate.promotable ? result.gate.reason : `override: ${result.gate.reason}`,
      }
      store.appendVersion(entry)
      return entry
    },

    async rollback(input) {
      const versions = store.versions()
      const current = active(versions)
      if (current === null || current.action !== 'promote')
        throw new AppError(
          'LEARNING_NOTHING_TO_ROLL_BACK',
          'The active profile is not a promoted learning version',
        )
      await select(input.operationId, current.parentPath, `before ${current.version}`)
      const restored = store.readProfile(current.parentPath)
      const entry: LearningVersion = {
        version: restored.version ?? 'unversioned',
        action: 'rollback',
        at: new Date().toISOString(),
        profileDigest: profileDigest(restored),
        parentDigest: current.profileDigest,
        profilePath: current.parentPath,
        parentPath: current.profilePath,
        candidateId: null,
        measurementId: null,
        override: false,
        reason: `rolled back ${current.version}`,
      }
      store.appendVersion(entry)
      return entry
    },
  }
}
