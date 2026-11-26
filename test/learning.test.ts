/**
 * The learning loop through the headless protocol the terminal shares.
 *
 * Invented history: three Claude Code sessions and two Codex sessions ran
 * `tidy` then `audit` from a committed skills checkout, a Codex subagent ran
 * `tidy` alone, and twelve finished Braid runs carry a check. A change ledger
 * holds what the harness hooks and CLI Bridge wrote for those sessions:
 *
 * | Session | Ledger rows | What it came to |
 * |---|---|---|
 * | Claude Code `s1` | hook: observed, a commit by the `audit` call | made a change |
 * | Claude Code `s2` | hook: observed | made none |
 * | Claude Code `s3` | none | unknown |
 * | Codex `c1` | hook: observed, a commit by its `git commit` call | made a change |
 * | Codex `c2` | CLI Bridge: observed, one `turn`, a commit placed by the turn's time window | made a change |
 * | Codex `c3`, spawned by `c1` | hook: observed | made a change, through `c1` |
 *
 * One more rollout is a dangling link, so Codex has an unreadable file.
 *
 * The walkthrough fixture's agent (shared with `--ui-fixture learning`) tidies only
 * when the profile it is given mounts `tidy`, and half of the checks need that. Braid reads every source,
 * proposes a skill, a workflow and a removal, measures them on replays at the
 * runs' commit, promotes the winner as `learn.1` with rollback, and serves a
 * new conversation on another runner whose record names the version.
 *
 * The second test measures the learner itself. Its sessions invoke `audit` and
 * `notes` more often than `tidy`, so Braid's default learner never proposes the
 * one skill the agent uses; the variant that proposes more skills picks `tidy`
 * on the selection tasks, wins on the held-out ones, and is promoted.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { readSkillFile } from '@tangle-network/agent-eval/analyst'
import { replaySearchLedgerText } from '@tangle-network/agent-eval/campaign'
import { verifyResourceProvenance } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { learningDocument } from '../src/adapters/tui/learning-dispatch.js'
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

const uuid = (n: number): string => `0000000${n}-0000-7000-8000-00000000000${n}`

/**
 * One invented Codex rollout, in the line shapes Codex 0.172 writes, as
 * agent-eval's own Codex fixtures build them. Codex has no skill tool: a shell
 * call that reads a skill's `SKILL.md` is the invocation.
 */
class Rollout {
  readonly id: string
  readonly lines: Array<Record<string, unknown>> = []
  private tick = 0
  constructor(id: string, parent: string | null = null) {
    this.id = id
    this.push('session_meta', {
      id,
      session_id: id,
      cwd: '/work/app',
      originator: 'codex_exec',
      cli_version: '0.172.0',
      source:
        parent === null ? 'exec' : { subagent: { thread_spawn: { parent_thread_id: parent } } },
      ...(parent === null ? {} : { parent_thread_id: parent, forked_from_id: parent }),
    })
    this.push('event_msg', { type: 'task_started', turn_id: `${id}-t` })
  }
  private push(type: string, payload: Record<string, unknown>): void {
    this.lines.push({
      timestamp: new Date(Date.now() - 3_000_000 + 1000 * this.tick++).toISOString(),
      type,
      payload,
    })
  }
  turn(text: string): this {
    this.push('response_item', {
      type: 'message',
      id: `msg-${this.id}-${this.tick}`,
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
    return this
  }
  /** `exec_command`: the hook sees the call's own id. */
  shell(callId: string, cmd: string, output: string): this {
    this.push('response_item', {
      type: 'function_call',
      call_id: callId,
      name: 'exec_command',
      arguments: JSON.stringify({ cmd }),
    })
    this.push('response_item', { type: 'function_call_output', call_id: callId, output })
    this.push('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 100 * this.tick,
          output_tokens: 10,
          total_tokens: 100 * this.tick + 10,
        },
        last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      },
    })
    return this
  }
  /** The first and last instants the rollout records: the window a gateway's turn row names. */
  span(): { readonly from: string; readonly to: string } {
    const at = (index: number) => Date.parse(String(this.lines.at(index)?.timestamp))
    return {
      from: new Date(at(0) - 1000).toISOString(),
      to: new Date(at(-1) + 1000).toISOString(),
    }
  }
  text(): string {
    return `${this.lines.map((line) => JSON.stringify(line)).join('\n')}\n`
  }
}

