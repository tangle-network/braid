import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { BraidApplication } from '../src/app/application.js'
import {
  createBraidApplication,
  createDeterministicExecution,
  createDurableBraidApplication,
  DETERMINISTIC_PROFILE,
} from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { taskFeedbackTrajectories } from '../src/app/task-feedback.js'
import { createFeedbackDecisionId } from '../src/domain/ids.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
import { parseRequest } from '../src/views/headless/rpc-parser.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const NOW = '2026-10-07T12:00:00.000Z'

async function finish(app: BraidApplication, operationId = 'op-feedback-run'): Promise<string> {
  const sent = app.send({ operationId, text: 'Inspect the task and cite the checked result.' })
  await sent.completion
  assert.equal(app.state().runs.at(-1)?.status, 'completed')
  return sent.runId
}

async function rpc(
  app: BraidApplication,
  commands: readonly Record<string, unknown>[],
): Promise<BraidResponse[]> {
  const responses: BraidResponse[] = []
  async function* input() {
    yield `${commands.map((command, index) => JSON.stringify({ version: 1, requestId: `req-${index}`, ...command })).join('\n')}\n`
  }
  await runRpc(createApplicationUiController(app), input(), {
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
  return responses
}

test('task feedback survives encrypted restart, exact retries, and conflicting RPC input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-task-feedback-'))
  const path = join(root, 'braid.sqlite')
  const credentials = new MemoryCredentialStore()
  const options = {
    path,
    workspaceRoot: root,
    credentialStore: credentials,
    profile: DETERMINISTIC_PROFILE,
    execution: createDeterministicExecution({ chunkDelayMs: 0 }),
  }
  let durable = await createDurableBraidApplication(options)
  try {
    durable.app.initialize(root)
    await durable.app.whenDurable()
    const runId = await finish(durable.app)
    const command = {
      command: 'record_feedback',
      operationId: 'op-task-feedback',
      params: {
        runId,
        outcome: 'accept',
        reason: 'Cites the exact check; token=abc123-secret-canary',
      },
    }
    const responses = await rpc(durable.app, [
      { command: 'initialize', params: { workspace: root } },
      command,
      command,
      { ...command, params: { ...command.params, outcome: 'reject' } },
      { command: 'list_feedback', params: {} },
    ])
    const acknowledgements = responses.filter((item) => item.type === 'ack')
    const recorded = acknowledgements.find((item) => item.requestId === 'req-1')
    assert(recorded)
    assert.deepEqual(
      acknowledgements.find((item) => item.requestId === 'req-2')?.result,
      recorded.result,
    )
    assert.equal(
      responses.find((item) => item.type === 'error' && item.requestId === 'req-3')?.type,
      'error',
    )
    const first = await durable.app.feedback.list()
    assert.equal(first.length, 1)
    assert.equal(first[0]?.tags?.runner, 'pi')
    assert.equal(first[0]?.tags?.requestedModel, 'fixture/deterministic')
    assert.equal(first[0]?.tags?.profileDigest, durable.app.state().runs[0]?.receipt.profileDigest)
    assert.doesNotMatch(JSON.stringify(first), /abc123-secret-canary/u)
    assert.equal(
      (await durable.app.feedback.preferenceMemory())[0]?.sourceTrajectoryId,
      first[0]?.id,
    )
    await durable.storage.close()
    durable = await createDurableBraidApplication(options)
    assert.deepEqual(await durable.app.feedback.list(), first)
    assert.deepEqual(
      await durable.app.feedback.record({
        operationId: command.operationId,
        ...command.params,
        outcome: 'accept',
      }),
      first[0],
    )
    await assert.rejects(
      durable.app.feedback.record({
        operationId: command.operationId,
        ...command.params,
        outcome: 'reject',
      }),
      { code: 'OPERATION_CONFLICT' },
    )
    await assert.rejects(
      durable.app.feedback.record({
        operationId: command.operationId,
        ...command.params,
        outcome: 'accept',
        reason: 'Cites the exact check; token=different-secret-canary',
      }),
      { code: 'OPERATION_CONFLICT' },
    )
    const bytes = await readFile(path)
    assert(!bytes.includes(Buffer.from('abc123-secret-canary')))
    assert(!bytes.includes(Buffer.from('Cites the exact check')))
  } finally {
    await durable.storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('feedback replay preserves legacy approvals, excludes them from lessons, and freezes conversation scope', async () => {
  const clock = new FixedClock(NOW)
  const journal = new MemoryJournal(clock)
  const app = createBraidApplication({ fixture: 'deterministic', clock, journal, chunkDelayMs: 0 })
  app.initialize('/workspace')
  const runId = await finish(app)
  const recorded = await app.feedback.record({
    operationId: 'op-no-lesson',
    runId,
    outcome: 'reject',
  })
  assert.deepEqual(await app.feedback.preferenceMemory(), [])
  const events = journal.all()
  const latest = events.at(-1)
  assert(latest)
  const legacy = {
    sequence: latest.sequence + 1,
    revision: latest.revision + 1,
    occurredAt: NOW,
    event: {
      kind: 'feedback.decision.recorded' as const,
      decision: {
        id: createFeedbackDecisionId('feedback-legacy-approval'),
        conversationId: app.state().conversationId,
        category: 'approval' as const,
        chosenOption: 'allow_once',
        automated: false,
        createdAt: NOW,
      },
    },
  }
  const restored = replayEvents(initialState(DETERMINISTIC_PROFILE), [...events, legacy])
  assert.equal(restored.feedbackDecisions.length, 2)
  assert.deepEqual(taskFeedbackTrajectories(restored), [recorded])
  const duplicate = replayEvents(restored, [legacy])
  assert.deepEqual(duplicate.feedbackDecisions, restored.feedbackDecisions)
  const originalConversation = app.state().conversationId
  await app.conversations.lifecycle.create({
    operationId: 'op-new-feedback-conversation',
    title: 'Other work',
  })
  assert.deepEqual(await app.feedback.list(), [])
  assert.deepEqual(await app.feedback.list({ scope: 'workspace' }), [recorded])
  assert.deepEqual(await app.feedback.list({ conversationId: originalConversation, runId }), [
    recorded,
  ])
  await assert.rejects(app.feedback.list({ runId }), { code: 'UNKNOWN_RUN' })
})

test('feedback refuses unfinished runs and malformed requests without journaling a decision', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 20 })
  app.initialize('/workspace')
  const sent = app.send({ operationId: 'op-running-feedback', text: 'run' })
  await waitFor(async () => app.state().runs.some((run) => run.id === sent.runId))
  await assert.rejects(
    app.feedback.record({ operationId: 'op-too-early', runId: sent.runId, outcome: 'accept' }),
    { code: 'FEEDBACK_RUN_NOT_FINISHED' },
  )
  assert.equal(app.state().feedbackDecisions.length, 0)
  await sent.completion
  assert.throws(
    () =>
      parseRequest(
        JSON.stringify({
          version: 1,
          requestId: 'missing-op',
          command: 'record_feedback',
          params: { runId: sent.runId, outcome: 'accept' },
        }),
      ),
    /operationId/u,
  )
  await assert.rejects(
    app.feedback.record({
      operationId: 'op-oversize-feedback',
      runId: sent.runId,
      outcome: 'reject',
      reason: 'x'.repeat(4097),
    }),
    { code: 'INVALID_PARAMS' },
  )
})

