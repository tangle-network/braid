import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExactAnalystRunEvent, ExactAnalystRunResult } from '@tangle-network/agent-eval'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import {
  AgentEvalAnalystAdapter,
  type AnalystRegistryPort,
} from '../src/adapters/analysis/eval-analyst.js'
import { AgentRuntimeExecutionPort } from '../src/adapters/runtime/agent-runtime-execution.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { freezeAnalysisSource } from '../src/app/analysis-source.js'
import { BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { createMemoryJournal } from '../src/app/journal.js'
import { FixedClock } from '../src/ports/clock.js'
import { SequenceIds } from '../src/ports/ids.js'
import { deterministicBackend } from '../src/testing/deterministic-backend.js'
import type { BraidResponse } from '../src/views/headless/protocol.js'
import { runRpc } from '../src/views/headless/rpc.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const NOW = '2026-08-03T20:00:00.000Z'

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for intelligence result')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function registry(): AnalystRegistryPort {
  const runExactStream: AnalystRegistryPort['runExactStream'] = async function* (
    runId,
    _inputs,
    options,
  ): AsyncGenerator<ExactAnalystRunEvent, void, void> {
    yield {
      type: 'run-started',
      run_id: runId,
      correlation_id: 'correlation-braid-test',
      started_at: NOW,
      analyst_ids: options.analystIds,
      execution_plan: {},
    } as unknown as ExactAnalystRunEvent
    const result = {
      run_id: runId,
      correlation_id: 'correlation-braid-test',
      started_at: NOW,
      ended_at: NOW,
      findings: [],
      per_analyst: [],
      total_cost_usd: 0,
      execution_plan: {},
      completion: { status: 'complete' },
    } as unknown as ExactAnalystRunResult
    yield { type: 'run-completed', result } as unknown as ExactAnalystRunEvent
  }
  return {
    list: () => [
      {
        id: 'efficiency-behavioral',
        description: 'deterministic Braid test analyst',
        version: 'test',
        cost: { kind: 'deterministic' },
      },
    ],
    runExactStream,
  }
}

function createTestApplication(): BraidApplication {
  const clock = new FixedClock(NOW)
  const journal = createMemoryJournal(clock)
  return new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: new AgentRuntimeExecutionPort(
      (input) => deterministicBackend(input),
      async () => ({ status: 'cancelled' as const }),
      { admissionMode: 'sync' },
    ),
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    intelligence: { analyst: new AgentEvalAnalystAdapter(registry()) },
  })
}

async function createCompletedRun(app: BraidApplication, text: string): Promise<string> {
  app.initialize('/workspace')
  const receipt = app.send({
    operationId: `op-send-${text.replace(/[^A-Za-z0-9_-]/gu, '-')}`,
    text,
  })
  await receipt.completion
  const runId = app.state().runs.at(-1)?.id
  assert(runId)
  return runId
}

function resultFor<T>(responses: readonly BraidResponse[], requestId: string): T {
  const response = responses.find(
    (candidate) => candidate.type === 'ack' && candidate.requestId === requestId,
  )
  assert(response && response.type === 'ack', `missing acknowledgement for ${requestId}`)
  assert.notEqual(response.result, undefined, `missing result for ${requestId}`)
  return response.result as T
}

test('Braid exposes analysis actions through the TUI controller without creating a chat message', async () => {
  const app = createTestApplication()
  const runId = await createCompletedRun(app, 'source run')
  const beforeMessages = app.state().messages
  const controller = createApplicationUiController(app)
  const result = await controller.dispatch({
    type: 'run-command',
    command: 'ask',
    operationId: 'op-analysis-ask-tui',
    args: ['why', 'did', 'this', 'finish'],
  })

  assert.equal(result.kind, 'accepted')
  assert.ok(app.intelligence.analysis)
  assert.equal(app.state().messages.length, beforeMessages.length)
  assert.equal(app.state().analyses.length, 1)
  assert.equal(app.state().analyses[0]?.source.runId, runId)
  if (result.kind === 'accepted') {
    const data = result.data as {
      readonly status: string
      readonly analysis: { readonly question?: string }
    }
    assert.equal(data.status, 'completed')
    assert.equal(data.analysis.question, 'why did this finish')
  }
  assert.deepEqual(
    app
      .events()
      .map((envelope) => envelope.event.kind)
      .filter((kind) => kind.startsWith('analysis.')),
    ['analysis.created', 'analysis.updated', 'analysis.completed'],
  )
  await app.close()
})