/** A change ledger row in the format the harness hooks and CLI Bridge append (agent-eval `src/skill-usage/change-ledger.ts`). */
function ledgerRow(fields: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    at: new Date(Date.now() - 2_000_000).toISOString(),
    agentId: null,
    toolUseId: null,
    remote: null,
    sha: null,
    pr: null,
    ...fields,
  })
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

test('learning reads Claude Code and Codex sessions with their change ledger, measures candidates on held-out replays, promotes a version with rollback and serves it on another runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-learning-'))
  const skills = join(root, 'skills')
  const workspace = join(root, 'workspace')
  const projects = join(root, 'projects')
  const store = join(root, 'learn')
  await repository(
    skills,
    { 'tidy/SKILL.md': TIDY, 'audit/SKILL.md': AUDIT },
    'https://github.com/example/skills.git',
  )
  await repository(workspace, { 'README.md': '# Invented workspace\n' })
  await mkdir(join(projects, '-work-app'), { recursive: true })
  for (const id of ['s1', 's2', 's3'])
    await writeFile(join(projects, '-work-app', `${id}.jsonl`), transcript(id, skills))

  const codex = join(root, 'codex-sessions')
  const day = join(codex, '2026', '11', '10')
  await mkdir(day, { recursive: true })
  const rollout = (id: string) => join(day, `rollout-2026-11-10T10-00-00-${id}.jsonl`)
  const tidyFile = join(skills, 'tidy', 'SKILL.md')
  const auditFile = join(skills, 'audit', 'SKILL.md')
  const c1 = uuid(1)
  const c2 = uuid(2)
  const c3 = uuid(3)
  const ran = (id: string) =>
    new Rollout(id)
      .turn('Invented request.')
      .shell(`call_${id}_tidy`, `sed -n '1,80p' ${tidyFile}`, TIDY)
      .shell(`call_${id}_audit`, `cat ${auditFile}`, AUDIT)
      .shell(`call_${id}_commit`, 'git commit -m tidy', '[main 1234567] tidy')
  const bridged = ran(c2)
  await writeFile(rollout(c1), ran(c1).text())
  await writeFile(rollout(c2), bridged.text())
  await writeFile(
    rollout(c3),
    new Rollout(c3, c1)
      .turn('Invented subtask.')
      .shell(`call_${c3}_tidy`, `head -40 ${tidyFile}`, TIDY)
      .text(),
  )
  await symlink(join(root, 'missing.jsonl'), rollout(uuid(9)))

  const changeLedger = join(root, 'change-ledger', 'changes.jsonl')
  const window = bridged.span()
  const bridge = (fields: Record<string, unknown>) =>
    ledgerRow({
      harness: 'codex',
      source: 'cli-bridge',
      sessionId: 'bridge-session-1',
      nativeSessionId: c2,
      turnId: 'turn-1',
      runId: 'run-1',
      turnStartedAt: window.from,
      at: window.to,
      ...fields,
    })
  await mkdir(dirname(changeLedger), { recursive: true })
  await writeFile(
    changeLedger,
    `${[
      ledgerRow({ harness: 'claude-code', sessionId: 's1', action: 'observed' }),
      ledgerRow({
        harness: 'claude-code',
        sessionId: 's1',
        action: 'commit',
        toolUseId: 'toolu_s1_1',
        remote: 'example/app',
        sha: 'a'.repeat(40),
      }),
      ledgerRow({ harness: 'claude-code', sessionId: 's2', action: 'observed' }),
      ledgerRow({ harness: 'codex', sessionId: c1, action: 'observed' }),
      ledgerRow({
        harness: 'codex',
        sessionId: c1,
        action: 'commit',
        toolUseId: `call_${c1}_commit`,
        remote: 'example/app',
        sha: 'b'.repeat(40),
      }),
      ledgerRow({ harness: 'codex', sessionId: c3, action: 'observed' }),
      bridge({ action: 'observed' }),
      bridge({
        action: 'turn',
        incomplete: null,
        headBefore: 'c'.repeat(40),
        head: 'd'.repeat(40),
      }),
      bridge({ action: 'commit', remote: 'example/app', sha: 'd'.repeat(40) }),
      'not a row',
    ].join('\n')}\n`,
  )

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
    learning: {
      directory: store,
      claudeCodeProjects: projects,
      codexSessions: codex,
      changeLedger,
    },
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
  try {
    await call(session, 'initialize', { workspace })

    // Twelve finished runs become held-out tasks: six need the skill, six pass either way.
    const node = process.execPath
    const needsTidy = [
      node,
      '-e',
      "process.exit(require('fs').readFileSync(process.env.BRAID_REPLAY_ANSWER,'utf8').startsWith('tidied')?0:1)",
    ]
    const anyAnswer = [node, '-e', "require('fs').statSync('README.md');process.exit(0)"]
    for (let index = 0; index < 12; index++) {
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

    const proposal = (await call(
      session,
      'learn',
      { action: 'propose' },
      'op-learning-propose',
    )) as LearningProposal
    assert.equal(proposal.sources.braid.tasks, 12)
    assert.deepEqual(proposal.sources.harnesses, [
      {
        harness: 'claude-code',
        sessions: 3,
        skillInvocations: 6,
        unreadable: 0,
        changes: { changed: 1, none: 1, unknown: 1 },
      },
      {
        harness: 'codex',
        sessions: 3,
        skillInvocations: 5,
        unreadable: 1,
        changes: { changed: 3, none: 0, unknown: 0 },
      },
    ])
    assert.deepEqual(proposal.sources.changeLedger, { rows: 9, malformed: 1, joinedSessions: 5 })
    const kinds = proposal.candidates.map((candidate) => candidate.kind).sort()
    assert.deepEqual(kinds, ['removal', 'skill', 'skill', 'workflow'])
    const tidy = proposal.candidates.find(
      (candidate) => candidate.kind === 'skill' && candidate.name === 'tidy',
    )
    assert(tidy !== undefined)
    const tidyRead = readSkillFile(tidyFile)
    assert(tidyRead.succeeded)
    assert.equal(tidy.unitDigest, `sha256:${tidyRead.bodySha256}`)
    // Both harnesses' invocations of the same file body are one version.
    assert.equal(
      tidy.evidence[0],
      '6 invocations in 6 sessions: 3 in 3 Claude Code sessions, 3 in 3 Codex sessions',
    )
    assert.deepEqual(tidy.changes, { changed: 4, none: 1, unknown: 1 })
    assert.equal(
      tidy.evidence[1],
      'Changes of the 6 sessions that invoked tidy: 4 made a change, 1 made none, 1 unknown',
    )
    assert.deepEqual(await verifyResourceProvenance(tidy.profile), [])
    const workflow = proposal.candidates.find((candidate) => candidate.kind === 'workflow')
    assert.equal(workflow?.name, 'tidy-then-audit')
    assert.deepEqual(workflow?.evidence, [
      '5 sessions ran tidy before audit: 3 Claude Code, 2 Codex',
      'Changes of the 5 sessions that ran tidy before audit: 3 made a change, 1 made none, 1 unknown',
    ])
    assert.equal(
      proposal.candidates.find((candidate) => candidate.kind === 'removal')?.changes,
      null,
      'a removal no session suggested has no session outcomes',
    )
    const sourcesRow = learningDocument(
      (await call(session, 'learn', { action: 'status' }, 'op-learning-sources')) as LearningStatus,
    ).rows.find((row) => row.id === 'sources')
    assert.deepEqual(sourcesRow?.detailLines.slice(1, 6), [
      'Claude Code: 3 sessions, 6 skill invocations, 0 unreadable files',
      'Claude Code changes: 1 made a change, 1 made none, 1 unknown',
      'Codex: 3 sessions, 5 skill invocations, 1 unreadable file',
      'Codex changes: 3 made a change, 0 made none, 0 unknown',
      'Change ledger: 9 rows, joined to 5 sessions; 1 line not a row',
    ])
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

    // Eval's procedure registry joins Braid's search ledger with each harness's
    // sessions and the change ledger by the skill's version, and counts what
    // the sessions came to the way Braid's evidence does.
    const cli = join(
      dirname(fileURLToPath(import.meta.resolve('@tangle-network/agent-eval'))),
      'cli.js',
    )
    interface Registry {
      sessions: { read: number; unreadable: number }
      versions: Array<{
        digest: string | null
        searches: Array<{ status: string | null }>
        cells: { count: number; passed: number }
        sessions: {
          invocations: number
          changes: { joined: number; none: number; notRecorded: number }
        }
      }>
    }
    const registry = (directory: string, ...flags: string[]): Registry =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            cli,
            'procedure-registry',
            directory,
            ...flags,
            '--change-ledger',
            changeLedger,
            '--ledger',
            measurement.ledgerPath,
            '--format',
            'json',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      ) as Registry
    const tidyIn = (read: Registry) => {
      const version = read.versions.find((item) => item.digest === tidy.unitDigest)
      assert(version !== undefined, 'the registry keys the promoted skill by its body digest')
      assert.deepEqual(
        version.searches.map((search) => search.status),
        ['selected'],
      )
      assert.equal(version.cells.count, 12)
      assert.equal(version.cells.passed, 12)
      return version.sessions
    }
    const claudeTidy = tidyIn(registry(projects))
    assert.equal(claudeTidy.invocations, 3)
    const outcomes = (changes: Registry['versions'][number]['sessions']['changes']) => [
      changes.joined,
      changes.none,
      changes.notRecorded,
    ]
    assert.deepEqual(outcomes(claudeTidy.changes), [1, 1, 1])
    const codexRegistry = registry(codex, '--harness', 'codex')
    assert.equal(codexRegistry.sessions.read, 3)
    assert.equal(codexRegistry.sessions.unreadable, 1)
    const codexTidy = tidyIn(codexRegistry)
    assert.equal(codexTidy.invocations, 3)
    assert.deepEqual(
      outcomes(codexTidy.changes),
      [3, 0, 0],
      'a subagent joins the change of the session that spawned it',
    )
    // One invocation per session here, so the registry's counts are Braid's.
    assert.deepEqual(tidy.changes, {
      changed: claudeTidy.changes.joined + codexTidy.changes.joined,
      none: claudeTidy.changes.none + codexTidy.changes.none,
      unknown: claudeTidy.changes.notRecorded + codexTidy.changes.notRecorded,
    })

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
    input.end()
    await session.completion
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
})

