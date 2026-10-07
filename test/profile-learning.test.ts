import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import type { ExactAnalystRunEvent, ExactAnalystRunResult } from '@tangle-network/agent-eval'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import type { EvalAnalystRequest } from '../src/adapters/analysis/eval-analyst.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { AnalysisAnalyst } from '../src/app/analysis-execution-session.js'
import type { BraidApplication } from '../src/app/application.js'
import {
  createBraidApplication,
  createDeterministicExecution,
  createDurableBraidApplication,
} from '../src/app/composition.js'
import { draftProfileFromFeedback, type LearnedProfileDraft } from '../src/app/profile-learning.js'
import { runnerAdviceQuestion } from '../src/app/runner-advice.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const PROFILE = defineAgentProfile({
  name: 'Reviewed engineering profile',
  description: 'Keep the user’s tests meaningful.',
  harness: 'pi',
  model: { default: 'openai/gpt-5' },
  prompt: { instructions: ['Preserve public behavior.'] },
  metadata: { privateNote: 'PRIVATE-LEARNING-CANARY' },
})
const REASON =
  'Preserve the expected result; repair the implementation before changing an assertion.'

async function prepare(app: BraidApplication): Promise<string> {
  const sent = app.send({
    operationId: 'op-learning-run',
    text: 'Fix the Unicode implementation without weakening the test.',
  })
  await sent.completion
  await app.feedback.record({
    operationId: 'op-learning-correction',
    runId: sent.runId,
    outcome: 'reject',
    reason: REASON,
  })
  return sent.runId
}

const rpcSessions = new Map<
  BraidApplication,
  { input: PassThrough; responses: BraidResponse[]; completion: Promise<number>; serial: number }
>()

async function rpc(
  app: BraidApplication,
  commands: readonly Record<string, unknown>[],
): Promise<BraidResponse[]> {
  let session = rpcSessions.get(app)
  if (session === undefined) {
    const input = new PassThrough({ encoding: 'utf8' })
    const responses: BraidResponse[] = []
    async function* lines() {
      for await (const chunk of input) yield String(chunk)
    }
    const completion = runRpc(createApplicationUiController(app), lines(), {
      write(chunk) {
        responses.push(
          ...chunk
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as BraidResponse),
        )
        return true
      },
    })
    session = { input, responses, completion, serial: 0 }
    rpcSessions.set(app, session)
    input.write(
      `${JSON.stringify({ version: 1, requestId: 'init', command: 'initialize', params: { workspace: app.state().workspace } })}\n`,
    )
    await waitFor(async () =>
      responses.some((item) => item.type === 'ack' && item.requestId === 'init'),
    )
  }
  const offset = session.responses.length
  for (const command of commands) {
    const requestId = `req-${session.serial++}`
    session.input.write(`${JSON.stringify({ version: 1, requestId, ...command })}\n`)
    const responses = session.responses
    await waitFor(async () =>
      responses
        .slice(offset)
        .some(
          (item) => (item.type === 'ack' || item.type === 'error') && item.requestId === requestId,
        ),
    )
  }
  return session.responses.slice(offset)
}

async function closeRpc(app: BraidApplication): Promise<void> {
  const session = rpcSessions.get(app)
  if (session === undefined) return
  session.input.end()
  await session.completion
  rpcSessions.delete(app)
}

function ack(responses: readonly BraidResponse[], index = 0): unknown {
  const response = responses.filter((item) => item.type === 'ack')[index]
  assert(
    response?.type === 'ack',
    JSON.stringify(responses.filter((item) => item.type === 'error')),
  )
  return response.result
}

