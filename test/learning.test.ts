/**
 * The learning loop through the headless protocol the terminal shares.
 *
 * Invented history: three Claude Code sessions ran `tidy` then `audit` from a
 * committed skills checkout, and twelve finished Braid runs carry a check. The
 * agent behind the execution port tidies only when the profile it is given
 * mounts `tidy`, and half of the checks need that. Braid reads both harnesses,
 * proposes a skill, a workflow and a removal, measures them on replays at the
 * runs' commit, promotes the winner as `learn.1` with rollback, and serves a
 * new conversation on another runner whose record names the version.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { readSkillFile } from '@tangle-network/agent-eval/analyst'
import { replaySearchLedgerText } from '@tangle-network/agent-eval/campaign'
import {
  type AgentProfile,
  defineAgentProfile,
  verifyResourceProvenance,
} from '@tangle-network/agent-interface'
import type { AgentTurnBackend } from '@tangle-network/agent-runtime/kernel'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { BraidApplication } from '../src/app/application.js'
import { createBraidApplication } from '../src/app/composition.js'
import type {
  LearningMeasurement,
  LearningProposal,
  LearningStatus,
  LearningTask,
  LearningVersion,
} from '../src/app/learning/learning-types.js'
import { AgentRuntimeExecutionPort } from '../src/adapters/runtime/agent-runtime-execution.js'
import type { ExecuteTurnInput } from '../src/ports/execution.js'
import { SystemClock } from '../src/ports/clock.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'

const TIDY = '---\nname: tidy\ndescription: Remove dead code.\n---\n\n# Tidy\n\nRemove dead code.\n'
const AUDIT = '---\nname: audit\ndescription: Review the change.\n---\n\n# Audit\n\nReview the change.\n'
const PROFILE: AgentProfile = defineAgentProfile({
  name: 'Invented learning profile',
  harness: 'pi',
  model: { default: 'fixture/learning' },
  prompt: { instructions: ['Keep public behavior.'] },
  resources: {
    skills: [{ kind: 'inline', name: 'legacy-notes', content: '# Legacy notes\n\nNothing here.' }],
  },
})

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
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true })
    await writeFile(join(path, name), content)
  }
  git(path, 'add', '-A')
  git(path, 'commit', '-q', '-m', 'fixture')
  if (remote !== undefined) git(path, 'remote', 'add', 'origin', remote)
}

/** One invented Claude Code transcript: `tidy`, then `audit`, each loaded from the checkout. */
function transcript(sessionId: string, skills: string): string {
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
  for (const [index, name] of ['tidy', 'audit'].entries()) {
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
    const body = name === 'tidy' ? '# Tidy\n\nRemove dead code.' : '# Audit\n\nReview the change.'
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

/** The invented agent: it tidies only when its profile mounts the `tidy` skill. */
async function agent(input: ExecuteTurnInput): Promise<AgentTurnBackend> {
  const tidies = (input.profile.resources?.skills ?? []).some(
    (skill) => skill.kind === 'inline' && skill.name === 'tidy',
  )
  const response = tidies ? `tidied: ${input.text}` : `untouched: ${input.text}`
  const { createExecutor } = await import('@tangle-network/agent-runtime/kernel')
  const profile: AgentProfile = {
    name: 'Invented learning agent',
    harness: 'cli-base',
    model: { default: 'fixture/learning', provider: 'fixture' },
  }
  return Object.freeze({
    kind: 'executor' as const,
    factory: createExecutor({
      backend: 'router',
      routerBaseUrl: 'https://fixture.invalid/v1',
      routerKey: 'fixture',
      complete: async () => ({
        model: 'fixture/learning',
        choices: [{ message: { content: response }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      }),
    }),
    profile,
    agentRunName: 'braid-learning-fixture',
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

test('learning reads two harnesses, measures candidates on held-out replays, promotes a version with rollback and serves it on another runner', async () => {
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

  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: PROFILE,
    clock: new SystemClock(),
    execution: new AgentRuntimeExecutionPort(agent),
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
          .runs.some(
            (run) => run.operationId === 'op-learning-next' && run.status === 'completed',
          ),
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