test('the terminal opens saved ask and comparison results instead of reducing them to notices', async () => {
  const app = createTestApplication()
  const baselineRunId = await createCompletedRun(app, 'terminal baseline')
  const candidateRunId = await createCompletedRun(app, 'terminal candidate')
  const controller = createApplicationUiController(app)
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TuiMainScreen(terminal)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-intelligence-ui-${++operation}`,
  })
  const done = view.start()

  terminal.sendInput('/ask why did this finish')
  terminal.sendInput('\r')
  await waitUntil(() => app.state().analyses.length === 1)
  await terminal.waitForRender()
  const askScreen = terminal.getViewport().join('\n')
  assert.match(askScreen, /\/ask · frozen question/u)
  assert.match(askScreen, /source:[^\n]+frozen/u)
  assert.match(askScreen, /No findings were returned/u)

  terminal.sendInput('\u001b')
  terminal.sendInput(`/compare ${baselineRunId} ${candidateRunId}`)
  terminal.sendInput('\r')
  await waitUntil(() => app.state().analyses.length === 2)
  await terminal.waitForRender()
  const comparisonScreen = terminal.getViewport().join('\n')
  assert.match(comparisonScreen, /\/compare · frozen runs/u)
  assert.match(comparisonScreen, new RegExp(`baseline run: ${baselineRunId}`, 'u'))
  assert.match(comparisonScreen, new RegExp(`candidate run: ${candidateRunId}`, 'u'))
  assert.match(comparisonScreen, /sample: 1 paired/u)

  view.stop()
  await done
  await app.close()
})

test('JSONL ask and named analysis return final data and preserve progress events', async () => {
  const app = createTestApplication()
  const responses: BraidResponse[] = []
  async function* input(): AsyncGenerator<string> {
    yield `${JSON.stringify({
      version: 1,
      requestId: 'initialize',
      command: 'initialize',
      params: { workspace: '/workspace', subscribe: true },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'send',
      operationId: 'op-send-jsonl',
      command: 'send',
      params: { text: 'source run' },
    })}\n`
    await app.waitForIdle()
    const runId = app.state().runs.at(-1)?.id
    assert(runId)
    yield `${JSON.stringify({
      version: 1,
      requestId: 'ask',
      operationId: 'op-analysis-ask-jsonl',
      command: 'ask',
      params: { source: runId, question: 'why did this finish' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'analyze',
      operationId: 'op-analysis-recipe-jsonl',
      command: 'analyze',
      params: { source: runId, recipe: 'cost' },
    })}\n`
    yield `${JSON.stringify({
      version: 1,
      requestId: 'shutdown',
      operationId: 'op-shutdown-jsonl',
      command: 'shutdown',
    })}\n`
  }

  const code = await runRpc(createApplicationUiController(app), input(), {
    write: (chunk) => {
      responses.push(JSON.parse(chunk) as BraidResponse)
      return true
    },
  })

  assert.equal(code, 0)
  assert.equal(resultFor<{ readonly status: string }>(responses, 'ask').status, 'completed')
  assert.equal(resultFor<{ readonly status: string }>(responses, 'analyze').status, 'completed')
  assert.equal(app.state().messages.length, 2)
  assert.deepEqual(
    app
      .events()
      .map((envelope) => envelope.event.kind)
      .filter((kind) => kind === 'analysis.created' || kind === 'analysis.completed').length,
    4,
  )
  assert.ok(
    responses.some(
      (response) =>
        response.type === 'event' &&
        (response.event.kind === 'analysis.created' ||
          response.event.kind === 'analysis.completed'),
    ),
  )
  await app.close()
})

test('headless compare freezes two run sources without dispatching a chat message', async () => {
  const app = createTestApplication()
  const baselineRunId = await createCompletedRun(app, 'baseline run')
  const candidateRunId = await createCompletedRun(app, 'candidate run')
  const beforeMessages = app.state().messages.length
  const controller = createApplicationUiController(app)
  const result = await controller.dispatch({
    type: 'headless-command',
    command: 'compare',
    operationId: 'op-analysis-compare',
    params: { left: baselineRunId, right: candidateRunId },
  })

  assert.equal(result.kind, 'accepted')
  assert.equal(app.state().messages.length, beforeMessages)
  assert.equal(app.state().analyses.length, 1)
  assert.equal(app.state().analyses[0]?.kind, 'comparison')
  assert.equal(app.state().analyses[0]?.status, 'completed')
  if (result.kind === 'accepted') {
    const data = result.data as {
      readonly baselineRunId: string
      readonly candidateRunId: string
      readonly semantic: { readonly status: string }
    }
    assert.equal(data.baselineRunId, baselineRunId)
    assert.equal(data.candidateRunId, candidateRunId)
    assert.equal(data.semantic.status, 'unavailable')
  }
  assert.deepEqual(
    app
      .events()
      .map((envelope) => envelope.event.kind)
      .filter((kind) => kind.startsWith('analysis.')),
    ['analysis.created', 'analysis.completed'],
  )
  await app.close()
})

test('analysis source includes inherited messages on a forked branch', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  const parentRunId = await createCompletedRun(app, 'parent message')
  const parentAssistant = app
    .state()
    .messages.find((message) => message.role === 'assistant' && message.runId === parentRunId)
  assert(parentAssistant)
  const parentConversationId = app.state().conversationId
  const parentBranchId = app.state().branchId
  const child = await app.conversations.branches.create({
    operationId: 'op-branch-analysis-regression',
    conversationId: parentConversationId,
    branchId: parentBranchId,
    throughMessageId: parentAssistant.id,
  })
  const childReceipt = app.send({ operationId: 'op-send-child-message', text: 'child message' })
  await childReceipt.completion

  const evidence = freezeAnalysisSource({
    state: app.state(),
    events: app.events(),
    conversationId: parentConversationId,
    branchId: child.id,
    runId: childReceipt.runId,
  })
  assert.deepEqual(
    evidence.messages.map((message) => message.text),
    [
      'parent message',
      'Fixture response through pi: parent message',
      'child message',
      'Fixture response through pi: child message',
    ],
  )
  await app.close()
})

test('worker cancellation reports the runtime limitation instead of fabricating success', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  const result = await controller.dispatch({
    type: 'headless-command',
    command: 'cancel_worker',
    operationId: 'op-cancel-worker',
    params: { supervisorId: 'runtime-supervisor', workerId: 'runtime-worker' },
  })

  assert.equal(result.kind, 'unavailable')
  if (result.kind === 'unavailable') assert.match(result.reason, /supervisor\.worker\.cancel/u)
  assert.equal(app.state().supervisors.length, 0)
  await app.close()
})