test('RPC learns a redacted portable profile, preserves guidance, and saves only a new file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-profile-learning-'))
  const target = join(root, 'learned.json')
  const existing = join(root, 'existing.json')
  const app = createBraidApplication({
    fixture: 'deterministic',
    profile: PROFILE,
    chunkDelayMs: 0,
  })
  app.initialize(root)
  try {
    const empty = await rpc(app, [{ command: 'learn_profile', params: {} }])
    assert(
      empty.some((item) => item.type === 'error' && item.code === 'PROFILE_LESSONS_UNAVAILABLE'),
    )
    await prepare(app)
    const draft = ack(
      await rpc(app, [{ command: 'learn_profile', params: {} }]),
    ) as LearnedProfileDraft
    assert.equal(draft.status, 'unmeasured')
    assert.equal(draft.redacted, true)
    assert.equal(draft.profile.harness, PROFILE.harness)
    assert.deepEqual(draft.profile.model, PROFILE.model)
    assert.equal(draft.profile.description, PROFILE.description)
    assert.match(draft.profile.prompt?.instructions?.join('\n') ?? '', /Preserve public behavior/u)
    assert.match(draft.profile.prompt?.instructions?.join('\n') ?? '', /repair the implementation/u)
    assert.doesNotMatch(JSON.stringify(draft), /PRIVATE-LEARNING-CANARY/u)
    await assert.rejects(access(target))
    assert.deepEqual(app.runtimeSelection.profile(), PROFILE)
    const save = {
      command: 'save_profile',
      operationId: 'op-save-learned',
      params: { ref: target, profile: draft.profile, createOnly: true },
    }
    const saved = await rpc(app, [save, save])
    ack(saved)
    assert(saved.some((item) => item.type === 'ack' && item.replayed === true))
    const loaded = defineAgentProfile(JSON.parse(await readFile(target, 'utf8')))
    assert.deepEqual(loaded, draft.profile)
    const repeated = await draftProfileFromFeedback(loaded, await app.feedback.list())
    assert.equal(
      repeated.candidateDigest,
      draft.candidateDigest,
      'relearning must replace owned guidance, not stack it',
    )
    await writeFile(existing, 'private existing bytes')
    const collision = await rpc(app, [
      { ...save, operationId: 'op-save-existing', params: { ...save.params, ref: existing } },
    ])
    assert(collision.some((item) => item.type === 'error'))
    assert.equal(await readFile(existing, 'utf8'), 'private existing bytes')
    assert.deepEqual(
      app.runtimeSelection.profile(),
      PROFILE,
      'saving a candidate must not select it',
    )
    ack(
      await rpc(app, [
        {
          command: 'select_profile',
          operationId: 'op-select-learned',
          params: { ref: relative(process.cwd(), target) },
        },
      ]),
    )
    assert.deepEqual(
      app.runtimeSelection.profile(),
      draft.profile,
      'a saved profile remains selectable through its relative file reference',
    )
  } finally {
    await closeRpc(app)
    await rm(root, { recursive: true, force: true })
  }
})

class RecordingAnalyst implements AnalysisAnalyst {
  readonly requests: EvalAnalystRequest[] = []
  list() {
    return [
      {
        id: 'advice-capture',
        description: 'Records analysis wiring, not recommendation quality',
        version: 'test',
        cost: { kind: 'deterministic' },
      },
    ]
  }
  resolveAnalystIds() {
    return ['advice-capture']
  }
  async *stream(request: EvalAnalystRequest) {
    this.requests.push(request)
    const result = {
      run_id: request.runId,
      correlation_id: 'advice-test',
      started_at: '2026-10-07T00:00:00Z',
      ended_at: '2026-10-07T00:00:01Z',
      findings: [],
      per_analyst: [],
      total_cost_usd: 0,
      execution_plan: {},
      completion: { status: 'complete' },
    } as unknown as ExactAnalystRunResult
    yield { event: { type: 'run-completed', result } as unknown as ExactAnalystRunEvent, result }
  }
}

