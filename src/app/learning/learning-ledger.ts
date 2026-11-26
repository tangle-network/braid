import type { AgentProfile } from '@tangle-network/agent-interface'
import { diffAgentProfiles } from '@tangle-network/agent-interface'
import type { TaskReplay } from './learning-replay.js'
import type {
  CandidateMeasurement,
  LearnerArm,
  LearningCandidate,
  LearningTask,
} from './learning-types.js'

type Digest = `sha256:${string}`

export interface LedgerRound {
  readonly path: string
  readonly searchId: string
  readonly procedureDigest: Digest
  readonly seed: number
  readonly base: { readonly profile: AgentProfile; readonly digest: string }
  readonly tasks: readonly LearningTask[]
  readonly candidates: readonly LearningCandidate[]
  readonly results: readonly CandidateMeasurement[]
  readonly selected: string | null
  /** Every replay that ran, by profile digest and task id. */
  readonly replays: ReadonlyMap<string, TaskReplay>
  readonly now: () => number
}

function digestOf(value: string): Digest {
  return (value.startsWith('sha256:') ? value : `sha256:${value}`) as Digest
}

type Campaign = typeof import('@tangle-network/agent-eval/campaign')
type Recorder = Awaited<ReturnType<Campaign['SearchRecorder']['open']>>
type SettleInput = Parameters<Recorder['settleCell']>[0]

function searchTasks(campaign: Campaign, tasks: readonly LearningTask[]) {
  return tasks.map((task) => ({
    taskId: task.id,
    unitId: task.id,
    source: { uri: `braid:learn-task/${task.id}`, revision: campaign.canonicalDigest(task) },
  }))
}

/** One replay as a settled cell: its check verdict, its tokens and cost when the runner reported them. */
function replayCell(
  cellId: string,
  replay: TaskReplay,
  profile: string,
  taskSet: Digest,
): SettleInput {
  return {
    cellId,
    outcome:
      replay.pass === null
        ? {
            status: 'errored',
            metrics: {},
            error: {
              code: 'replay-incomplete',
              message: replay.error ?? 'unknown',
              retryable: true,
            },
          }
        : replay.pass
          ? { status: 'passed', score: 1, metrics: {} }
          : {
              status: 'failed',
              score: 0,
              metrics: {},
              failure: { code: 'check-failed', message: 'the task check exited non-zero' },
            },
    accounting: {
      tokens: replay.tokens.known
        ? {
            status: 'known',
            inputTokens: replay.tokens.input,
            outputTokens: replay.tokens.output,
            cachedTokens: 0,
          }
        : { status: 'unknown', reason: 'the runner reported no complete token usage' },
      cost:
        replay.trace.costUsd === null
          ? {
              status: 'unknown',
              knownLowerBoundUsd: 0,
              reason: 'subscription seat: the runner reports no price',
            }
          : { status: 'known', usd: replay.trace.costUsd, source: 'provider' },
    },
    wallMs: replay.trace.wallMs,
    identity: {
      model: {
        provider: replay.runner ?? 'runtime-default',
        alias: replay.model ?? 'runtime-default',
        unknown: 'the runner does not report a served model snapshot',
      },
      agent: { uri: 'braid:profile', revision: digestOf(profile) },
      benchmark: { uri: 'braid:learn-tasks', revision: taskSet },
    },
  }
}

/**
 * Write one measurement round as an agent-eval search ledger: the base profile
 * is the root node, each candidate a child with its profile diff, each replay a
 * settled cell on the selection split, and each candidate's decision the skill
 * eval's. A skill or workflow node is keyed by its unit's body digest, so the
 * procedure registry joins it with the same skill version in recorded sessions.
 */
