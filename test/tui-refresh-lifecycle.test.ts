import assert from 'node:assert/strict'
import test from 'node:test'
import { type Component, type OverlayHandle, TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { withIntelligenceResult } from '../src/adapters/tui/ui-intelligence-result-view.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { AnalysisRecord } from '../src/domain/entities.js'
import {
  createAnalysisId,
  createBranchId,
  createConversationId,
  createDigest,
  createRunId,
} from '../src/domain/ids.js'
import type { BraidUiController, UiDispatchResult } from '../src/views/shared/intents.js'
import type { BraidViewModel, HeadlessState, InteractionView } from '../src/views/shared/models.js'
import type { ModalCoordinator, ModalOptions } from '../src/views/tui/modal-coordinator.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { TerminalInteractionController } from '../src/views/tui/terminal-interaction-controller.js'
import { TerminalSurfaceOverlays } from '../src/views/tui/terminal-surface-overlays.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

interface OpenEntry {
  readonly component: Component
  readonly onClose?: () => void
}

interface ModalSpy {
  readonly modals: ModalCoordinator
  readonly current: () => Component | undefined
  closeTop(): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: resolvePromise,
  }
}

function modalSpy(): ModalSpy {
  let entry: OpenEntry | undefined
  const modals = {
    open(component: Component, options: ModalOptions = {}, preempt = true): OverlayHandle {
      if (preempt) {
        const closing = entry
        entry = undefined
        closing?.onClose?.()
      }
      entry = { component, ...(options.onClose === undefined ? {} : { onClose: options.onClose }) }
      return {} as OverlayHandle
    },
    closeTop(): void {
      const closing = entry
      entry = undefined
      closing?.onClose?.()
    },
  } as unknown as ModalCoordinator
  return {
    modals,
    current: () => entry?.component,
    closeTop: () => modals.closeTop(),
  }
}

function viewModel(): BraidViewModel {
  return {
    revision: 1,
    workspace: '/workspace',
    profileName: 'Braid test profile',
    runner: 'pi',
    model: 'fixture/model',
    connection: 'fixture',
    conversationId: 'conversation-1',
    conversationTitle: 'Lifecycle test',
    conversations: [],
    branch: 'branch-1',
    status: 'ready',
    statusText: 'ready',
    queueCount: 0,
    sessionUsage: {
      turns: emptyUsageTotals(),
      analyses: emptyUsageTotals(),
      delegated: emptyUsageTotals(),
      attribution: 'complete',
    },
    environments: [],
    messages: [],
    hiddenMessageCount: 0,
    runs: [],
    interactions: [],
    activity: [
      { id: 'worker:one', kind: 'worker', title: 'worker-one', status: 'running' },
      { id: 'analysis:ask', kind: 'analysis', title: '/ask', status: 'completed' },
      { id: 'analysis:analyze', kind: 'analysis', title: '/analyze', status: 'completed' },
      { id: 'analysis:compare', kind: 'analysis', title: '/compare', status: 'completed' },
    ],
    graph: [],
    entityDetails: [
      {
        entityType: 'analysis',
        entityId: 'ask',
        title: '/ask · frozen question',
        status: 'completed',
        lines: ['source: frozen'],
      },
      {
        entityType: 'analysis',
        entityId: 'analyze',
        title: '/analyze · frozen recipe',
        status: 'completed',
        lines: ['source: frozen'],
      },
      {
        entityType: 'analysis',
        entityId: 'compare',
        title: '/compare · frozen runs',
        status: 'completed',
        lines: ['source: frozen'],
      },
    ],
    capabilities: {},
    draft: '',
    selectedSurface: 'transcript',
    appearance: { color: 'none', highContrast: false, reducedMotion: false },
  }
}

function emptyUsageTotals(): BraidViewModel['sessionUsage']['turns'] {
  return {
    sourceCount: 0,
    input: 0,
    output: 0,
    tokenStatus: 'unknown',
    costStatus: 'unknown',
    unknownTokenSources: 0,
    unknownCostSources: 0,
  }
}

function controllerFor(
  view: BraidViewModel,
  dispatch: (intent: Parameters<BraidUiController['dispatch']>[0]) => Promise<UiDispatchResult>,
): BraidUiController {
  return {
    view: () => view,
    state: () => ({}) as HeadlessState,
    events: () => [],
    initialize: async () => ({ kind: 'accepted', revision: view.revision }),
    subscribe: () => () => {},
    dispatch,
    waitForIdle: async () => view,
  }
}