for (const [columns, rows] of [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
] as const) {
  test(`feedback keyboard flow stays usable at ${columns}×${rows}`, async () => {
    const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 0 })
    app.initialize('/workspace')
    const runId = await finish(app)
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    let serial = 0
    const ui = new BraidTerminalApp({
      controller: createApplicationUiController(app),
      tui,
      theme: createBraidTheme(false),
      workspace: '/workspace',
      nextOperationId: () => `op-feedback-keyboard-${serial++}`,
    })
    ui.start()
    try {
      terminal.sendInput('/feedback accept Verified the source and check')
      terminal.sendInput('\r')
      await waitFor(async () => (await app.feedback.list()).length === 1)
      assert.equal((await app.feedback.list())[0]?.tags?.runId, runId)
      terminal.sendInput('/feedback list')
      terminal.sendInput('\r')
      await waitFor(async () => {
        await terminal.waitForRender()
        return terminal.getViewport().join('\n').includes('Task feedback')
      })
      terminal.sendInput('\r')
      await terminal.waitForRender()
      const screen = terminal.getViewport()
      assert(screen.join('\n').includes('accepted'))
      for (const line of screen) assert(visibleWidth(line) <= columns)
      terminal.sendInput('\u001b')
      terminal.sendInput('\u001b')
      await terminal.waitForRender()
      assert(!terminal.getViewport().join('\n').includes('Task feedback'))
    } finally {
      ui.stop()
    }
  })
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for feedback UI')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