export async function recordLearningLedger(round: LedgerRound): Promise<void> {
  const campaign = await import('@tangle-network/agent-eval/campaign')
  const { canonicalDigest, openSearchLedger, SearchRecorder } = campaign
  const tasks = searchTasks(campaign, round.tasks)
  const taskSet = canonicalDigest(tasks)
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({ path: round.path, searchId: round.searchId }),
      now: round.now,
    },
    {
      subject: 'braid/root-profile',
      process: {
        name: 'braid-learn',
        executionRef: { uri: 'braid:learning-procedure', revision: round.procedureDigest },
      },
      artifactKind: 'agent-profile',
      objective: {
        metric: 'check-pass',
        direction: 'maximize',
        judge: { uri: 'braid:task-check', revision: taskSet },
        claim: {
          population: {
            id: 'braid-learn-tasks',
            description: 'tasks the user marked with a check',
          },
          samplingFrame: 'every task with a check in the local learning store',
          independentUnit: 'id',
          generalization: 'new-units',
          use: 'comparison',
          minimumEffect: 0.1,
        },
      },
      splits: { train: [], selection: tasks, test: [], heldOutUnits: false },
      policy: { expansion: 'braid-learn-candidates', allocation: 'uniform', seed: round.seed },
      budget: {
        maxUsd: null,
        maxCells: null,
        maxNodes: null,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: {
          provider: round.base.profile.harness ?? 'runtime-default',
          alias: round.base.profile.model?.default ?? 'runtime-default',
          unknown: 'the runner does not report a served model snapshot',
        },
        agent: { uri: 'braid:profile', revision: digestOf(round.base.digest) },
        benchmark: { uri: 'braid:learn-tasks', revision: taskSet },
      },
    },
  )

  const register = async (
    artifactDigest: Digest,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const artifact = recorder.blob('agent-profile', body)
    const { nodeId } = await recorder.registerNode({
      artifactDigest,
      artifact,
      surfaces: [{ surfaceId: 'profile', kind: 'agent-profile', artifact }],
    })
    return nodeId
  }

  const baseNode = await register(digestOf(round.base.digest), {
    kind: 'braid-learn-base',
    profileDigest: round.base.digest,
  })
  await recorder.recordEdge({
    childNodeId: baseNode,
    parents: [],
    operator: 'seed',
    attribution: 'explicit',
    proposer: null,
    proposalKey: 'base',
    rationale: { unknown: 'the active profile when the round started' },
    diffs: [],
  })
  const nodes = new Map<string, string>([[round.base.digest, baseNode]])
  for (const candidate of round.candidates) {
    const nodeId = await register(
      digestOf(candidate.kind === 'removal' ? candidate.profileDigest : candidate.unitDigest),
      {
        kind: 'braid-learn-candidate',
        candidateKind: candidate.kind,
        name: candidate.name,
        unitDigest: candidate.unitDigest,
        profileDigest: candidate.profileDigest,
        loadedTokens: candidate.loadedTokens,
      },
    )
    nodes.set(candidate.profileDigest, nodeId)
    await recorder.recordEdge({
      childNodeId: nodeId,
      parents: [baseNode],
      operator: candidate.kind === 'removal' ? 'improve' : 'draft',
      attribution: 'explicit',
      proposer: {
        kind: 'trace',
        name: 'braid-learn',
        operationId: null,
        source: { uri: 'braid:learning-procedure', revision: round.procedureDigest },
      },
      proposalKey: candidate.id,
      rationale: candidate.summary,
      diffs: [
        recorder.blob('diff', {
          kind: 'agent-profile-diff',
          changes: diffAgentProfiles(round.base.profile, candidate.profile),
        }),
      ],
      label: candidate.name,
    })
  }

  for (const [profile, nodeId] of nodes) {
    for (const task of round.tasks) {
      const replay = round.replays.get(`${profile}:${task.id}`)
      if (replay === undefined) continue
      const cellId = await recorder.allocateCell({
        nodeId,
        taskId: task.id,
        split: 'selection',
        rep: 0,
        stage: nodeId === baseNode ? 'root' : 'screen',
      })
      await recorder.settleCell(replayCell(cellId, replay, profile, taskSet))
    }
  }

  const rule = 'braid-learn: skill eval decision, then the worst-family gate'
  for (const result of round.results) {
    const candidate = round.candidates.find((item) => item.id === result.candidateId)
    if (candidate === undefined) continue
    await recorder.decideNode({
      nodeId: nodes.get(candidate.profileDigest) as string,
      decision:
        round.selected === candidate.id
          ? { status: 'selected' }
          : result.gate.promotable
            ? { status: 'rejected' }
            : { status: 'pruned' },
      rule,
      reason: `${result.decision}: ${result.reason} Gate: ${result.gate.reason}`,
    })
  }
  await recorder.decideNode({
    nodeId: baseNode,
    decision: round.selected === null ? { status: 'selected' } : { status: 'rejected' },
    rule,
    reason:
      round.selected === null
        ? 'No candidate passed the gate; the active profile stays.'
        : `Candidate ${round.selected} passed the gate.`,
  })
  await recorder.close({ reason: 'converged', claim: null })
}

export interface LearnerLedgerRound {
  readonly path: string
  readonly searchId: string
  readonly seed: number
  readonly selection: readonly LearningTask[]
  readonly heldOut: readonly LearningTask[]
  readonly arms: readonly LearnerArm[]
  /** Each learner's profile, by arm name. */
  readonly learners: ReadonlyMap<string, AgentProfile>
  readonly selected: string | null
  readonly replays: ReadonlyMap<string, TaskReplay>
  readonly now: () => number
}

/**
 * Write one learner round as an agent-eval search ledger. The artifact is the
 * learner profile: the active learner is the root, each variant a child with
 * its profile diff. Learners pick on the train split (the selection tasks);
 * each node's cells are its pick's replays on the held-out tasks, which the
 * ledger names its selection split because they choose between learners.
 */