function unavailable(reason: string): UiDispatchResult {
  return { kind: 'unavailable', code: 'CAPABILITY_UNAVAILABLE', reason }
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

function surfaceOptions(
  controller: BraidUiController,
  modals: ModalCoordinator,
  requestRender: () => void,
): ConstructorParameters<typeof TerminalSurfaceOverlays>[0] {
  return {
    theme: createBraidTheme(false),
    controller,
    modals,
    rows: () => 12,
    requestRender,
    openProfile: () => {},
    openConnection: () => {},
  }
}

test('late live refreshes cannot affect a closed surface and reopening starts a new generation', async () => {
  const requests: Deferred<UiDispatchResult>[] = []
  let renders = 0
  const view = viewModel()
  const controller = controllerFor(view, async () => {
    const request = deferred<UiDispatchResult>()
    requests.push(request)
    return request.promise
  })
  const spy = modalSpy()
  const surfaces = new TerminalSurfaceOverlays(
    surfaceOptions(controller, spy.modals, () => {
      renders += 1
    }),
  )

  try {
    surfaces.openSurface('activity')
    assert.equal(requests.length, 1)
    spy.closeTop()

    surfaces.openSurface('activity')
    assert.equal(requests.length, 2)
    const rendersBeforeLateResult = renders
    requests[0]?.resolve(unavailable('old surface'))
    await drainMicrotasks()
    assert.equal(renders, rendersBeforeLateResult)
    assert.doesNotMatch(spy.current()?.render(100).join('\n') ?? '', /old surface/u)

    requests[1]?.resolve(unavailable('new surface'))
    await drainMicrotasks()
    assert.match(spy.current()?.render(100).join('\n') ?? '', /new surface/u)
  } finally {
    surfaces.dispose()
  }
})

test('one interaction shell refreshes its countdown and disposal stops the timer', async () => {
  const interaction: InteractionView = {
    runId: 'run-countdown',
    interactionId: 'interaction-countdown',
    profileName: 'Review profile',
    runner: 'pi',
    kind: 'permission',
    prompt: 'Allow this read?',
    answerSpec: { kind: 'boolean', required: true },
    allowedOutcomes: ['accept', 'reject', 'cancel'],
    responseScopes: ['once'],
    remainingMs: 5_000,
    queuePosition: 0,
    queueTotal: 1,
    secret: false,
  }
  let current = { ...viewModel(), interactions: [interaction] }
  let renders = 0
  const spy = modalSpy()
  const controller = new TerminalInteractionController({
    theme: createBraidTheme(false),
    modals: spy.modals,
    nextOperationId: () => 'operation-countdown',
    dispatch: async () => ({ kind: 'accepted', revision: current.revision }),
    currentView: () => current,
    isStopped: () => false,
    requestRender: () => {
      renders += 1
    },
    rows: () => 12,
    openAutomation: () => {},
  })

  controller.sync(current)
  const shell = spy.current()
  assert.match(shell?.render(80).join('\n') ?? '', /5s left/u)
  current = {
    ...current,
    interactions: [{ ...interaction, remainingMs: 900 }],
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(spy.current(), shell)
  assert.match(shell?.render(80).join('\n') ?? '', /1s left/u)
  assert.ok(renders > 0)

  controller.dispose()
  const rendersAfterDispose = renders
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(renders, rendersAfterDispose)
  spy.closeTop()
})

test('analysis surfaces stay frozen and TerminalApp.stop disposes live refreshes', async () => {
  const view = viewModel()
  const requests: string[] = []
  const surfaceController = controllerFor(view, async (intent) => {
    if (intent.type !== 'refresh-supervision') {
      return { kind: 'accepted', revision: view.revision }
    }
    requests.push(intent.type)
    return { kind: 'accepted', revision: view.revision }
  })
  const spy = modalSpy()
  const surfaces = new TerminalSurfaceOverlays(
    surfaceOptions(surfaceController, spy.modals, () => {}),
  )

  surfaces.openIntelligenceResult('ask', {
    analysis: {
      id: 'ask',
      status: 'completed',
      findings: [],
      source: { digest: 'ask', complete: true },
    },
  })
  surfaces.openIntelligenceResult('analyze', {
    analysis: {
      id: 'analyze',
      status: 'completed',
      findings: [],
      source: { digest: 'analyze', complete: true },
    },
  })
  surfaces.openIntelligenceResult('compare', {
    analysisId: 'compare',
    baselineSourceDigest: 'baseline',
    candidateSourceDigest: 'candidate',
    baselineRunId: 'left',
    candidateRunId: 'right',
    fields: [],
    rows: [],
    paired: { nPairs: 0, nUnpairedBaseline: 0, nUnpairedTreatment: 0 },
    semantic: { status: 'unavailable', reason: 'not evaluated' },
  })
  assert.deepEqual(requests, [])
  surfaces.openIntelligenceResult('ask', {
    analysis: {
      id: 'missing-analysis',
      status: 'completed',
      findings: [],
      source: { digest: 'missing', complete: true },
    },
  })
  assert.match(spy.current()?.render(80).join('\n') ?? '', /missing from activity/u)
  surfaces.dispose()

  const application = createBraidApplication({ fixture: 'deterministic' })
  const baseController = createApplicationUiController(application)
  await baseController.initialize('/workspace')
  let appRefresh: Deferred<UiDispatchResult> | undefined
  let appRefreshStarted: () => void = () => {}
  const appStarted = new Promise<void>((resolve) => {
    appRefreshStarted = resolve
  })
  const controller: BraidUiController = {
    view: () => baseController.view(),
    state: () => baseController.state(),
    events: () => baseController.events(),
    initialize: (workspace) => baseController.initialize(workspace),
    subscribe: (subscriber, options) => baseController.subscribe(subscriber, options),
    dispatch: async (intent) => {
      if (intent.type !== 'refresh-supervision') return baseController.dispatch(intent)
      appRefresh = deferred<UiDispatchResult>()
      appRefreshStarted()
      return appRefresh.promise
    },
    waitForIdle: () => baseController.waitForIdle(),
  }
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  let renderRequests = 0
  const requestRender = tui.requestRender.bind(tui)
  tui.requestRender = (force?: boolean) => {
    renderRequests += 1
    requestRender(force)
  }
  const appView = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-refresh-lifecycle',
  })
  const done = appView.start()

  try {
    terminal.sendInput('/activity')
    terminal.sendInput('\r')
    await appStarted
    appView.stop()
    const rendersAfterStop = renderRequests
    assert.ok(appRefresh)
    appRefresh.resolve(unavailable('after stop'))
    await drainMicrotasks()
    assert.equal(renderRequests, rendersAfterStop)
  } finally {
    appView.stop()
    await done
    await application.close()
  }
})

