import type { AgentProfile } from '@tangle-network/agent-interface'
import { learnerDigest, type LearnerVariant } from './learner-profile.js'
import { type ProposeCandidatesInput, proposeCandidates } from './learning-candidates.js'
import { armSummary, createReplayer, mapLimit, measureCandidates } from './learning-measure.js'
import { sha256Hex } from './learning-profile.js'
import type { ReplayHost, TaskReplay } from './learning-replay.js'
import type {
  ArmSummary,
  LearnerArm,
  LearnerSettings,
  LearningCandidate,
  LearningTask,
} from './learning-types.js'

export const LEARNER_RULE =
  "Learner: promote a variant only when the profile it picks on the selection tasks beats the active learner's pick on the held-out tasks: worst-family success rises, with every held-out replay known."

/**
 * Split the tasks per family by a seeded order: the larger half of each
 * family is held out, so a family with one task is only ever judged on.
 */
export function splitLearnerTasks(
  tasks: readonly LearningTask[],
  seed: number,
): { readonly selection: LearningTask[]; readonly heldOut: LearningTask[] } {
  const selection: LearningTask[] = []
  const heldOut: LearningTask[] = []
  for (const family of [...new Set(tasks.map((task) => task.family))].sort()) {
    const members = tasks
      .filter((task) => task.family === family)
      .map((task) => ({ task, order: sha256Hex(`${seed}:${task.id}`) }))
      .sort((left, right) => (left.order < right.order ? -1 : 1))
      .map((item) => item.task)
    const held = Math.ceil(members.length / 2)
    heldOut.push(...members.slice(0, held))
    selection.push(...members.slice(held))
  }
  return { selection, heldOut }
}

export interface MeasureLearnersInput {
  readonly host: ReplayHost
  readonly base: AgentProfile
  readonly baseDigest: string
  readonly baseLoadedTokens: number
  readonly active: LearnerSettings
  readonly variants: readonly LearnerVariant[]
  readonly tasks: readonly LearningTask[]
  /** What every learner reads: the same sessions and feedback. */
  readonly sources: Pick<ProposeCandidatesInput, 'harness' | 'feedback' | 'pin'>
  readonly replayRoot: string
  readonly timeoutMs: number
  readonly onProgress?: (text: string) => void
}

export interface MeasureLearnersOutput {
  readonly selection: readonly LearningTask[]
  readonly heldOut: readonly LearningTask[]
  readonly arms: LearnerArm[]
  readonly selected: string | null
  readonly replays: ReadonlyMap<string, TaskReplay>
}

function learnerGate(active: ArmSummary, measured: ArmSummary, tasks: number): LearnerArm['gate'] {
  const refuse = (reason: string) => ({ promotable: false, rule: LEARNER_RULE, reason })
  if (measured.known < tasks)
    return refuse(
      `${tasks - measured.known} of ${tasks} held-out replays of its pick have no result`,
    )
  if (active.known < tasks)
    return refuse(
      `${tasks - active.known} of ${tasks} held-out replays of the active learner's pick have no result`,
    )
  if (active.worstFamily === null || measured.worstFamily === null)
    return refuse('worst-family success is unknown')
  const worst = `worst family ${measured.worstFamily.family} ${measured.worstFamily.passed}/${measured.worstFamily.known} against ${active.worstFamily.family} ${active.worstFamily.passed}/${active.worstFamily.known}`
  if ((measured.worstFamily.rate as number) <= (active.worstFamily.rate as number))
    return refuse(`held-out success does not rise: ${worst}`)
  return { promotable: true, rule: LEARNER_RULE, reason: `held-out success rises: ${worst}` }
}

/**
 * Measure learners by what they pick. Every learner proposes from the same
 * sources, measures its candidates on the selection tasks and picks one, or
 * keeps the active profile; each pick then replays on the held-out tasks no
 * learner chose on. Replays are shared by profile digest, so candidates and
 * picks that several learners share run once.
 */
export async function measureLearners(input: MeasureLearnersInput): Promise<MeasureLearnersOutput> {
  const { selection, heldOut } = splitLearnerTasks(input.tasks, input.active.seed)
  const concurrency = input.active.concurrency
  const replayer = createReplayer(input)
  const learners: { name: string; summary: string; settings: LearnerSettings }[] = [
    { name: 'active', summary: 'The active learner', settings: input.active },
    ...input.variants,
  ]
  const measured: Omit<LearnerArm, 'gate'>[] = []
  for (const learner of learners) {
    input.onProgress?.(`Learner ${learner.name}: proposing`)
    const { candidates, skipped } = await proposeCandidates({
      base: input.base,
      ...input.sources,
      settings: learner.settings.candidates,
    })
    let picked: LearningCandidate | undefined
    if (candidates.length > 0 && selection.length > 0) {
      input.onProgress?.(
        `Learner ${learner.name}: measuring ${candidates.length} candidates on ${selection.length} selection tasks`,
      )
      const round = await measureCandidates({
        host: input.host,
        base: input.base,
        baseDigest: input.baseDigest,
        baseLoadedTokens: input.baseLoadedTokens,
        candidates,
        tasks: selection,
        replayRoot: input.replayRoot,
        timeoutMs: input.timeoutMs,
        seed: learner.settings.seed,
        concurrency,
        replayer,
        ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      })
      picked = candidates.find((candidate) => candidate.id === round.selected)
    }
    const profile = picked?.profile ?? input.base
    const pick: LearnerArm['pick'] =
      picked === undefined
        ? {
            candidateId: null,
            kind: null,
            name: 'the active profile',
            profileDigest: input.baseDigest,
            loadedTokens: input.baseLoadedTokens,
          }
        : {
            candidateId: picked.id,
            kind: picked.kind,
            name: picked.name,
            profileDigest: picked.profileDigest,
            loadedTokens: picked.loadedTokens,
          }
    input.onProgress?.(
      `Learner ${learner.name}: replaying its pick, ${pick.name}, on ${heldOut.length} held-out tasks`,
    )
    await mapLimit(heldOut, concurrency, async (task) => {
      await replayer.replay(profile, pick.profileDigest, task)
    })
    measured.push({
      name: learner.name,
      summary: learner.summary,
      learnerDigest: learnerDigest(learner.settings),
      settings: learner.settings,
      candidates: candidates.length,
      skipped,
      pick,
      selection: armSummary(pick.profileDigest, pick.loadedTokens, selection, replayer.replays),
      heldOut: armSummary(pick.profileDigest, pick.loadedTokens, heldOut, replayer.replays),
    })
  }
  const active = measured[0] as Omit<LearnerArm, 'gate'>
  const arms: LearnerArm[] = measured.map((arm, index) => ({
    ...arm,
    gate:
      index === 0
        ? { promotable: false, rule: LEARNER_RULE, reason: 'the active learner' }
        : learnerGate(active.heldOut, arm.heldOut, heldOut.length),
  }))
  const promotable = arms
    .filter((arm) => arm.gate.promotable)
    .sort(
      (left, right) =>
        (right.heldOut.worstFamily?.rate ?? 0) - (left.heldOut.worstFamily?.rate ?? 0) ||
        left.candidates - right.candidates,
    )
  return {
    selection,
    heldOut,
    arms,
    selected: promotable[0]?.name ?? null,
    replays: replayer.replays,
  }
}
