import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  TuiMainScreen,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { BraidViewModel, EnvironmentView } from '../src/views/shared/models.js'
import { composerProjectionFor, composerRowBudget } from '../src/views/tui/composer-view.js'
import { layoutFor } from '../src/views/tui/layout.js'
import { ModalCoordinator } from '../src/views/tui/modal-coordinator.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { TerminalChrome } from '../src/views/tui/terminal-chrome.js'
import { BraidShell } from '../src/views/tui/terminal-shell.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
] as const

function viewForChrome(): BraidViewModel {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/home/drew/code/.worktrees/braid-integration')
  const base = createApplicationUiController(app).view()
  return {
    ...base,
    workspace: '/home/drew/code/.worktrees/braid-integration',
    profileName: 'Release engineer',
    runner: 'pi',
    model: 'openai-codex/gpt-5.6-luna',
    effort: 'high',
    maxVisibleOutputTokens: 8192,
    maxReasoningTokens: 4096,
    maxTotalOutputTokens: 12_288,
    connection: 'Local CLI Bridge',
    conversationTitle: 'New conversation',
    branch: 'branch-1',
    status: 'completed',
    statusText: 'completed',
    runs: [
      {
        id: 'run-metrics',
        turnId: 'turn-metrics',
        operationId: 'op-metrics',
        status: 'completed',
        completeness: 'complete',
        usage: { input: 1_234, output: 567, costUsd: 0.0312 },
      },
    ],
    sessionUsage: {
      ...base.sessionUsage,
      turns: {
        sourceCount: 1,
        input: 1_234,
        output: 567,
        tokenStatus: 'complete',
        costUsd: 0.0312,
        costStatus: 'reported',
        unknownTokenSources: 0,
        unknownCostSources: 0,
      },
    },
  }
}

function plainLines(chrome: TerminalChrome, width: number): string[] {
  return chrome.render(width)
}

test('chrome uses complete responsive groups at every reference width', () => {
  const view = viewForChrome()
  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view,
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })

  const narrow = plainLines(chrome, 40)
  assert.equal(narrow.length, 1)
  assert.equal(narrow[0], 'Release engineer')
  assert.doesNotMatch(narrow.join('\n'), /\/home\/drew|\.worktrees|…/u)

  const standardTop = chrome.renderTop(80).join('\n')
  const standardBottom = chrome.renderBottom(80).join('\n')
  const standard = [standardTop, standardBottom].join('\n')
  assert.equal(standardTop, '')
  assert.match(standardBottom, /profile Release engineer/u)
  assert.match(standardBottom, /pi \/ gpt-5\.6-luna/u)
  assert.match(standard, /via Local CLI Bridge/u)
  assert.doesNotMatch(standardBottom, /\/ commands|Ctrl\+P/u)
  assert.doesNotMatch(standard, /braid|cwd|New conversation|branch-1|in 1\.2k|out 567|\$0\.0312/u)
  assert.doesNotMatch(standard, /…/u)

  const wide = plainLines(chrome, 120).join('\n')
  assert.match(wide, /Release engineer/u)
  assert.match(wide, /profile Release engineer · pi \/ openai-codex\/gpt-5\.6-luna/u)
  assert.match(wide, /Local CLI Bridge/u)
  assert.match(wide, / · think high/u)
  assert.doesNotMatch(wide, /backend CLI Bridge|caps/u)
  assert.match(wide, /in 1\.2k/u)
  assert.match(wide, /out 567/u)
  assert.match(wide, /\$0\.0312/u)
  assert.doesNotMatch(
    wide,
    /braid|cwd|New conversation|branch-1|output ≤|\/home\/drew|\.worktrees|…/u,
  )
  assert.equal(plainLines(chrome, 120).length, 1)

  for (const width of [1, 2, 10, 40, 80, 120, 200]) {
    for (const line of plainLines(chrome, width)) assert.ok(visibleWidth(line) <= width)
  }
})

test('command palette stays isolated and keeps close controls at narrow and wide sizes', async () => {
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
  ] as const) {
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    const app = createBraidApplication({ fixture: 'deterministic' })
    app.initialize('/workspace')
    const view = new BraidTerminalApp({
      controller: createApplicationUiController(app),
      tui,
      theme,
      workspace: '/workspace',
      nextOperationId: () => `palette-${columns}`,
    })
    const done = view.start()
    try {
      await terminal.waitForRender()
      terminal.sendInput('\u0010')
      await terminal.waitForRender()
      const screen = terminal.getViewport().join('\n')
      assert.match(screen, /Commands/u)
      assert.match(screen, /←\/esc close/u)
      assert.doesNotMatch(screen, /profile Braid starter/u)
      if (columns >= 80) assert.match(screen, /Inspect and manage connections/u)
      for (const line of terminal.getViewport()) assert.ok(visibleWidth(line) <= columns)
    } finally {
      view.stop()
      await done
    }
  }
})