test('analysis progress opens immediately, follows live state, and respects dismissal', () => {
  let current: BraidViewModel = {
    ...viewModel(),
    activity: [],
    entityDetails: [],
  }
  const controller: BraidUiController = {
    ...controllerFor(current, async () => ({ kind: 'accepted', revision: current.revision })),
    view: () => current,
  }
  const spy = modalSpy()
  const surfaces = new TerminalSurfaceOverlays(surfaceOptions(controller, spy.modals, () => {}))

  const progress = surfaces.openIntelligenceProgress(
    'ask',
    'source run:run-live · Review profile · pi · tangle-router/glm-5.2 · Local CLI Bridge',
  )
  const empty = spy.current()?.render(80).join('\n') ?? ''
  assert.match(empty, /analyses · 0/u)
  assert.match(empty, /Starting \/ask/u)
  assert.match(empty, /source run:run-live/u)
  assert.match(empty, /Review profile · pi · tangle-router\/glm-5\.2/u)

  current = {
    ...current,
    activity: [
      {
        id: 'analysis:live-ask',
        kind: 'analysis',
        title: '/ask',
        status: 'running',
        entityType: 'analysis',
        entityId: 'live-ask',
        detail: 'Reading the frozen trace',
      },
    ],
    entityDetails: [
      {
        entityType: 'analysis',
        entityId: 'live-ask',
        title: '/ask · frozen question',
        status: 'running',
        lines: ['source: frozen', 'Reading the frozen trace'],
      },
    ],
  }
  const running = spy.current()?.render(80).join('\n') ?? ''
  assert.match(running, /analyses · 1/u)
  assert.match(running, /\/ask · frozen question/u)
  assert.match(running, /running/u)

  progress.complete({
    analysis: {
      id: 'live-ask',
      status: 'completed',
      findings: [],
      source: { digest: 'live-ask', complete: true },
    },
  })
  assert.match(spy.current()?.render(80).join('\n') ?? '', /analyses › \/ask · frozen question/u)
  assert.doesNotMatch(spy.current()?.render(80).join('\n') ?? '', /complete · 1\/1/u)

  spy.closeTop()
  const dismissed = surfaces.openIntelligenceProgress('analyze')
  spy.closeTop()
  dismissed.complete({
    analysis: {
      id: 'live-ask',
      status: 'completed',
      findings: [],
      source: { digest: 'live-ask', complete: true },
    },
  })
  assert.equal(spy.current(), undefined)
  surfaces.dispose()
})

