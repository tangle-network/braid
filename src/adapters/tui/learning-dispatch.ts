import type { BraidApplication } from '../../app/application.js'
import { AppError } from '../../app/errors.js'
import type { LearningActions } from '../../app/learning/learning-actions.js'
import type {
  CandidateMeasurement,
  LearnerArm,
  LearnerStatus,
  LearningConfiguration,
  LearningStatus,
} from '../../app/learning/learning-types.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { EntityBrowserDocument, EntityBrowserRow } from '../../views/tui/entity-browser.js'

const USAGE =
  '/learn [status | task [--family name] [--timeout seconds] -- <check...> | propose [--since days] | measure | promote [candidate] [--override] | rollback | learner [status | measure | promote [variant] [--override] | rollback]]'

export interface LearningDispatchContext {
  readonly app: BraidApplication
  readonly configuration: LearningConfiguration | undefined
  readonly setNotice: (notice: string) => void
  readonly notify: () => void
}

const loaded = new WeakMap<BraidApplication, Promise<LearningActions>>()

function actionsFor(context: LearningDispatchContext): Promise<LearningActions> {
  const configuration = context.configuration
  if (configuration === undefined)
    throw new AppError('LEARNING_UNAVAILABLE', 'Learning needs a local store; start Braid normally')
  let actions = loaded.get(context.app)
  if (actions === undefined) {
    actions = import('../../app/learning/learning-actions.js').then((module) =>
      module.createLearningActions(context.app, configuration),
    )
    loaded.set(context.app, actions)
  }
  return actions
}

function percent(passed: number, known: number): string {
  return known === 0 ? 'no result' : `${passed}/${known} (${Math.round((passed / known) * 100)}%)`
}

function measurementLines(result: CandidateMeasurement): string[] {
  const worst = (arm: CandidateMeasurement['base']) =>
    arm.worstFamily === null
      ? 'unknown'
      : `${arm.worstFamily.family} ${percent(arm.worstFamily.passed, arm.worstFamily.known)}`
  return [
    `Skill eval: ${result.decision}. ${result.reason}`,
    `Headroom: ${result.headroom}`,
    `Blind judge: ${result.wins} wins, ${result.losses} losses, ${result.ties} ties, ${result.notJudged} not judged`,
    `Pass: candidate ${percent(result.candidate.passed, result.candidate.known)} · active ${percent(result.base.passed, result.base.known)}`,
    `Worst family: candidate ${worst(result.candidate)} · active ${worst(result.base)}`,
    `Loaded tokens (estimated): candidate ${result.candidate.loadedTokens} · active ${result.base.loadedTokens}`,
    `Gate: ${result.gate.promotable ? 'promotable' : 'not promotable'}. ${result.gate.reason}`,
    `Rule: ${result.gate.rule}`,
    ...result.failures.slice(0, 5).map((failure) => `Not judged: ${failure}`),
  ]
}

function learnerArmLines(arm: LearnerArm): string[] {
  const worst = (summary: LearnerArm['heldOut']) =>
    summary.worstFamily === null
      ? 'unknown'
      : `${summary.worstFamily.family} ${percent(summary.worstFamily.passed, summary.worstFamily.known)}`
  const { candidates } = arm.settings
  return [
    arm.summary,
    `Learner: ${arm.learnerDigest}`,
    `Proposes: ${candidates.kinds.join(', ')}; up to ${candidates.maxSkills} skills and ${candidates.maxRemovals} removals from ${candidates.rowsTried} rows; workflows from ${candidates.workflowMinSessions} sessions`,
    `Proposed ${arm.candidates} candidates; picked ${arm.pick.name}${arm.pick.candidateId === null ? '' : ` (${arm.pick.candidateId})`}`,
    `Selection tasks: ${percent(arm.selection.passed, arm.selection.known)}, worst family ${worst(arm.selection)}`,
    `Held-out tasks: ${percent(arm.heldOut.passed, arm.heldOut.known)}, worst family ${worst(arm.heldOut)}`,
    `Gate: ${arm.gate.promotable ? 'promotable' : 'not promotable'}. ${arm.gate.reason}`,
    `Rule: ${arm.gate.rule}`,
    ...arm.skipped.map((reason) => `Skipped: ${reason}`),
  ]
}