test('wide chrome keeps measured sandbox facts as independent context items', () => {
  const base = viewForChrome()
  const environment = {
    id: 'environment-sandbox-facts',
    connectionId: 'connection-sandbox',
    kind: 'sandbox',
    provider: 'tangle-sandbox',
    lifecycle: 'active',
    lifecycleMode: 'retained',
    location: 'remote',
    runtimeEndpointHost: 'sandbox.example.test',
    machineId: 'machine-a10',
    requestedRegion: 'us-central',
    verifiedRegion: 'us-central',
    storagePersistence: 'persistent-home',
    requestedResources: { cpuCores: 4, memoryMB: 8192, diskGB: 80 },
    resourceSample: {
      cgroupVersion: 2,
      memoryCurrentMb: 512,
      memoryPeakMb: 768,
      cpuUsageUsec: 2_500,
      sampledAt: '2026-08-15T00:00:01.000Z',
    },
    gpu: {
      provider: 'tangle-sandbox',
      accelerator: 'A10',
      count: 1,
      status: 'ready',
      billedCustomerCostUsd: 0.1234,
    },
    unavailableTelemetry: [],
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:01.000Z',
  } satisfies EnvironmentView
  const run = base.runs[0]
  assert.ok(run)
  const view: BraidViewModel = {
    ...base,
    activeRunId: run.id,
    environments: [environment],
    runs: [{ ...run, environmentId: environment.id, provider: 'tangle-sandbox' }],
  }
  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view,
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })

  const wideReference = chrome.render(120).join('\n')
  assert.match(wideReference, /host sandbox\.example\.test/u)
  assert.match(wideReference, /machine machine-a10/u)
  assert.doesNotMatch(wideReference, /unknown|not reported/u)

  const mediumWide = chrome.render(160).join('\n')
  assert.match(mediumWide, /sample mem 512MB/u)
  assert.doesNotMatch(mediumWide, /unknown|not reported/u)

  const wide = chrome.render(200).join('\n')
  assert.match(wide, /host sandbox\.example\.test/u)
  assert.match(wide, /machine machine-a10/u)
  assert.match(wide, /region us-central/u)
  assert.match(wide, /sample mem 512MB/u)
  assert.match(wide, /requested 4cpu · 8GB · 80GB/u)
  assert.match(wide, /gpu 1× A10 \$0\.1234/u)
  assert.match(wide, /in 1\.2k|out 567|\$0\.0312/u)
  for (const width of [40, 80, 120, 200]) {
    const lines = chrome.render(width)
    assert.doesNotMatch(lines.join('\n'), /unknown|not reported/u)
    for (const line of lines) assert.ok(visibleWidth(line) <= width)
  }
})

test('chrome exposes active-run controls and failure recovery without hiding outcome identity', () => {
  const chrome = new TerminalChrome(theme)
  const base = viewForChrome()
  const run = base.runs[0]
  assert.ok(run)
  chrome.setState({
    view: {
      ...base,
      status: 'running',
      statusText: 'streaming',
      activeRunId: 'run-metrics',
      runs: [{ ...run, status: 'running', completeness: 'streaming' }],
      capabilities: {
        ...base.capabilities,
        'run.queue': { available: true, source: 'provider' },
        'run.steer': { available: true, source: 'provider' },
      },
    },
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })
  const active = chrome.render(80).join('\n')
  assert.match(active, /profile Release engineer · pi \/ gpt-5\.6-luna/u)
  assert.match(active, /via not connected/u)
  assert.match(active, /Ctrl\+C cancel/u)

  chrome.setState({
    view: {
      ...base,
      status: 'failed',
      statusText: 'RUNTIME_FINAL_ERROR',
      runs: [
        {
          ...run,
          operationId: 'operation-that-is-long-enough-to-shorten',
          status: 'failed',
          completeness: 'failed',
        },
      ],
    },
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })
  const failed = chrome.render(80).join('\n')
  assert.match(failed, /profile Release engineer · pi \/ gpt-5\.6-luna/u)
  assert.match(failed, /via Local CLI Bridge/u)
  assert.match(failed, /failed/u)
  assert.doesNotMatch(failed, /operation-that-is-long-enough-to-shorten/u)

  chrome.setState({
    view: {
      ...base,
      status: 'failed',
      statusText: 'RUNTIME_FINAL_ERROR',
      runs: [{ ...run, status: 'failed', completeness: 'missing-history' }],
    },
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })
  const uncertain = chrome.render(80).join('\n')
  assert.match(uncertain, /profile Release engineer · pi \/ gpt-5\.6-luna/u)
  assert.match(uncertain, /outcome unverified/u)
  assert.doesNotMatch(uncertain, /failed|\/new/u)
})

