import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import type { ExactAnalystRunEvent, ExactAnalystRunResult } from '@tangle-network/agent-eval'
import {
  AgentEvalAnalystAdapter,
  type AnalystRegistryPort,
} from '../src/adapters/analysis/eval-analyst.js'
import { BRAID_QUESTION_ANALYST_ID } from '../src/adapters/analysis/question-analyst.js'
import { AgentRuntimeExecutionPort } from '../src/adapters/runtime/agent-runtime-execution.js'
import { RuntimeSupervisorController } from '../src/adapters/runtime/supervisor-control.js'
import {
  RuntimeSupervisorWatcher,
  type TopSnapshot,
} from '../src/adapters/runtime/supervisor-watch.js'
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
import { analysisLines } from '../src/views/shared/analysis-presentation.js'
import { queryGraph } from '../src/views/shared/semantic-graph.js'
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
    const analystId = options.analystIds[0] ?? 'efficiency-behavioral'
    const summary = {
      analyst_id: analystId,
      status: 'ok',
      findings_count: 0,
      latency_ms: 1,
      usage: {
        calls: 0,
        tokens: null,
        cost: { kind: 'known', usd: 0 },
        knownCostUsd: 0,
      },
    } as const
    yield {
      type: 'analyst-started',
      analyst_id: analystId,
      started_at: NOW,
    } as unknown as ExactAnalystRunEvent
    yield {
      type: 'analyst-completed',
      findings: [],
      summary,
    } as unknown as ExactAnalystRunEvent
    const result = {
      run_id: runId,
      correlation_id: 'correlation-braid-test',
      started_at: NOW,
      ended_at: NOW,
      findings: [],
      per_analyst: [summary],
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
      {
        id: BRAID_QUESTION_ANALYST_ID,
        description: 'Braid question test analyst',
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

function supervisionSnapshot(
  workers: readonly {
    readonly id: string
    readonly label: string
    readonly parent?: string
    readonly status?: 'running' | 'done'
  }[],
  generatedAt = Date.parse(NOW),
  supervisorId = 'runtime-supervisor-live',
): TopSnapshot {
  const spend = { iterations: 1, tokensInput: 2, tokensOutput: 3, usd: 0.01, ms: 4 }
  return {
    root: '/workspace',
    generatedAt,
    supervisors: [
      {
        id: supervisorId,
        status: workers.every((worker) => worker.status === 'done') ? 'completed' : 'running',
        task: 'build Braid',
        workspaceDir: '/workspace',
        budget: 1,
        stateDir: '/workspace/.agent',
        workers: workers.map((worker) => ({
          id: worker.id,
          label: worker.label,
          status: worker.status ?? 'running',
          ...(worker.parent === undefined ? {} : { parent: worker.parent }),
          latencyMs: 4,
          spend,
          metered: spend,
          liveTail: [`${worker.label} progress`],
        })),
        progressTail: [],
        journalTail: [],
        driverSpend: spend,
        totals: {
          workers: workers.length,
          running: workers.filter((worker) => worker.status !== 'done').length,
          done: workers.filter((worker) => worker.status === 'done').length,
          down: 0,
          cancelled: 0,
          inFlight: workers.filter((worker) => worker.status !== 'done').length,
          settled: workers.filter((worker) => worker.status === 'done').length,
          tokensInput: workers.length * 2,
          tokensOutput: workers.length * 3,
          tokensTotal: workers.length * 5,
          usd: workers.length * 0.01,
          latencyMs: workers.length * 4,
          workerLatency: { n: workers.length, min: 4, median: 4, p90: 4, max: 4 },
        },
      },
    ],
  } as unknown as TopSnapshot
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
      readonly analysis: { readonly id: string; readonly question?: string }
    }
    assert.equal(data.status, 'completed')
    assert.equal(data.analysis.question, 'why did this finish')
    assert.equal(
      controller.view().activity.some((item) => item.id === `analysis:${data.analysis.id}`),
      true,
    )
  }
  assert.deepEqual(
    app
      .events()
      .map((envelope) => envelope.event.kind)
      .filter((kind) => kind.startsWith('analysis.')),
    [
      'analysis.created',
      'analysis.updated',
      'analysis.updated',
      'analysis.updated',
      'analysis.completed',
    ],
  )
  await app.close()
})

