/**
 * The learning loop through the headless protocol the terminal shares.
 *
 * Invented history: three Claude Code sessions ran `tidy` then `audit` from a
 * committed skills checkout, and twelve finished Braid runs carry a check. The
 * walkthrough fixture's agent (shared with `--ui-fixture learning`) tidies only
 * when the profile it is given mounts `tidy`, and half of the checks need that. Braid reads both harnesses,
 * proposes a skill, a workflow and a removal, measures them on replays at the
 * runs' commit, promotes the winner as `learn.1` with rollback, and serves a
 * new conversation on another runner whose record names the version.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readSkillFile } from '@tangle-network/agent-eval/analyst'
import { replaySearchLedgerText } from '@tangle-network/agent-eval/campaign'
import { verifyResourceProvenance } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { BraidApplication } from '../src/app/application.js'
import { createBraidApplication, createDeterministicExecution } from '../src/app/composition.js'
import type {
  LearnerMeasurement,
  LearnerStatus,
  LearningMeasurement,
  LearningProposal,
  LearningStatus,
  LearningTask,
  LearningVersion,
} from '../src/app/learning/learning-types.js'
import { SystemClock } from '../src/ports/clock.js'
import {
  LEARNING_FIXTURE_PROFILE,
  learningFixtureResponse,
} from '../src/testing/learning-fixture.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import type { EntityBrowserDocument } from '../src/views/tui/entity-browser.js'
import { runRpc } from '../src/views/headless/rpc.js'

const TIDY = '---\nname: tidy\ndescription: Remove dead code.\n---\n\n# Tidy\n\nRemove dead code.\n'
const AUDIT =
  '---\nname: audit\ndescription: Review the change.\n---\n\n# Audit\n\nReview the change.\n'
const NOTES = '---\nname: notes\ndescription: Keep notes.\n---\n\n# Notes\n\nKeep notes.\n'
const BODIES: Record<string, string> = {
  tidy: '# Tidy\n\nRemove dead code.',
  audit: '# Audit\n\nReview the change.',
  notes: '# Notes\n\nKeep notes.',
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
}

async function repository(path: string, files: Record<string, string>, remote?: string) {
  await mkdir(path, { recursive: true })
  git(path, 'init', '-q', '-b', 'main')
  // A throwaway fixture: the host's own commit hooks are not this test's subject.
  git(path, 'config', 'core.hooksPath', '/dev/null')
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true })
    await writeFile(join(path, name), content)
  }
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', 'fixture')
  if (remote !== undefined) git(path, 'remote', 'add', 'origin', remote)
}

/** One invented Claude Code transcript: each named skill in order, each loaded from the checkout. */
function transcript(sessionId: string, skills: string, names = ['tidy', 'audit']): string {
  const lines: unknown[] = []
  let previous: string | null = null
  let tick = 0
  const at = () => new Date(Date.now() - 3_600_000 + 1000 * tick++).toISOString()
  const line = (type: string, uuid: string, message: unknown, extra: object = {}) => {
    lines.push({
      parentUuid: previous,
      isSidechain: false,
      userType: 'external',
      cwd: '/work/app',
      sessionId,
      version: '0.0.0-fixture',
      type,
      uuid,
      timestamp: at(),
      message,
      ...extra,
    })
    previous = uuid
  }
  line('user', `${sessionId}-u`, { role: 'user', content: 'Invented request.' })
  for (const [index, name] of names.entries()) {
    const id = `toolu_${sessionId}_${index}`
    line('assistant', `${sessionId}-a${index}`, {
      id: `msg_${sessionId}_${index}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-20250514',
      content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: name } }],
      usage: { input_tokens: 100, output_tokens: 10 },
    })
    line('user', `${sessionId}-r${index}`, {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    })
    const body = BODIES[name] as string
    line(
      'user',
      `${sessionId}-l${index}`,
      {
        role: 'user',
        content: [
          { type: 'text', text: `Base directory for this skill: ${join(skills, name)}\n\n${body}` },
        ],
      },
      { isMeta: true, sourceToolUseID: id },
    )
  }
  return `${lines.map((item) => JSON.stringify(item)).join('\n')}\n`
}

interface Session {
  readonly input: PassThrough
  readonly responses: BraidResponse[]
  readonly completion: Promise<number>
  serial: number
}

async function until(predicate: () => boolean, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function call(
  session: Session,
  command: string,
  params: Record<string, unknown> = {},
  operationId?: string,
): Promise<unknown> {
  const requestId = `req-${session.serial++}`
  session.input.write(
    `${JSON.stringify({ version: 1, requestId, command, params, ...(operationId === undefined ? {} : { operationId }) })}\n`,
  )
  await until(
    () =>
      session.responses.some(
        (item) => (item.type === 'ack' || item.type === 'error') && item.requestId === requestId,
      ),
    command,
  )
  const response = session.responses.find(
    (item) => (item.type === 'ack' || item.type === 'error') && item.requestId === requestId,
  )
  assert(response?.type === 'ack', `${command}: ${JSON.stringify(response)}`)
  return response.result
}

async function finishRun(app: BraidApplication, text: string, operationId: string) {
  const receipt = app.send({ operationId, text })
  await receipt.completion
  return receipt.runId
}

/** An invented workspace, skills checkout and Claude Code sessions, served by the fixture agent over headless RPC. */
async function learningHarness(names?: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'braid-learning-'))
  const skills = join(root, 'skills')
  const workspace = join(root, 'workspace')
  const projects = join(root, 'projects')
  const store = join(root, 'learn')
  await repository(
    skills,
    { 'tidy/SKILL.md': TIDY, 'audit/SKILL.md': AUDIT, 'notes/SKILL.md': NOTES },
    'https://github.com/example/skills.git',
  )
  await repository(workspace, { 'README.md': '# Invented workspace\n' })
  await mkdir(join(projects, '-work-app'), { recursive: true })
  for (const id of ['s1', 's2', 's3'])
    await writeFile(join(projects, '-work-app', `${id}.jsonl`), transcript(id, skills, names))

  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: LEARNING_FIXTURE_PROFILE,
    clock: new SystemClock(),
    execution: createDeterministicExecution({ chunkDelayMs: 0, respond: learningFixtureResponse }),
  })
  app.initialize(workspace)
  const input = new PassThrough({ encoding: 'utf8' })
  const responses: BraidResponse[] = []
  async function* lines() {
    for await (const chunk of input) yield String(chunk)
  }
  const controller = createApplicationUiController(app, {}, undefined, {
    learning: { directory: store, claudeCodeProjects: projects },
  })
  const session: Session = {
    input,
    responses,
    serial: 0,
    completion: runRpc(controller, lines(), {
      write(chunk) {
        responses.push(
          ...chunk
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as BraidResponse),
        )
        return true
      },
    }),
  }
  return {
    root,
    skills,
    workspace,
    projects,
    app,
    controller,
    session,
    async close() {
      input.end()
      await session.completion
      await app.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

/** Finished runs become held-out tasks: even ones need the skill, odd ones pass either way. */
async function addTasks(app: BraidApplication, session: Session, count: number): Promise<void> {
  const node = process.execPath
  const needsTidy = [
    node,
    '-e',
    "process.exit(require('fs').readFileSync(process.env.BRAID_REPLAY_ANSWER,'utf8').startsWith('tidied')?0:1)",
  ]
  const anyAnswer = [node, '-e', "require('fs').statSync('README.md');process.exit(0)"]
  for (let index = 0; index < count; index++) {
    const runId = await finishRun(app, `Invented task ${index}`, `op-learning-run-${index}`)
    const task = (await call(
      session,
      'learn',
      {
        action: 'task',
        runId,
        check: index % 2 === 0 ? needsTidy : anyAnswer,
        family: index % 2 === 0 ? 'cleanup' : 'reading',
      },
      `op-learning-task-${index}`,
    )) as LearningTask
    assert.equal(task.workspace.kind, 'git', 'a run in a repository replays at its commit')
  }
}

test('learning reads two harnesses, measures candidates on held-out replays, promotes a version with rollback and serves it on another runner', async () => {
  const { skills, workspace, projects, app, session, close } = await learningHarness()
  try {
    await call(session, 'initialize', { workspace })

    // Twelve finished runs become held-out tasks: six need the skill, six pass either way.
    await addTasks(app, session, 12)

    const proposal = (await call(
      session,
      'learn',
      { action: 'propose' },
      'op-learning-propose',
    )) as LearningProposal
    assert.equal(proposal.sources.braid.tasks, 12)
    assert.deepEqual(
      proposal.sources.harnesses.map((source) => [source.harness, source.sessions]),
      [['claude-code', 3]],
    )
    const kinds = proposal.candidates.map((candidate) => candidate.kind).sort()
    assert.deepEqual(kinds, ['removal', 'skill', 'skill', 'workflow'])
    const tidy = proposal.candidates.find(
      (candidate) => candidate.kind === 'skill' && candidate.name === 'tidy',
    )
    assert(tidy !== undefined)
    const tidyFile = readSkillFile(join(skills, 'tidy', 'SKILL.md'))
    assert(tidyFile.succeeded)
    assert.equal(tidy.unitDigest, `sha256:${tidyFile.bodySha256}`)
    assert.deepEqual(await verifyResourceProvenance(tidy.profile), [])
    const workflow = proposal.candidates.find((candidate) => candidate.kind === 'workflow')
    assert.equal(workflow?.name, 'tidy-then-audit')
    assert(tidy.loadedTokens > proposal.baseLoadedTokens)

    const measurement = (await call(
      session,
      'learn',
      { action: 'measure' },
      'op-learning-measure',
    )) as LearningMeasurement
    const result = (id: string) => {
      const found = measurement.results.find((item) => item.candidateId === id)
      assert(found !== undefined, id)
      return found
    }
    const tidyResult = result(tidy.id)
    assert.equal(tidyResult.decision, 'keep', tidyResult.reason)
    assert.equal(tidyResult.wins, 6)
    assert.equal(tidyResult.losses, 0)
    assert.equal(tidyResult.base.worstFamily?.family, 'cleanup')
    assert.equal(tidyResult.base.worstFamily?.passed, 0)
    assert.equal(tidyResult.candidate.worstFamily?.rate, 1)
    assert.equal(tidyResult.gate.promotable, true, tidyResult.gate.reason)
    const audit = proposal.candidates.find((candidate) => candidate.name === 'audit')
    assert(audit !== undefined)
    const auditResult = result(audit.id)
    assert.notEqual(auditResult.decision, 'keep', 'a skill the agent ignores earns no keep')
    assert.equal(auditResult.gate.promotable, false)
    assert.equal(measurement.selected, tidy.id, 'the winner holds success at the fewest tokens')

    const ledger = await readFile(measurement.ledgerPath, 'utf8')
    const state = replaySearchLedgerText(ledger, measurement.searchId, measurement.ledgerPath)
    assert.notEqual(state.closed, null)
    const nodes = state.nodes()
    assert.equal(nodes.length, proposal.candidates.length + 1)
    assert.equal(nodes.filter((item) => item.status === 'selected').length, 1)
    assert(nodes.some((item) => item.artifactDigest === tidy.unitDigest))

    // Eval's procedure registry joins the ledger with the Claude Code sessions by the skill's version.
    const cli = join(
      dirname(fileURLToPath(import.meta.resolve('@tangle-network/agent-eval'))),
      'cli.js',
    )
    const registry = JSON.parse(
      execFileSync(
        process.execPath,
        [
          cli,
          'procedure-registry',
          projects,
          '--ledger',
          measurement.ledgerPath,
          '--format',
          'json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ),
    ) as {
      versions: Array<{
        digest: string | null
        searches: Array<{ status: string | null }>
        cells: { count: number; passed: number }
        sessions: { invocations: number }
      }>
    }
    const tidyVersion = registry.versions.find((version) => version.digest === tidy.unitDigest)
    assert(tidyVersion !== undefined, 'the registry keys the promoted skill by its body digest')
    assert.equal(tidyVersion.sessions.invocations, 3)
    assert.deepEqual(
      tidyVersion.searches.map((search) => search.status),
      ['selected'],
    )
    assert.equal(tidyVersion.cells.count, 12)
    assert.equal(tidyVersion.cells.passed, 12)

    const first = (await call(
      session,
      'learn',
      { action: 'promote' },
      'op-learning-promote-1',
    )) as LearningVersion
    assert.equal(first.version, 'learn.1')
    assert.equal(first.override, false)
    assert.equal(app.runtimeSelection.profile().version, 'learn.1')
    const back = (await call(
      session,
      'learn',
      { action: 'rollback' },
      'op-learning-rollback',
    )) as LearningVersion
    assert.equal(back.action, 'rollback')
    assert.equal(app.runtimeSelection.profile().version, undefined)
    assert.deepEqual(
      (app.runtimeSelection.profile().resources?.skills ?? []).map((skill) =>
        skill.kind === 'inline' ? skill.name : '',
      ),
      ['legacy-notes'],
    )
    const second = (await call(
      session,
      'learn',
      { action: 'promote' },
      'op-learning-promote-2',
    )) as LearningVersion
    assert.equal(second.version, 'learn.2')

    // The next session: a new conversation on another runner, served by the promoted version.
    await call(session, 'new_conversation', { title: 'Next session' }, 'op-learning-new')
    await call(session, 'set_run_override', { runner: 'codex' }, 'op-learning-runner')
    await call(session, 'send', { text: 'Invented follow-up task' }, 'op-learning-next')
    await until(
      () =>
        app
          .state()
          .runs.some((run) => run.operationId === 'op-learning-next' && run.status === 'completed'),
      'the served run',
    )
    const status = (await call(
      session,
      'learn',
      { action: 'status' },
      'op-learning-status',
    )) as LearningStatus
    assert.equal(status.served?.version, 'learn.2')
    assert.equal(status.served?.runner, 'codex')
    assert.equal(status.active?.version, 'learn.2')
    assert.deepEqual(
      status.versions.map((version) => [version.action, version.version]),
      [
        ['promote', 'learn.1'],
        ['rollback', 'unversioned'],
        ['promote', 'learn.2'],
      ],
    )
  } finally {
    await close()
  }
})

test('the learner is a versioned profile: a variant whose pick wins on held-out tasks is promoted, drives the next proposal and rolls back', async () => {
  // Each session runs audit and notes twice and tidy once, so the default learner's two skill
  // candidates are the two the agent ignores, and only a learner that proposes more finds tidy.
  const { app, controller, session, workspace, close } = await learningHarness([
    'audit',
    'notes',
    'audit',
    'notes',
    'tidy',
  ])
  const skillNames = (proposal: LearningProposal) =>
    proposal.candidates
      .filter((candidate) => candidate.kind === 'skill')
      .map((candidate) => candidate.name)
      .sort()
  try {
    await call(session, 'initialize', { workspace })
    await addTasks(app, session, 24)

    const before = (await call(
      session,
      'learn',
      { action: 'learner', step: 'status' },
      'op-learner-status-0',
    )) as LearnerStatus
    assert.equal(before.active.version, null, "Braid's default learner is active")
    assert.equal(before.settings.candidates.maxSkills, 2)
    const first = (await call(
      session,
      'learn',
      { action: 'propose' },
      'op-learner-propose-0',
    )) as LearningProposal
    assert.deepEqual(first.learner, before.active)
    assert.deepEqual(skillNames(first), ['audit', 'notes'])

    const round = (await call(
      session,
      'learn',
      { action: 'learner', step: 'measure' },
      'op-learner-measure',
    )) as LearnerMeasurement
    assert.equal(round.selectionTasks.length, 12)
    assert.equal(round.heldOutTasks.length, 12)
    assert.equal(
      new Set([...round.selectionTasks, ...round.heldOutTasks]).size,
      24,
      'no task both picks and judges',
    )
    assert.deepEqual(
      round.arms.map((arm) => arm.name),
      [
        'active',
        'skills-4',
        'without-skill',
        'without-workflow',
        'without-instructions',
        'without-removal',
      ],
    )
    const arm = (name: string) => {
      const found = round.arms.find((item) => item.name === name)
      assert(found !== undefined, name)
      return found
    }
    const active = arm('active')
    assert.equal(active.pick.kind, 'removal', "the default learner's best pick only compresses")
    assert.equal(active.heldOut.worstFamily?.family, 'cleanup')
    assert.equal(active.heldOut.worstFamily?.passed, 0)
    const wider = arm('skills-4')
    assert.equal(wider.pick.name, 'tidy')
    assert.equal(wider.heldOut.known, 12)
    assert.equal(wider.heldOut.worstFamily?.rate, 1)
    assert.equal(wider.gate.promotable, true, wider.gate.reason)
    for (const other of round.arms.slice(2))
      assert.equal(other.gate.promotable, false, `${other.name}: ${other.gate.reason}`)
    assert.equal(round.selected, 'skills-4')

    // The round is an Eval search ledger whose artifacts are learner profiles.
    const state = replaySearchLedgerText(
      await readFile(round.ledgerPath, 'utf8'),
      round.searchId,
      round.ledgerPath,
    )
    assert.notEqual(state.closed, null)
    const nodes = state.nodes()
    assert.equal(nodes.length, round.arms.length)
    assert.deepEqual(
      nodes.filter((node) => node.status === 'selected').map((node) => node.artifactDigest),
      [wider.learnerDigest],
    )

    // The terminal shows the round.
    const panel = await controller.dispatch({
      type: 'run-command',
      command: 'learn',
      args: ['learner'],
      operationId: 'op-learner-panel',
    })
    assert(panel.kind === 'accepted')
    const rows = (panel.data as EntityBrowserDocument).rows
    assert.equal(
      rows.find((row) => row.current === true && row.kind === 'learner variant')?.title,
      'skills-4',
    )

    const promoted = (await call(
      session,
      'learn',
      { action: 'learner', step: 'promote' },
      'op-learner-promote',
    )) as LearningVersion
    assert.equal(promoted.version, 'learner.1')
    assert.equal(promoted.candidateId, 'skills-4')
    assert.equal(promoted.override, false)
    assert.equal(
      app.runtimeSelection.profile().version,
      undefined,
      'a learner version changes how Braid learns, not the profile it serves',
    )

    // The promoted learner proposes the skill the default one never reached; its pick is measured and served.
    const next = (await call(
      session,
      'learn',
      { action: 'propose' },
      'op-learner-propose-1',
    )) as LearningProposal
    assert.deepEqual(next.learner, { version: 'learner.1', digest: wider.learnerDigest })
    assert.deepEqual(skillNames(next), ['audit', 'notes', 'tidy'])
    const measured = (await call(
      session,
      'learn',
      { action: 'measure' },
      'op-learner-profile-measure',
    )) as LearningMeasurement
    assert.equal(measured.procedureDigest, wider.learnerDigest)
    const tidy = next.candidates.find(
      (candidate) => candidate.kind === 'skill' && candidate.name === 'tidy',
    )
    assert.equal(measured.selected, tidy?.id)
    const learned = (await call(
      session,
      'learn',
      { action: 'promote' },
      'op-learner-profile-promote',
    )) as LearningVersion
    assert.equal(learned.version, 'learn.1')
    assert.deepEqual(learned.learner, next.learner, 'the profile version names its learner')

    const back = (await call(
      session,
      'learn',
      { action: 'learner', step: 'rollback' },
      'op-learner-rollback',
    )) as LearningVersion
    assert.equal(back.version, 'default')
    const after = (await call(
      session,
      'learn',
      { action: 'learner', step: 'status' },
      'op-learner-status-1',
    )) as LearnerStatus
    assert.deepEqual(after.active, before.active)
    assert.deepEqual(
      after.versions.map((version) => [version.action, version.version]),
      [
        ['promote', 'learner.1'],
        ['rollback', 'default'],
      ],
    )
    const restored = (await call(
      session,
      'learn',
      { action: 'propose' },
      'op-learner-propose-2',
    )) as LearningProposal
    assert.deepEqual(restored.learner, before.active)
  } finally {
    await close()
  }
})