test('completed notices preserve the persistent route and measured context', () => {
  const base = viewForChrome()
  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view: {
      ...base,
      notice: 'Prepared markdown export',
      statusText: 'Prepared markdown export',
    },
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })

  const standard = chrome.render(80).join('\n')
  assert.match(standard, /profile Release engineer · pi \/ gpt-5\.6-luna/u)
  assert.match(standard, /via Local CLI Bridge/u)
  assert.match(standard, /Prepared markdown export/u)
  assert.doesNotMatch(standard, /\/ commands|Ctrl\+P/u)

  const wide = chrome.render(120).join('\n')
  assert.match(wide, /profile Release engineer · pi \/ openai-codex\/gpt-5\.6-luna/u)
  assert.match(wide, /Local CLI Bridge/u)
  assert.match(wide, /Prepared markdown export/u)
  assert.match(wide, /in 1\.2k/u)
  assert.match(wide, /out 567/u)
})

test('layout breakpoints preserve transcript room and short-terminal overlays', () => {
  assert.equal(layoutFor(40, 12).mode, 'narrow')
  assert.equal(layoutFor(40, 12).overlayFullScreen, true)
  assert.equal(layoutFor(80, 24).mode, 'standard')
  assert.equal(layoutFor(80, 24).overlayFullScreen, false)
  assert.equal(layoutFor(80, 12).overlayFullScreen, true)

  const wide = layoutFor(120, 40)
  assert.equal(wide.mode, 'wide')
  assert.equal(wide.activityWidth, 28)
  assert.equal(wide.gap, 1)
  assert.ok(wide.transcriptWidth >= 72)
  assert.equal(layoutFor(200, 60).mode, 'wide')
})

test('modal coordination honors the row breakpoint at standard and wide widths', () => {
  const shown: OverlayOptions[] = []
  const handle = {
    hide() {},
    focus() {},
    isHidden: () => false,
  } as unknown as OverlayHandle
  const tui = {
    terminal: { columns: 120, rows: 12 },
    showOverlay: (_component: Component, options: OverlayOptions) => {
      shown.push(options)
      return handle
    },
  } as unknown as TUI
  const component = { render: () => [], invalidate() {} } as Component

  new ModalCoordinator(tui).open(component, {
    anchor: 'center',
    width: '80%',
    maxHeight: '80%',
  })

  assert.deepEqual(shown, [{ anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0 }])
})

test('full-screen modal back closes an input surface with the left action', () => {
  let hidden = false
  const handle = {
    hide() {
      hidden = true
    },
    focus() {},
    isHidden: () => hidden,
  } as unknown as OverlayHandle
  const tui = {
    terminal: { columns: 40, rows: 12 },
    showOverlay: () => handle,
  } as unknown as TUI
  const component = {
    handleInput() {},
    render: () => [],
    invalidate() {},
  } as unknown as Component
  const modals = new ModalCoordinator(tui)
  modals.open(component)

  assert.equal(modals.backOrCloseIfFullScreen(), true)
  assert.equal(hidden, true)
  assert.equal(modals.hasOpen(), false)
})

test('published Pi virtual terminals keep the composer and valid cells at all sizes', async () => {
  const view = viewForChrome()
  for (const [columns, rows] of sizes) {
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    const shell = new BraidShell(
      tui,
      theme,
      () => terminal.rows,
      () => {},
      () => {},
    )
    shell.setView(view, false)
    tui.addChild(shell)
    tui.start()
    await terminal.waitForRender()

    const viewport = terminal.getViewport()
    assert.equal(viewport.length, rows, `${columns}x${rows} row count`)
    for (const line of viewport)
      assert.ok(visibleWidth(line) <= columns, `${columns}x${rows} line exceeds width`)
    assert.doesNotMatch(viewport.join('\n'), /braid|completed/u)
    const prompt = viewport.findIndex((line) => line.includes('›'))
    assert.ok(prompt >= 0, `${columns}x${rows} composer prompt`)
    assert.equal(rows - prompt, 5, `${columns}x${rows} composer and context rows`)
    assert.match(viewport[prompt - 1] ?? '', /─{8,}/u)
    assert.match(viewport[prompt] ?? '', /› new message/u)
    assert.match(viewport[prompt + 3] ?? '', /type \/ for commands/u)
    const context = viewport.slice(prompt + 4)
    assert.ok(context.some((line) => line.includes('Release engineer')))
    if (columns >= 100) assert.match(context.at(-1) ?? '', /in 1\.2k|out 567|\$0\.0312/u)
    assert.doesNotMatch(viewport.join('\n'), /\/home\/drew|\.worktrees/u)

    tui.stop()
  }
})