test('runtime supervisors stay unbound until each runtime id is explicitly assigned to a run', async () => {
  const firstSnapshot = supervisionSnapshot(
    [{ id: 'runtime-worker-one', label: 'worker-one' }],
    Date.parse(NOW),
    'runtime-supervisor-one',
  )
  const secondSnapshot = supervisionSnapshot(
    [{ id: 'runtime-worker-two', label: 'worker-two' }],
    Date.parse(NOW),
    'runtime-supervisor-two',
  )
  const firstSupervisor = firstSnapshot.supervisors[0]
  const secondSupervisor = secondSnapshot.supervisors[0]
  assert(firstSupervisor && secondSupervisor)
  let raw: TopSnapshot = {
    ...firstSnapshot,
    supervisors: [firstSupervisor, secondSupervisor],
  }
  const watcher = new RuntimeSupervisorWatcher(() => raw)
  const app = createBraidApplication({
    fixture: 'deterministic',
    intelligence: { supervisorWatcher: watcher },
  })
  const firstRunId = await createCompletedRun(app, 'first supervised run')
  const secondRunId = await createCompletedRun(app, 'second supervised run')

  const unbound = await app.intelligence.supervisor.snapshot({ rootDir: '/workspace' })
  assert.equal(unbound.supervisors.length, 2)
  assert.equal(
    unbound.supervisors.every((record) => record.rootRunId === undefined),
    true,
  )

  const bound = await app.intelligence.supervisor.snapshot({
    rootDir: '/workspace',
    bindings: [
      { runtimeSupervisorId: 'runtime-supervisor-one', rootRunId: firstRunId },
      { runtimeSupervisorId: 'runtime-supervisor-two', rootRunId: secondRunId },
    ],
  })
  assert.deepEqual(
    new Map(bound.supervisors.map((record) => [record.runtimeId, record.rootRunId])),
    new Map([
      ['runtime-supervisor-one', firstRunId],
      ['runtime-supervisor-two', secondRunId],
    ]),
  )

  raw = { ...raw, supervisors: [...raw.supervisors].reverse() }
  const refreshed = await app.intelligence.supervisor.snapshot({ rootDir: '/workspace' })
  assert.deepEqual(
    new Map(refreshed.supervisors.map((record) => [record.runtimeId, record.rootRunId])),
    new Map([
      ['runtime-supervisor-two', secondRunId],
      ['runtime-supervisor-one', firstRunId],
    ]),
  )
  assert.equal(
    app.state().supervisors.filter((record) => record.rootRunId === firstRunId).length,
    1,
  )
  assert.equal(
    app.state().supervisors.filter((record) => record.rootRunId === secondRunId).length,
    1,
  )
  await app.close()
})

