import type { SkillEvalReport } from '@tangle-network/agent-eval'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { type ReplayHost, type TaskReplay, replayTask } from './learning-replay.js'
import type {
  ArmSummary,
  CandidateMeasurement,
  FamilyPass,
  LearningCandidate,
  LearningTask,
} from './learning-types.js'

export const ADDITION_RULE =
  'Addition: promote only when the skill eval keeps the unit and worst-family success does not fall.'
export const COMPRESSION_RULE =
  'Compression: promote only when worst-family success holds or rises at equal or fewer loaded tokens, and the skill eval does not keep what was removed.'

export interface MeasureInput {
  readonly host: ReplayHost
  readonly base: AgentProfile
  readonly baseDigest: string
  readonly baseLoadedTokens: number
  readonly candidates: readonly LearningCandidate[]
  readonly tasks: readonly LearningTask[]
  readonly replayRoot: string
  readonly timeoutMs: number
  readonly seed: number
  readonly concurrency: number
  readonly onProgress?: (text: string) => void
}

export interface MeasureOutput {
  readonly results: CandidateMeasurement[]
  readonly selected: string | null
  readonly replays: Map<string, TaskReplay>
}

const VERDICT = /^check (passed|failed)\n/u

function familiesOf(tasks: readonly LearningTask[], results: readonly TaskReplay[]): FamilyPass[] {
  const names = [...new Set(tasks.map((task) => task.family))].sort()
  return names.map((family) => {
    const known = results.filter((result) => result.family === family && result.pass !== null)
    const passed = known.filter((result) => result.pass === true).length
    return {
      family,
      passed,
      known: known.length,
      rate: known.length === 0 ? null : passed / known.length,
    }
  })
}

export function armSummary(
  profileDigest: string,
  loadedTokens: number,
  tasks: readonly LearningTask[],
  replays: ReadonlyMap<string, TaskReplay>,
): ArmSummary {
  const results = tasks.flatMap((task) => {
    const result = replays.get(`${profileDigest}:${task.id}`)
    return result === undefined ? [] : [result]
  })
  const families = familiesOf(tasks, results)
  const measured = families.filter((family) => family.rate !== null)
  const worstFamily =
    measured.length === 0
      ? null
      : measured.reduce((worst, family) =>
          (family.rate as number) < (worst.rate as number) ? family : worst,
        )
  let costUsd: number | null = results.length === 0 ? null : 0
  for (const result of results)
    costUsd = costUsd === null || result.trace.costUsd === null ? null : costUsd + result.trace.costUsd
  return {
    profileDigest,
    loadedTokens,
    passed: results.filter((result) => result.pass === true).length,
    known: results.filter((result) => result.pass !== null).length,
    errored: results.filter((result) => result.pass === null).length,
    worstFamily,
    families,
    costUsd,
  }
}

/** The promotion gate: the skill eval's decision, then worst-family success at the candidate's cost. */
export function promotionGate(
  candidate: LearningCandidate,
  report: Pick<SkillEvalReport, 'decision'>,
  base: ArmSummary,
  measured: ArmSummary,
  tasks: number,
): CandidateMeasurement['gate'] {
  const compression = candidate.kind === 'removal' || measured.loadedTokens <= base.loadedTokens
  const rule = compression ? COMPRESSION_RULE : ADDITION_RULE
  const refuse = (reason: string) => ({ promotable: false, rule, reason })
  if (measured.known < tasks)
    return refuse(`${tasks - measured.known} of ${tasks} candidate replays have no check result`)
  if (base.worstFamily === null || measured.worstFamily === null)
    return refuse('worst-family success is unknown')
  const baseRate = base.worstFamily.rate as number
  const rate = measured.worstFamily.rate as number
  const worst = `worst family ${measured.worstFamily.family} ${measured.worstFamily.passed}/${measured.worstFamily.known} against ${base.worstFamily.family} ${base.worstFamily.passed}/${base.worstFamily.known}`
  if (compression) {
    if (candidate.kind === 'removal' && report.decision === 'keep')
      return refuse(`the skill eval keeps ${candidate.name}: removing it loses answers`)
    if (candidate.kind !== 'removal' && report.decision === 'cut')
      return refuse('the skill eval cuts the unit')
    if (rate < baseRate) return refuse(`success falls: ${worst}`)
    return {
      promotable: true,
      rule,
      reason: `success holds (${worst}) at ${measured.loadedTokens} loaded tokens against ${base.loadedTokens}`,
    }
  }
  if (report.decision !== 'keep') return refuse(`the skill eval is ${report.decision}`)
  if (rate < baseRate) return refuse(`success falls: ${worst}`)
  return {
    promotable: true,
    rule,
    reason: `kept by the skill eval; ${worst}; ${measured.loadedTokens - base.loadedTokens} more loaded tokens`,
  }
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  each: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++] as T
        await each(item)
      }
    }),
  )
}