test('selected saved intelligence results pin one old row without expanding the activity tail', () => {
  const durable: AnalysisRecord = {
    id: createAnalysisId('analysis-saved-old'),
    question: 'authoritative saved question',
    recipe: 'ask',
    status: 'completed',
    source: {
      conversationId: createConversationId('conversation-saved'),
      branchId: createBranchId('branch-saved'),
      digest: createDigest('a'.repeat(64)),
      complete: true,
    },
    findings: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:01.000Z',
  }
  const visibleTail = Array.from({ length: 500 }, (_, index) => ({
    id: `run:${index}`,
    kind: 'run' as const,
    title: `run ${index}`,
    status: 'completed' as const,
    occurredAt: new Date(Date.UTC(2026, 7, 2, 0, 0, index)).toISOString(),
  }))
  const view = {
    ...viewModel(),
    activity: visibleTail,
    entityDetails: [],
  }
  const accepted = {
    status: 'completed',
    analysis: {
      ...durable,
      question: 'stale transport copy',
    },
  }

  const pinned = withIntelligenceResult(view, accepted, {
    durableAnalyses: [durable],
  })

  assert.equal(pinned.activity.length, 500)
  assert.equal(
    pinned.activity.some((item) => item.id === 'analysis:analysis-saved-old'),
    true,
  )
  assert.equal(
    pinned.activity.some((item) => item.id === 'run:0'),
    false,
  )
  assert.equal(
    pinned.entityDetails?.find((item) => item.entityId === 'analysis-saved-old')?.lines[1],
    'analyst: configured analyst · completed',
  )
  assert.equal(
    pinned.activity.find((item) => item.id === 'analysis:analysis-saved-old')?.detail,
    'authoritative saved question',
  )
  assert.notEqual(
    pinned.activity.find((item) => item.id === 'analysis:analysis-saved-old')?.detail,
    'stale transport copy',
  )

  const comparisonId = createAnalysisId('analysis-saved-comparison')
  const savedComparison: AnalysisRecord = {
    ...durable,
    id: comparisonId,
    kind: 'comparison',
    recipe: 'compare',
    comparison: {
      baseline: {
        conversationId: createConversationId('conversation-saved-baseline'),
        branchId: createBranchId('branch-saved-baseline'),
        runId: createRunId('run-saved-baseline'),
        digest: createDigest('b'.repeat(64)),
        complete: true,
      },
      candidate: {
        conversationId: createConversationId('conversation-saved-candidate'),
        branchId: createBranchId('branch-saved-candidate'),
        runId: createRunId('run-saved-candidate'),
        digest: createDigest('c'.repeat(64)),
        complete: true,
      },
      fields: [],
      rows: [],
      paired: { nPairs: 0, nUnpairedBaseline: 0, nUnpairedTreatment: 0 },
      semantic: { status: 'unavailable', reason: 'saved comparison snapshot' },
    },
  }
  const comparisonPinned = withIntelligenceResult(
    view,
    {
      analysisId: comparisonId,
      baselineSourceDigest: 'baseline',
      candidateSourceDigest: 'candidate',
      baselineRunId: 'run-baseline',
      candidateRunId: 'run-candidate',
      fields: [],
      rows: [],
      paired: { nPairs: 0, nUnpairedBaseline: 0, nUnpairedTreatment: 0 },
      semantic: { status: 'unavailable', reason: 'not evaluated' },
    },
    {
      durableAnalyses: [durable, savedComparison],
    },
  )
  assert.equal(comparisonPinned.activity.length, 500)
  assert.equal(
    comparisonPinned.activity.some((item) => item.id === `analysis:${comparisonId}`),
    true,
  )
  const comparisonDetail =
    comparisonPinned.entityDetails
      ?.find((item) => item.entityId === comparisonId)
      ?.lines.join('\n') ?? ''
  assert.match(comparisonDetail, /baseline run: run-saved-baseline/u)
  assert.doesNotMatch(comparisonDetail, /run-baseline/u)

  const malformed = withIntelligenceResult(
    view,
    { analysis: { id: 'analysis-saved-old', status: 'completed' } },
    { durableAnalyses: [durable] },
  )
  assert.strictEqual(malformed, view)

  const nonexistent = withIntelligenceResult(
    view,
    {
      ...accepted,
      analysis: { ...accepted.analysis, id: createAnalysisId('analysis-not-saved') },
    },
    { durableAnalyses: [durable] },
  )
  assert.strictEqual(nonexistent, view)
})