test('supervisor controls resolve public ids and preserve retry-safe operation ids', async () => {
  const raw = supervisionSnapshot([{ id: 'runtime-worker-control', label: 'worker-control' }])
  const watcher = new RuntimeSupervisorWatcher(() => raw)
  let writeInput:
    | {
        readonly rootDir: string
        readonly supervisorId: string
        readonly worker: string
        readonly operationId: string
        readonly message: string
      }
    | undefined
  let workerCancelInput:
    | { readonly eventDir: string; readonly worker: string; readonly operationId: string }
    | undefined
  let supervisorCancelInput: { readonly eventDir: string; readonly operationId: string } | undefined
  const runtimeController = new RuntimeSupervisorController({
    watcher,
    write: (rootDir, supervisorId, worker, options) => {
      writeInput = {
        rootDir,
        supervisorId,
        worker,
        operationId: options.operationId,
        message: options.message,
      }
      return {
        worker,
        file: '/workspace/.agent/inbox/request.json',
        request: {
          schemaVersion: 1,
          operationId: options.operationId,
          requestDigest: `sha256:${'a'.repeat(64)}`,
          at: NOW,
          worker,
          message: options.message,
          source: options.source ?? 'braid',
          interrupt: options.interrupt === true,
        },
        replayed: false,
      }
    },
    cancelWorker: (eventDir, worker, operationId) => {
      workerCancelInput = { eventDir, worker, operationId }
      return {
        operationId,
        worker,
        effect: 'cancel_requested',
        requestedAt: NOW,
        observedAt: NOW,
        detail: 'runtime accepted worker cancellation',
        terminated: [],
      }
    },
    cancelRun: (eventDir, operationId) => {
      supervisorCancelInput = { eventDir, operationId }
      return {
        operationId,
        effect: 'cancel_requested',
        requestedAt: NOW,
        observedAt: NOW,
        detail: 'runtime accepted supervisor cancellation',
      }
    },
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    intelligence: {
      supervisorWatcher: watcher,
      supervisorController: runtimeController,
    },
  })
  await createCompletedRun(app, 'worker control run')
  const controller = createApplicationUiController(app)
  const snapshot = await controller.dispatch({ type: 'refresh-supervision' })
  assert.equal(snapshot.kind, 'accepted')
  assert.equal(snapshot.kind === 'accepted' && snapshot.data !== undefined, true)
  const data = snapshot.kind === 'accepted' ? snapshot.data : undefined
  const projection = data as {
    readonly supervisors: readonly { readonly id: string; readonly runtimeId: string }[]
    readonly workers: readonly { readonly id: string; readonly runtimeId: string }[]
  }
  const supervisor = projection.supervisors[0]
  const worker = projection.workers[0]
  assert(supervisor && worker)
  assert.notEqual(supervisor.id, supervisor.runtimeId)
  assert.notEqual(worker.id, worker.runtimeId)

  const steered = await controller.dispatch({
    type: 'headless-command',
    command: 'steer_worker',
    operationId: 'op-steer-public-worker',
    params: {
      supervisorId: supervisor.id,
      workerId: worker.id,
      text: 'inspect the failing test',
    },
  })
  assert.equal(steered.kind, 'accepted')
  if (steered.kind === 'accepted') {
    assert.equal(
      (steered.data as { readonly operationId: string }).operationId,
      'op-steer-public-worker',
    )
  }
  assert.deepEqual(writeInput, {
    rootDir: '/workspace',
    supervisorId: 'runtime-supervisor-live',
    worker: 'runtime-worker-control',
    operationId: 'op-steer-public-worker',
    message: 'inspect the failing test',
  })

  const cancelledWorker = await controller.dispatch({
    type: 'headless-command',
    command: 'cancel_worker',
    operationId: 'op-cancel-public-worker',
    params: { supervisorId: supervisor.id, workerId: worker.id },
  })
  assert.equal(cancelledWorker.kind, 'accepted')
  assert.deepEqual(workerCancelInput, {
    eventDir: '/workspace/.agent',
    worker: 'runtime-worker-control',
    operationId: 'op-cancel-public-worker',
  })
  if (cancelledWorker.kind === 'accepted') {
    assert.equal((cancelledWorker.data as { readonly effect: string }).effect, 'cancel_requested')
  }

  const cancelledSupervisor = await controller.dispatch({
    type: 'headless-command',
    command: 'cancel_supervisor',
    operationId: 'op-cancel-public-supervisor',
    params: { supervisorId: supervisor.id },
  })
  assert.equal(cancelledSupervisor.kind, 'accepted')
  assert.deepEqual(supervisorCancelInput, {
    eventDir: '/workspace/.agent',
    operationId: 'op-cancel-public-supervisor',
  })

  const attach = await controller.dispatch({
    type: 'headless-command',
    command: 'attach_worker',
    operationId: 'op-attach-public-worker',
    params: { supervisorId: supervisor.id, workerId: worker.id },
  })
  assert.equal(attach.kind, 'unavailable')
  if (attach.kind === 'unavailable') assert.match(attach.reason, /interactive TUI/u)

  writeInput = undefined
  const rejected = await controller.dispatch({
    type: 'headless-command',
    command: 'steer_worker',
    operationId: 'op-steer-forged-worker',
    params: {
      supervisorId: supervisor.id,
      workerId: 'worker-not-present',
      text: 'must not dispatch',
    },
  })
  assert.equal(rejected.kind, 'unavailable')
  assert.equal(writeInput, undefined)
  await app.close()
})

