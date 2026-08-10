import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen, type Component, type OverlayHandle } from '@earendil-works/pi-tui'
import type { BraidUiController, UiDispatchResult } from '../src/views/shared/intents.js'
import type { BraidViewModel, HeadlessState } from '../src/views/shared/models.js'
import { TerminalSurfaceOverlays } from '../src/views/tui/terminal-surface-overlays.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import type { ModalCoordinator, ModalOptions } from '../src/views/tui/modal-coordinator.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { createBraidApplication } from '../src/app/composition.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
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
    open(component: Component, options: ModalOptions = {}): OverlayHandle {
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