/** The learner's rows: the active learner, the latest round's arms and the learner versions. */
function learnerRows(learner: LearnerStatus): EntityBrowserRow[] {
  const rows: EntityBrowserRow[] = []
  const { candidates } = learner.settings
  rows.push({
    id: 'learner',
    kind: 'learner',
    title: learner.active.version ?? 'default learner',
    status: 'active',
    meta: candidates.kinds.join(', '),
    detailLines: [
      `Learner: ${learner.active.digest}`,
      `Reads: ${learner.settings.sources.join(', ')}`,
      `Proposes: ${candidates.kinds.join(', ')}; up to ${candidates.maxSkills} skills and ${candidates.maxRemovals} removals`,
      `Measures: ${learner.settings.measure}`,
      `Gate: ${learner.settings.gate}`,
      'Measure variants of it: /learn learner measure',
    ],
  })
  const measurement = learner.measurement
  if (measurement !== null)
    for (const arm of measurement.arms)
      rows.push({
        id: `learner-${arm.name}`,
        kind: arm.name === 'active' ? 'learner (active)' : 'learner variant',
        title: arm.name,
        status: arm.gate.promotable ? 'promotable' : 'measured',
        meta: `picks ${arm.pick.name}`,
        current: measurement.selected === arm.name,
        detailLines: [
          ...learnerArmLines(arm),
          `Round: ${measurement.selectionTasks.length} selection and ${measurement.heldOutTasks.length} held-out tasks, seed ${measurement.seed}`,
          `Ledger: ${measurement.ledgerPath}`,
        ],
      })
  for (const version of [...learner.versions].reverse())
    rows.push({
      id: `learner-${version.action}-${version.at}`,
      kind: version.action === 'promote' ? 'learner promoted' : 'learner rolled back to',
      title: version.version,
      status: version.override ? 'override' : 'measured',
      meta: version.at.slice(0, 19).replace('T', ' '),
      detailLines: [
        `Profile: ${version.profileDigest}`,
        `Replaced: ${version.parentDigest}`,
        `File: ${version.profilePath}`,
        `Reason: ${version.reason}`,
      ],
    })
  return rows
}

/** The learning panel: sources, tasks, candidates with their measurement, versions and the served run. */
export function learningDocument(status: LearningStatus, notice?: string): EntityBrowserDocument {
  const rows: EntityBrowserRow[] = []
  const proposal = status.proposal
  if (proposal !== null) {
    const harnesses = proposal.sources.harnesses
      .map(
        (source) =>
          `${source.harness} ${source.sessions} sessions, ${source.skillInvocations} skill invocations`,
      )
      .join('; ')
    rows.push({
      id: 'sources',
      kind: 'sources',
      title: 'Sources',
      status: 'read',
      meta: `last ${proposal.sources.sinceDays} days · ${proposal.sources.harnesses.length + 1} harnesses`,
      detailLines: [
        `Braid: ${proposal.sources.braid.runs} runs, ${proposal.sources.braid.feedback} feedback decisions, ${proposal.sources.braid.lessons} with a reason`,
        `Other harnesses: ${harnesses === '' ? 'none read' : harnesses}`,
        ...proposal.skipped.map((reason) => `Skipped: ${reason}`),
      ],
    })
  }
  for (const task of status.tasks) {
    rows.push({
      id: task.id,
      kind: 'task',
      title: task.id,
      status: task.family,
      meta: task.workspace.kind === 'git' ? 'replays at commit' : 'replays in empty dir',
      detailLines: [
        `Run: ${task.runId}`,
        `Family: ${task.family}`,
        `Check: ${task.check.argv.join(' ')} (timeout ${Math.round(task.check.timeoutMs / 1000)} s)`,
        task.workspace.kind === 'git'
          ? `Workspace: ${task.workspace.root} at ${task.workspace.commit.slice(0, 12)}`
          : 'Workspace: an empty directory',
      ],
    })
  }
  const measurement = status.measurement
  for (const candidate of proposal?.candidates ?? []) {
    const result =
      measurement?.proposalId === proposal?.id
        ? measurement?.results.find((item) => item.candidateId === candidate.id)
        : undefined
    rows.push({
      id: candidate.id,
      kind: candidate.kind,
      title: candidate.name,
      status:
        result === undefined
          ? 'unmeasured'
          : `${result.decision}${result.gate.promotable ? ' · promotable' : ''}`,
      meta: `${candidate.loadedTokens} tokens`,
      current: measurement?.selected === candidate.id,
      detailLines: [
        candidate.summary,
        `Candidate: ${candidate.id}`,
        `Procedure version: ${candidate.unitDigest}`,
        ...candidate.evidence.map((line) => `Evidence: ${line}`),
        ...(result === undefined ? ['Not measured yet: /learn measure'] : measurementLines(result)),
        ...(measurement === null ? [] : [`Ledger: ${measurement.ledgerPath}`]),
      ],
    })
  }
  for (const version of [...status.versions].reverse()) {
    rows.push({
      id: `${version.action}-${version.at}`,
      kind: version.action === 'promote' ? 'promoted' : 'rolled back to',
      title: version.version,
      status: version.override ? 'override' : 'measured',
      meta: version.at.slice(0, 19).replace('T', ' '),
      current: status.active === version,
      detailLines: [
        `Profile: ${version.profileDigest}`,
        `Replaced: ${version.parentDigest}`,
        `File: ${version.profilePath}`,
        `Reason: ${version.reason}`,
      ],
    })
  }
  if (status.served !== null) {
    rows.push({
      id: `served-${status.served.runId}`,
      kind: 'served',
      title: `${status.served.version} on ${status.served.runner ?? 'runtime default'}`,
      status: status.served.status,
      runId: status.served.runId,
      detailLines: [
        `Run: ${status.served.runId}`,
        `Profile version: ${status.served.version}`,
        `Profile: ${status.served.profileDigest}`,
      ],
    })
  }
  rows.push(...learnerRows(status.learner))
  return {
    title: 'Learning',
    context: `${status.tasks.length} held-out tasks · ${proposal?.candidates.length ?? 0} candidates · active ${status.active?.version ?? 'base profile'} · learner ${status.learner.active.version ?? 'default'}`,
    ...(notice === undefined ? {} : { notice }),
    emptyMessage:
      'Nothing learned yet. Mark a finished run: /learn task -- <check>, then /learn propose',
    rows,
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--'))
    throw new AppError('INVALID_PARAMS', `${name} needs a value. ${USAGE}`)
  args.splice(index, 2)
  return value
}

function positiveNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new AppError('INVALID_PARAMS', `${name} must be a positive number`)
  return parsed
}