test('an empty live supervisor snapshot is normal before any worker activity exists', async () => {
  const raw = { ...supervisionSnapshot([]), supervisors: [] }
  const watcher = new RuntimeSupervisorWatcher(() => raw)
  const app = createBraidApplication({
    fixture: 'deterministic',
    intelligence: { supervisorWatcher: watcher },
  })
  const controller = createApplicationUiController(app)
  await controller.initialize('/workspace')

  const result = await controller.dispatch({ type: 'refresh-supervision' })

  assert.equal(result.kind, 'accepted')
  assert.deepEqual(result.kind === 'accepted' ? result.data : undefined, {
    supervisors: [],
    workers: [],
    graphNodes: [],
    graphEdges: [],
  })
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
  await terminal.waitForRender()
  const sourceScreen = terminal.getViewport().join('\n')
  assert.match(sourceScreen, /Ask about a run/u)
  assert.match(sourceScreen, new RegExp(candidateRunId, 'u'))
  assert.match(sourceScreen, new RegExp(baselineRunId, 'u'))
  terminal.sendInput('\r')
  await waitUntil(() => app.state().analyses.length === 1)
  await terminal.waitForRender()
  const askScreen = terminal.getViewport().join('\n')
  assert.match(askScreen, /\/ask · frozen question/u)
  assert.match(askScreen, /source:[^\n]+frozen/u)
  assert.match(askScreen, /No findings were returned/u)
  assert.match(askScreen, /next: ask a narrower question/u)
  assert.match(askScreen, /^─{100}$/mu)
  assert.doesNotMatch(askScreen, /AgentProfile Braid starter/u)

  terminal.sendInput('\u001b')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /Analysis complete:/u)
  terminal.sendInput(`/compare ${baselineRunId} ${candidateRunId}`)
  terminal.sendInput('\r')
  await waitUntil(() => app.state().analyses.length === 2)
  await terminal.waitForRender()
  const comparisonScreen = terminal.getViewport().join('\n')
  assert.match(comparisonScreen, /\/compare · frozen runs/u)
  assert.match(comparisonScreen, new RegExp(`baseline run: ${baselineRunId}`, 'u'))
  assert.match(comparisonScreen, new RegExp(`candidate run: ${candidateRunId}`, 'u'))
  assert.match(
    comparisonScreen,
    new RegExp(`sources run ${baselineRunId} ↔ run ${candidateRunId}`, 'u'),
  )
  assert.match(comparisonScreen, /sample: 1 paired/u)

  terminal.sendInput('\u001b[B')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /\/ask · frozen question/u)
  terminal.sendInput('\u001b[D')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /(?:Analysis|Comparison) complete:/u)
  terminal.sendInput('\u001b')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /(?:Analysis|Comparison) complete:/u)

  view.stop()
  await done
  await app.close()
})

test('the terminal keeps an explicit branch pin through ask progress and result', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app, {}, 'analysis')
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TuiMainScreen(terminal)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-branch-ask-${++operation}`,
  })
  const done = view.start()

  terminal.sendInput('/ask branch:branch-ask why did this branch finish')
  terminal.sendInput('\r')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /source branch branch-ask/u)
  await waitUntil(() =>
    controller.view().activity.some((item) => item.id === 'analysis:analysis-fixture-1'),
  )
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /source branch branch-ask/u)

  view.stop()
  await done
  await app.close()
})

test('the terminal keeps both explicit branch pins through comparison progress and result', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app, {}, 'comparison')
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TuiMainScreen(terminal)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-branch-compare-${++operation}`,
  })
  const done = view.start()

  terminal.sendInput('/compare branch:branch-a branch:branch-b')
  terminal.sendInput('\r')
  await terminal.waitForRender()
  const progressScreen = terminal.getViewport().join('\n')
  assert.match(progressScreen, /sources branch branch-a ↔ branch branch-b/u)
  await waitUntil(() =>
    controller.view().activity.some((item) => item.id === 'analysis:analysis-fixture-comparison'),
  )
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /sources branch branch-a ↔ branch branch-b/u)

  view.stop()
  await done
  await app.close()
})

test('saved analysis results present status-aware next actions', () => {
  const base = {
    source: 'sha256:analysis-source',
    analyst: 'configured analyst',
    recipe: 'ask',
    findings: [],
    citations: [],
    citationSupport: { status: 'passed', supportedFindings: 0 },
    footer: [],
  } as const

  const failed = analysisLines({
    ...base,
    status: 'failed',
    error: 'analysis source or analyst execution failed',
  }).join('\n')
  assert.match(failed, /next: retry \/ask with a narrower question/u)
  assert.match(failed, /open \/activity to inspect the failed analyst call/u)

  const running = analysisLines({ ...base, status: 'running' }).join('\n')
  assert.doesNotMatch(running, /next:/u)

  const completedComparison = analysisLines({
    ...base,
    recipe: 'compare',
    status: 'completed',
  }).join('\n')
  assert.match(completedComparison, /next: inspect either frozen run with \/ask <question>/u)
})