test('runner advice freezes task evidence and replays after encrypted restart and changed state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-runner-advice-'))
  const analyst = new RecordingAnalyst()
  const options = {
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    profile: PROFILE,
    execution: createDeterministicExecution({ chunkDelayMs: 0 }),
    intelligence: { analyst },
  }
  let durable = await createDurableBraidApplication(options)
  try {
    durable.app.initialize(root)
    await durable.app.whenDurable()
    const runId = await prepare(durable.app)
    const command = {
      command: 'runner_advice',
      operationId: 'op-runner-advice',
      params: { task: 'Repair another Unicode boundary', source: 'last' },
    }
    const result = ack(await rpc(durable.app, [command])) as {
      analysis: { id: string; question: string }
      source: { digest: string }
    }
    assert.equal(analyst.requests.length, 1)
    assert.match(analyst.requests[0]?.question ?? '', /repair the implementation/u)
    assert.match(analyst.requests[0]?.question ?? '', /not an independently verified outcome/u)
    assert.doesNotMatch(JSON.stringify(analyst.requests[0]?.question), /PRIVATE-LEARNING-CANARY/u)
    await durable.app.feedback.record({
      operationId: 'op-advice-later-feedback',
      runId,
      outcome: 'accept',
      reason: 'Later correction was verified.',
    })
    await durable.app.conversations.lifecycle.create({
      operationId: 'op-advice-other-conversation',
      title: 'Other work',
    })
    await closeRpc(durable.app)
    await durable.storage.close()
    durable = await createDurableBraidApplication(options)
    const replay = ack(await rpc(durable.app, [command])) as typeof result
    assert.equal(replay.analysis.id, result.analysis.id)
    assert.equal(replay.analysis.question, result.analysis.question)
    assert.equal(replay.source.digest, result.source.digest)
    assert.equal(analyst.requests.length, 1)
    const conflict = await rpc(durable.app, [
      { ...command, params: { ...command.params, task: 'A different task' } },
    ])
    assert(
      conflict.some((item) => item.type === 'error' && item.code === 'ANALYSIS_OPERATION_CONFLICT'),
    )
    assert.equal(analyst.requests.length, 1)
    assert.equal(durable.app.runtimeSelection.profile().harness, 'pi')
    const feedback = await durable.app.feedback.list({ scope: 'workspace' })
    const firstFeedback = feedback[0]
    assert(firstFeedback)
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...firstFeedback,
      id: `feedback-long-${index}`,
      task: { intent: 'Unicode compatibility migration. '.repeat(1000) },
    }))
    const question = await runnerAdviceQuestion({
      task: 'Another migration',
      feedback: many,
      profiles: [
        {
          id: 'profile-test',
          name: 'Pi',
          runner: 'pi',
          model: 'openai/gpt-5',
          digest: 'abc',
        } as never,
      ],
    })
    assert(
      Buffer.byteLength(question) < 55_000,
      'bounded evidence keeps recommendation input cost bounded',
    )
  } finally {
    await closeRpc(durable.app)
    await durable.storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const [columns, rows] of [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
] as const) {
  test(`profile review keyboard flow saves only on Ctrl+S at ${columns}×${rows}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'braid-profile-keyboard-'))
    const target = join(root, 'learned.json')
    const app = createBraidApplication({
      fixture: 'deterministic',
      profile: PROFILE,
      chunkDelayMs: 0,
    })
    app.initialize(root)
    await prepare(app)
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    let serial = 0
    const ui = new BraidTerminalApp({
      controller: createApplicationUiController(app),
      tui,
      theme: createBraidTheme(false),
      workspace: root,
      nextOperationId: () => `op-profile-keyboard-${serial++}`,
    })
    ui.start()
    try {
      terminal.sendInput(`/profile learn ${target}`)
      terminal.sendInput('\r')
      await waitFor(async () => {
        await terminal.waitForRender()
        return terminal.getViewport().join('\n').includes('learned profile')
      })
      await assert.rejects(access(target))
      terminal.sendInput('\u001b[B')
      terminal.sendInput('\r')
      await terminal.waitForRender()
      const screen = terminal.getViewport()
      for (const line of screen) assert(visibleWidth(line) <= columns)
      assert.doesNotMatch(screen.join('\n'), /PRIVATE-LEARNING-CANARY/u)
      terminal.sendInput('\u0013')
      await waitFor(async () => {
        try {
          await access(target)
          return true
        } catch {
          return false
        }
      })
      assert.match(await readFile(target, 'utf8'), /repair the implementation/u)
      assert.deepEqual(app.runtimeSelection.profile(), PROFILE)
      terminal.sendInput('\u001b')
      terminal.sendInput('\u001b')
      await terminal.waitForRender()
      assert(!terminal.getViewport().join('\n').includes('learned profile'))
    } finally {
      ui.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for profile learning UI')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
