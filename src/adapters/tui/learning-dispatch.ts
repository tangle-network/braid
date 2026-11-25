import type { BraidApplication } from '../../app/application.js'
import { AppError } from '../../app/errors.js'
import type { LearningActions } from '../../app/learning/learning-actions.js'
import type {
  CandidateMeasurement,
  LearningConfiguration,
  LearningStatus,
} from '../../app/learning/learning-types.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { EntityBrowserDocument, EntityBrowserRow } from '../../views/tui/entity-browser.js'

const USAGE =
  '/learn [status | task [--family name] [--timeout seconds] -- <check...> | propose [--since days] | measure | promote [candidate] [--override] | rollback]'

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
      title: `Sources · last ${proposal.sources.sinceDays} days`,
      status: 'read',
      meta: `${proposal.sources.harnesses.length + 1} harnesses`,
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
      title: `Task ${task.id} · ${task.family}`,
      status: task.workspace.kind === 'git' ? 'replays at commit' : 'replays in empty dir',
      meta: `check: ${task.check.argv[0] ?? ''}`,
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
      title: `${candidate.kind} · ${candidate.name}`,
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
      kind: 'version',
      title: `${version.action === 'promote' ? 'Promoted' : 'Rolled back to'} ${version.version}`,
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
      title: `Served ${status.served.version} on ${status.served.runner ?? 'runtime default'}`,
      status: status.served.status,
      runId: status.served.runId,
      detailLines: [
        `Run: ${status.served.runId}`,
        `Profile version: ${status.served.version}`,
        `Profile: ${status.served.profileDigest}`,
      ],
    })
  }
  return {
    title: 'Learning',
    context: `${status.tasks.length} held-out tasks · ${proposal?.candidates.length ?? 0} candidates · active ${status.active?.version ?? 'base profile'}`,
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
    default:
      throw new AppError(
        'INVALID_PARAMS',
        'learn action must be status, task, propose, measure, promote or rollback',
      )
  }
}