test('activity follows runtime workers while open and stops cleanly when closed', async () => {
  let raw = supervisionSnapshot([{ id: 'runtime-worker-1', label: 'worker-one' }])
  let snapshotCalls = 0
  const watcher = new RuntimeSupervisorWatcher(() => {
    snapshotCalls += 1
    return {
      ...raw,
      supervisors: raw.supervisors.map((supervisor) => ({
        ...supervisor,
        workers: supervisor.workers.map((worker) => ({
          ...worker,
          latencyMs: worker.status === 'running' ? snapshotCalls * 25 : worker.latencyMs,
        })),
      })),
    }
  })
  const app = createBraidApplication({
    fixture: 'deterministic',
    intelligence: { supervisorWatcher: watcher },
  })
  await createCompletedRun(app, 'runtime root')
  const controller = createApplicationUiController(app)
  const eventsBeforeRefresh = app.events().length
  const concurrentRefresh = await Promise.all([
    controller.dispatch({ type: 'refresh-supervision' }),
    controller.dispatch({ type: 'refresh-supervision' }),
  ])
  assert.deepEqual(
    concurrentRefresh.map((result) => result.kind),
    ['accepted', 'accepted'],
  )
  const refreshKinds = app
    .events()
    .slice(eventsBeforeRefresh)
    .map((event) => event.event.kind)
  assert.deepEqual(refreshKinds, [
    'supervisor.upserted',
    'worker.upserted',
    'graph.node.upserted',
    'graph.node.upserted',
    'graph.edge.upserted',
  ])
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TuiMainScreen(terminal)
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-live-workers',
  })
  const done = view.start()

  terminal.sendInput('/activity')
  terminal.sendInput('\r')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /worker-one/u)
  const unchangedRevision = app.state().revision
  await new Promise((resolve) => setTimeout(resolve, 650))
  assert.ok(snapshotCalls >= 3)
  assert.equal(app.state().revision, unchangedRevision)

  raw = supervisionSnapshot(
    [
      { id: 'runtime-worker-1', label: 'worker-one' },
      { id: 'runtime-worker-2', label: 'worker-two', parent: 'worker-one' },
    ],
    Date.parse(NOW) + 1_000,
  )
  await waitUntil(() => app.state().workers.length === 2)
  await terminal.waitForRender()
  const workerScreen = terminal.getViewport().join('\n')
  assert.match(workerScreen, /worker-two/u)
  const parent = app.state().workers.find((worker) => worker.title === 'worker-one')
  const child = app.state().workers.find((worker) => worker.title === 'worker-two')
  assert(parent && child)
  assert.equal(child.parentWorkerId, parent.id)
  const parentActivity = controller
    .view()
    .activity.find((item) => item.id === `worker:${parent.id}`)
  const childActivity = controller.view().activity.find((item) => item.id === `worker:${child.id}`)
  assert.equal(childActivity?.parentId, parent.id)
  assert.equal(childActivity?.depth, (parentActivity?.depth ?? 0) + 1)

  raw = supervisionSnapshot(
    [
      { id: 'runtime-worker-1', label: 'worker-one' },
      { id: 'runtime-worker-2', label: 'worker-two', parent: 'worker-one' },
      { id: 'runtime-worker-3', label: 'worker-orphan', parent: 'missing-parent' },
    ],
    Date.parse(NOW) + 2_000,
  )
  await waitUntil(() => app.state().workers.length === 3)
  const orphan = app.state().workers.find((worker) => worker.title === 'worker-orphan')
  assert(orphan)
  assert.equal(orphan.parentRuntimeRef, 'missing-parent')
  assert.equal(orphan.parentWorkerId, undefined)
  assert.equal(
    controller.view().activity.find((item) => item.id === `worker:${orphan.id}`)?.parentId,
    undefined,
  )
  assert.equal(
    queryGraph(app.state()).edges.some(
      (edge) => edge.destinationType === 'worker' && edge.destination === orphan.id,
    ),
    false,
  )
  assert.equal(
    controller
      .view()
      .entityDetails?.find((detail) => detail.entityId === orphan.id)
      ?.lines.some((line) => line.includes('(unresolved)')),
    true,
  )

  terminal.sendInput('\u001b')
  await terminal.waitForRender()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const callsAfterClose = snapshotCalls
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(snapshotCalls, callsAfterClose)

  raw = { ...supervisionSnapshot([]), supervisors: [] }
  terminal.sendInput('/activity')
  terminal.sendInput('\r')
  await waitUntil(() => snapshotCalls > callsAfterClose)
  await waitUntil(() => terminal.getViewport().join('\n').includes('runtime activity unavailable'))
  assert.match(terminal.getViewport().join('\n'), /showing last saved state/u)
  assert.equal(app.state().supervisors[0]?.status, 'unknown')
  assert.equal(
    app.state().workers.every((worker) => worker.status === 'unknown'),
    true,
  )
  terminal.sendInput('\u001b')
  await terminal.waitForRender()

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

test('worker cancellation fails closed when the selected runtime worker is absent', async () => {
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
  if (result.kind === 'unavailable') {
    assert.match(result.reason, /no running supervised worker/u)
  }
  assert.equal(app.state().supervisors.length, 0)
  await app.close()
})