test('composer derives truthful actions and keeps three usable rows at 40x12', async () => {
  const idle = viewForChrome()
  const run = idle.runs[0]
  assert.ok(run)
  const active: BraidViewModel = {
    ...idle,
    status: 'running',
    statusText: 'streaming',
    activeRunId: 'run-metrics',
    queueCount: 1,
    queue: [
      {
        operationId: 'op-queued',
        runId: 'run-metrics',
        text: 'next turn',
        position: 1,
        status: 'queued',
      },
    ],
    runs: [{ ...run, status: 'running', completeness: 'streaming' }],
    capabilities: {
      ...idle.capabilities,
      'run.send': { available: false, source: 'provider', reason: 'A run is already active' },
      'run.queue': { available: true, source: 'provider' },
      'run.steer': { available: true, source: 'provider' },
    },
  }

  const projection = composerProjectionFor(active)
  assert.equal(projection.action, 'queue')
  assert.equal(projection.queuePosition, 2)
  assert.match(projection.actionLabel, /queue next #2/u)
  assert.match(projection.actionLabel, /Alt\+S steer/u)
  assert.match(projection.hint, /type \/ for commands/u)

  const steering = composerProjectionFor(active, 'steer')
  assert.equal(steering.action, 'steer')
  assert.match(steering.actionLabel, /Alt\+S queue/u)
  assert.equal(composerRowBudget(12), 5)

  const unavailable = composerProjectionFor({
    ...active,
    capabilities: {
      ...active.capabilities,
      'run.queue': { available: false, source: 'provider', reason: 'Queue unavailable' },
      'run.steer': { available: false, source: 'provider', reason: 'Steering unavailable' },
    },
  })
  assert.equal(unavailable.action, 'unavailable')
  assert.equal(unavailable.actionLabel, 'input unavailable')

  const terminal = new VirtualTerminal(40, 12)
  const tui = new TuiMainScreen(terminal)
  const shell = new BraidShell(
    tui,
    theme,
    () => terminal.rows,
    () => {},
    () => {},
  )
  shell.setView(active, false)
  tui.addChild(shell)
  tui.start()
  await terminal.waitForRender()

  const viewport = terminal.getViewport()
  const prompt = viewport.findIndex((line) => line.includes('›'))
  assert.ok(prompt >= 0)
  assert.equal(viewport.length - prompt, 5, 'composer must retain three usable rows and context')
  assert.match(viewport[prompt - 1] ?? '', /─{8,}/u)
  assert.match(viewport[prompt + 3] ?? '', /type \/ for commands/u)
  assert.match(viewport.join('\n'), /working · Ctrl\+C stop/u)
  assert.match(viewport[prompt] ?? '', /› queue #2/u)
  assert.equal(viewport.length, 12)
  for (const line of viewport) assert.ok(visibleWidth(line) <= 40)

  tui.stop()
})

test('composer bounds long drafts without changing Pi editor input behavior', () => {
  const idle = viewForChrome()
  const changed: string[] = []
  const submitted: string[] = []
  const terminal = new VirtualTerminal(40, 12)
  const tui = new TuiMainScreen(terminal)
  const shell = new BraidShell(
    tui,
    theme,
    () => terminal.rows,
    (text) => submitted.push(text),
    (text) => changed.push(text),
  )
  shell.setView(idle, false)

  shell.editor.handleInput('draft')
  assert.equal(shell.editor.getText(), 'draft')
  assert.equal(changed.at(-1), 'draft')
  shell.editor.handleInput('\r')
  assert.deepEqual(submitted, ['draft'])
  assert.equal(shell.editor.getText(), '')

  shell.editor.setText(Array.from({ length: 60 }, (_, index) => `line-${index}`).join('\n'))
  const lines = shell.render(40)
  const prompt = lines.findIndex((line) => line.includes('›'))
  assert.ok(prompt >= 0)
  assert.equal(lines.length - prompt, 5)
  assert.match(lines[prompt - 1] ?? '', /─{8,}/u)
  assert.match(lines[prompt + 3] ?? '', /type \/ for commands/u)
  assert.doesNotMatch(lines.join('\n'), /alt\+enter newline/u)
  assert.equal(lines.length, 12)
  for (const line of lines) assert.ok(visibleWidth(line) <= 40)
})