/** `/learn` in the terminal: every action returns the learning panel. */
export async function dispatchLearningCommand(
  intent: Extract<BraidIntent, { readonly type: 'run-command' }>,
  context: LearningDispatchContext,
): Promise<UiDispatchResult> {
  const actions = await actionsFor(context)
  const [action = 'status', ...rest] = intent.args
  const args = [...rest]
  let notice: string | undefined
  if (action === 'status') {
    if (args.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
  } else if (action === 'task') {
    const separator = args.indexOf('--')
    if (separator < 0) throw new AppError('INVALID_PARAMS', `A task needs a check. ${USAGE}`)
    const check = args.splice(separator).slice(1)
    const family = flag(args, '--family')
    const timeoutSeconds = positiveNumber(flag(args, '--timeout'), '--timeout')
    if (args.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
    const task = await actions.addTask({
      check,
      ...(family === undefined ? {} : { family }),
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    })
    notice = `Task ${task.id} added from run ${task.runId}`
  } else if (action === 'propose') {
    const sinceDays = positiveNumber(flag(args, '--since'), '--since')
    if (args.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
    const proposal = await actions.propose(sinceDays === undefined ? {} : { sinceDays })
    notice = `${proposal.candidates.length} candidates proposed. /learn measure`
  } else if (action === 'measure') {
    if (args.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
    context.setNotice('Measuring candidates on held-out tasks…')
    context.notify()
    const measurement = await actions.measure({
      onProgress: (text) => {
        context.setNotice(text)
        context.notify()
      },
    })
    notice =
      measurement.selected === null
        ? 'Measured. No candidate passed the gate; the active profile stays.'
        : `Measured. ${measurement.selected} passed the gate: /learn promote`
  } else if (action === 'promote') {
    const override = args.includes('--override')
    const positional = args.filter((arg) => arg !== '--override')
    if (positional.length > 1) throw new AppError('INVALID_PARAMS', USAGE)
    const version = await actions.promote({
      operationId: intent.operationId ?? '',
      ...(positional[0] === undefined ? {} : { candidateId: positional[0] }),
      override,
    })
    notice = `Promoted ${version.version}${version.override ? ' (override)' : ''}. Rollback: /learn rollback`
  } else if (action === 'rollback') {
    if (args.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
    const version = await actions.rollback({ operationId: intent.operationId ?? '' })
    notice = `Rolled back: ${version.reason}`
  } else if (action === 'learner') {
    notice = await learnerCommand(actions, args, context)
  } else {
    throw new AppError('INVALID_PARAMS', USAGE)
  }
  if (notice !== undefined) {
    context.setNotice(notice)
    context.notify()
  }
  return {
    kind: 'accepted',
    revision: context.app.state().revision,
    data: learningDocument(actions.status(), notice),
  }
}

async function learnerCommand(
  actions: LearningActions,
  args: string[],
  context: LearningDispatchContext,
): Promise<string | undefined> {
  const [step = 'status', ...rest] = args
  const override = rest.includes('--override')
  const positional = rest.filter((arg) => arg !== '--override')
  if (step === 'status') {
    if (rest.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
    return undefined
  }
  if (step === 'measure') {
    if (rest.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
    context.setNotice('Measuring learner variants: each picks on selection tasks, then its pick replays on held-out tasks…')
    context.notify()
    const measurement = await actions.learner.measure({
      onProgress: (text) => {
        context.setNotice(text)
        context.notify()
      },
    })
    return measurement.selected === null
      ? 'Measured. No learner variant beat the active learner on held-out tasks; it stays.'
      : `Measured. Learner ${measurement.selected} beat the active learner: /learn learner promote`
  }
  if (step === 'promote') {
    if (positional.length > 1) throw new AppError('INVALID_PARAMS', USAGE)
    const version = await actions.learner.promote({
      ...(positional[0] === undefined ? {} : { variant: positional[0] }),
      override,
    })
    return `Learner ${version.version} promoted${version.override ? ' (override)' : ''}. The next /learn propose uses it. Rollback: /learn learner rollback`
  }
  if (step === 'rollback') {
    if (rest.length > 0) throw new AppError('INVALID_PARAMS', USAGE)
    const version = await actions.learner.rollback()
    return `Learner rolled back: ${version.reason}`
  }
  throw new AppError('INVALID_PARAMS', USAGE)
}

function optionalString(params: Readonly<Record<string, unknown>>, name: string) {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new AppError('INVALID_PARAMS', `${name} must be a string`)
  return value
}

/** The headless `learn` command: the same actions, structured results. */
export async function dispatchLearningHeadlessCommand(
  intent: Extract<BraidIntent, { readonly type: 'headless-command' }>,
  context: LearningDispatchContext,
): Promise<UiDispatchResult> {
  const actions = await actionsFor(context)
  const params = intent.params
  const action = optionalString(params, 'action') ?? 'status'
  const revision = () => context.app.state().revision
  switch (action) {
    case 'status':
      return { kind: 'accepted', revision: revision(), data: actions.status() }
    case 'task': {
      const check = params.check
      if (!Array.isArray(check) || check.some((item) => typeof item !== 'string'))
        throw new AppError('INVALID_PARAMS', 'learn task needs check: string[]')
      const runId = optionalString(params, 'runId')
      const family = optionalString(params, 'family')
      const timeoutSeconds = params.timeoutSeconds
      if (timeoutSeconds !== undefined && typeof timeoutSeconds !== 'number')
        throw new AppError('INVALID_PARAMS', 'timeoutSeconds must be a number')
      const task = await actions.addTask({
        check: check as string[],
        ...(runId === undefined ? {} : { runId }),
        ...(family === undefined ? {} : { family }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      })
      return { kind: 'accepted', revision: revision(), data: task }
    }
    case 'propose': {
      const sinceDays = params.sinceDays
      if (sinceDays !== undefined && typeof sinceDays !== 'number')
        throw new AppError('INVALID_PARAMS', 'sinceDays must be a number')
      const proposal = await actions.propose(sinceDays === undefined ? {} : { sinceDays })
      return { kind: 'accepted', revision: revision(), data: proposal }
    }
    case 'measure':
      return { kind: 'accepted', revision: revision(), data: await actions.measure() }
    case 'promote': {
      const candidateId = optionalString(params, 'candidateId')
      const override = params.override
      if (override !== undefined && typeof override !== 'boolean')
        throw new AppError('INVALID_PARAMS', 'override must be a boolean')
      const version = await actions.promote({
        operationId: intent.operationId ?? '',
        ...(candidateId === undefined ? {} : { candidateId }),
        ...(override === undefined ? {} : { override }),
      })
      return { kind: 'accepted', revision: revision(), data: version }
    }
    case 'rollback': {
      const version = await actions.rollback({ operationId: intent.operationId ?? '' })
      return { kind: 'accepted', revision: revision(), data: version }
    }
    case 'learner':
      return { kind: 'accepted', revision: revision(), data: await learnerHeadless(actions, params) }
    default:
      throw new AppError(
        'INVALID_PARAMS',
        'learn action must be status, task, propose, measure, promote, rollback or learner',
      )
  }
}

/** `learn` with `action: 'learner'`: `step` is status, measure, promote or rollback. */
async function learnerHeadless(
  actions: LearningActions,
  params: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const step = optionalString(params, 'step') ?? 'status'
  switch (step) {
    case 'status':
      return actions.learner.status()
    case 'measure':
      return actions.learner.measure()
    case 'promote': {
      const variant = optionalString(params, 'variant')
      const override = params.override
      if (override !== undefined && typeof override !== 'boolean')
        throw new AppError('INVALID_PARAMS', 'override must be a boolean')
      return actions.learner.promote({
        ...(variant === undefined ? {} : { variant }),
        ...(override === undefined ? {} : { override }),
      })
    }
    case 'rollback':
      return actions.learner.rollback()
    default:
      throw new AppError('INVALID_PARAMS', 'learner step must be status, measure, promote or rollback')
  }
}