/** An invented workspace, skills checkout and Claude Code sessions, served by the fixture agent over headless RPC. */
async function learningHarness(names?: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'braid-learning-'))
  const skills = join(root, 'skills')
  const workspace = join(root, 'workspace')
  const projects = join(root, 'projects')
  const store = join(root, 'learn')
  // tidy carries its directory: a reference, an executable script and a binary file.
  await repository(
    skills,
    {
      'tidy/SKILL.md': TIDY,
      'tidy/references/format.md': '# Format\n\nOne change per commit.\n',
      'tidy/scripts/check.sh': '#!/bin/sh\nexit 0\n',
      'tidy/icon.png': '\u0089PNG\u0000\u0001',
      'audit/SKILL.md': AUDIT,
      'notes/SKILL.md': NOTES,
    },
    'https://github.com/example/skills.git',
  )
  await chmod(join(skills, 'tidy', 'scripts', 'check.sh'), 0o755)
  git(skills, 'add', '-A')
  git(skills, 'commit', '-q', '-m', 'executable check')
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
    // tidy mounts with its directory: the text files beside SKILL.md, pinned to the same commit.
    const tidyMount = next.candidates.find(
      (candidate) => candidate.kind === 'skill' && candidate.name === 'tidy',
    )
    assert(tidyMount !== undefined)
    assert.deepEqual(
      (tidyMount.profile.resources?.files ?? []).map((file) => [file.path, file.executable === true]),
      [
        ['.pi/skills/tidy/references/format.md', false],
        ['.pi/skills/tidy/scripts/check.sh', true],
      ],
      'siblings mount under the profile harness skill directory, executable bit kept',
    )
    assert.deepEqual(await verifyResourceProvenance(tidyMount.profile), [])
    assert(
      tidyMount.evidence.includes(
        'mounted with 2 files beside SKILL.md, each pinned to the same commit',
      ),
      tidyMount.evidence.join('\n'),
    )
    assert(tidyMount.evidence.includes('not mounted: icon.png: binary, so it has no inline form'))
    const measured = (await call(
      session,
      'learn',
      { action: 'measure' },
      'op-learner-profile-measure',
    )) as LearningMeasurement
    assert.equal(measured.procedureDigest, wider.learnerDigest)
    assert.equal(measured.selected, tidyMount.id)
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
    // Removing a skill mounted with its directory removes its files and records too.
    const removal = restored.candidates.find(
      (candidate) => candidate.kind === 'removal' && candidate.name === 'tidy',
    )
    assert(removal !== undefined, 'the promoted profile carries tidy, so tidy is a removal candidate')
    assert.deepEqual(removal.profile.resources?.files ?? [], [])
    assert.deepEqual(await verifyResourceProvenance(removal.profile), [])
  } finally {
    await close()
  }
})