/**
 * Measure every candidate against the base profile on the held-out tasks with
 * agent-eval's skill eval. The base replays once per task and is shared by every
 * candidate. Each replay's check decides pass or fail; the blind judge prefers a
 * passing answer to a failing one and otherwise calls a tie.
 */
export async function measureCandidates(input: MeasureInput): Promise<MeasureOutput> {
  const { runSkillEval } = await import('@tangle-network/agent-eval')
  const replays = new Map<string, TaskReplay>()
  const pending = new Map<string, Promise<TaskReplay>>()
  const replay = (profile: AgentProfile, digest: string, task: LearningTask) => {
    const key = `${digest}:${task.id}`
    let result = pending.get(key)
    if (result === undefined) {
      result = replayTask({
        host: input.host,
        profile,
        task,
        replayRoot: input.replayRoot,
        timeoutMs: input.timeoutMs,
      }).then((value) => {
        replays.set(key, value)
        input.onProgress?.(
          `Replayed ${task.id} under ${digest.slice(7, 19)}: ${value.pass === null ? `no result (${value.error})` : value.pass ? 'passed' : 'failed'}`,
        )
        return value
      })
      pending.set(key, result)
    }
    return result
  }

  input.onProgress?.(`Replaying ${input.tasks.length} tasks under the active profile`)
  await mapLimit(input.tasks, input.concurrency, async (task) => {
    await replay(input.base, input.baseDigest, task)
  })
  const base = armSummary(input.baseDigest, input.baseLoadedTokens, input.tasks, replays)

  const results: CandidateMeasurement[] = []
  for (const candidate of input.candidates) {
    input.onProgress?.(`Measuring ${candidate.kind} ${candidate.name}`)
    const removal = candidate.kind === 'removal'
    const withArm = removal
      ? { profile: input.base, digest: input.baseDigest }
      : { profile: candidate.profile, digest: candidate.profileDigest }
    const withoutArm = removal
      ? { profile: candidate.profile, digest: candidate.profileDigest }
      : { profile: input.base, digest: input.baseDigest }
    const report = await runSkillEval({
      unit: { name: candidate.name, text: candidate.unitText },
      cases: input.tasks,
      seed: input.seed,
      concurrency: input.concurrency,
      run: async (task, arm) => {
        const chosen = arm.arm === 'with' ? withArm : withoutArm
        const result = await replay(chosen.profile, chosen.digest, task)
        if (result.pass === null) throw new Error(result.error ?? 'the replay has no result')
        return {
          answer: `check ${result.pass ? 'passed' : 'failed'}\n${result.answer}`,
          pass: result.pass,
          trace: result.trace,
        }
      },
      judge: async ({ first, second }) => {
        const left = VERDICT.exec(first)?.[1]
        const right = VERDICT.exec(second)?.[1]
        if (left === right) return 'tie'
        return left === 'passed' ? 'first' : 'second'
      },
    })
    const measured = armSummary(
      candidate.profileDigest,
      candidate.loadedTokens,
      input.tasks,
      replays,
    )
    const comparison = report.comparisons.find((item) => item.against === 'without')
    results.push({
      candidateId: candidate.id,
      kind: candidate.kind,
      name: candidate.name,
      decision: report.decision,
      reason: report.reason,
      headroom: `${report.headroom.verdict}: the arm without the unit passes ${report.headroom.passed} of ${report.headroom.passed + report.headroom.failed} known`,
      wins: comparison?.preference.wins ?? 0,
      losses: comparison?.preference.losses ?? 0,
      ties: comparison?.preference.ties ?? 0,
      notJudged: comparison?.preference.notJudged ?? 0,
      base,
      candidate: measured,
      gate: promotionGate(candidate, report, base, measured, input.tasks.length),
      failures: report.failures.map(
        (failure) =>
          `${failure.caseId} ${'run' in failure.step ? `run ${failure.step.run}` : `judge ${failure.step.judge}`}: ${failure.error}`,
      ),
    })
  }
  const promotable = results
    .filter((result) => result.gate.promotable)
    .sort(
      (left, right) =>
        (right.candidate.worstFamily?.rate ?? 0) - (left.candidate.worstFamily?.rate ?? 0) ||
        left.candidate.loadedTokens - right.candidate.loadedTokens,
    )
  return { results, selected: promotable[0]?.candidateId ?? null, replays }
}