export async function recordLearnerLedger(round: LearnerLedgerRound): Promise<void> {
  const campaign = await import('@tangle-network/agent-eval/campaign')
  const { canonicalDigest, openSearchLedger, SearchRecorder } = campaign
  const train = searchTasks(campaign, round.selection)
  const selection = searchTasks(campaign, round.heldOut)
  const taskSet = canonicalDigest(selection)
  const root = round.arms[0] as LearnerArm
  const rootProfile = round.learners.get(root.name) as AgentProfile
  const recorder = await SearchRecorder.open(
    {
      ledger: openSearchLedger({ path: round.path, searchId: round.searchId }),
      now: round.now,
    },
    {
      subject: 'braid/learner-profile',
      process: {
        name: 'braid-learner',
        executionRef: { uri: 'braid:learner', revision: digestOf(root.learnerDigest) },
      },
      artifactKind: 'agent-profile',
      objective: {
        metric: 'check-pass',
        direction: 'maximize',
        judge: { uri: 'braid:task-check', revision: taskSet },
        claim: {
          population: {
            id: 'braid-learn-tasks',
            description: 'tasks the user marked with a check',
          },
          samplingFrame: 'every task with a check in the local learning store',
          independentUnit: 'id',
          generalization: 'new-units',
          use: 'comparison',
          minimumEffect: 0.1,
        },
      },
      splits: { train, selection, test: [], heldOutUnits: false },
      policy: { expansion: 'braid-learner-variants', allocation: 'uniform', seed: round.seed },
      budget: {
        maxUsd: null,
        maxCells: null,
        maxNodes: null,
        deadline: null,
        maxConcurrency: null,
        reservedClaimUsd: 0,
      },
      containment: null,
      derivedFrom: null,
      identity: {
        model: {
          provider: 'runtime-default',
          alias: 'runtime-default',
          unknown: 'each pick replays on the active connection',
        },
        agent: { uri: 'braid:learner', revision: digestOf(root.learnerDigest) },
        benchmark: { uri: 'braid:learn-tasks', revision: taskSet },
      },
    },
  )
  const rule = 'braid-learner: held-out worst-family success of the pick'
  const nodes = new Map<string, string>()
  for (const [index, arm] of round.arms.entries()) {
    const profile = round.learners.get(arm.name) as AgentProfile
    const artifact = recorder.blob('agent-profile', {
      kind: 'braid-learner',
      name: arm.name,
      learnerDigest: arm.learnerDigest,
      settings: arm.settings,
    })
    const { nodeId } = await recorder.registerNode({
      artifactDigest: digestOf(arm.learnerDigest),
      artifact,
      surfaces: [{ surfaceId: 'learner', kind: 'agent-profile', artifact }],
    })
    nodes.set(arm.name, nodeId)
    await recorder.recordEdge({
      childNodeId: nodeId,
      parents: index === 0 ? [] : [nodes.get(root.name) as string],
      operator: index === 0 ? 'seed' : 'improve',
      attribution: 'explicit',
      proposer:
        index === 0
          ? null
          : {
              kind: 'trace',
              name: 'braid-learner',
              operationId: null,
              source: { uri: 'braid:learner', revision: digestOf(root.learnerDigest) },
            },
      proposalKey: arm.name,
      rationale: index === 0 ? { unknown: 'the active learner when the round started' } : arm.summary,
      diffs:
        index === 0
          ? []
          : [
              recorder.blob('diff', {
                kind: 'agent-profile-diff',
                changes: diffAgentProfiles(rootProfile, profile),
              }),
            ],
      label: arm.name,
    })
    for (const task of round.heldOut) {
      const replay = round.replays.get(`${arm.pick.profileDigest}:${task.id}`)
      if (replay === undefined) continue
      const cellId = await recorder.allocateCell({
        nodeId,
        taskId: task.id,
        split: 'selection',
        rep: 0,
        stage: index === 0 ? 'root' : 'screen',
      })
      await recorder.settleCell(replayCell(cellId, replay, arm.pick.profileDigest, taskSet))
    }
  }
  for (const [index, arm] of round.arms.entries()) {
    const chosen = round.selected === null ? index === 0 : round.selected === arm.name
    await recorder.decideNode({
      nodeId: nodes.get(arm.name) as string,
      decision: chosen
        ? { status: 'selected' }
        : index === 0 || arm.gate.promotable
          ? { status: 'rejected' }
          : { status: 'pruned' },
      rule,
      reason: `Picked ${arm.pick.name}. ${arm.gate.reason}`,
    })
  }
  await recorder.close({ reason: 'converged', claim: null })
}
