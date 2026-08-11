import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { BraidViewModel } from '../src/views/shared/models.js'
import { composerProjectionFor, composerRowBudget } from '../src/views/tui/composer-view.js'
import { layoutFor } from '../src/views/tui/layout.js'
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
    model: 'tangle-router/glm-5.2',
    effort: 'high',
    maxOutputTokens: 8192,
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
    navigationHint: 'Ctrl+P commands',
  })

  const narrow = plainLines(chrome, 40)
  assert.equal(narrow.length, 3)
  assert.match(narrow[0] ?? '', /braid\s+AgentProfile Release engineer/u)
  assert.match(narrow[1] ?? '', /pi \/ glm-5\.2.*Local CLI Bridge/u)
  assert.match(narrow[2] ?? '', /completed.*Ctrl\+P commands/u)
  assert.doesNotMatch(narrow.join('\n'), /\/home\/drew|\.worktrees|…/u)

  const standardTop = chrome.renderTop(80).join('\n')
  const standardBottom = chrome.renderBottom(80).join('\n')
  const standard = [standardTop, standardBottom].join('\n')
  assert.match(standard, /braid\s+cwd\s+braid-integration/u)
  assert.match(standard, /New conversation/u)
  assert.match(standardTop, /AgentProfile Release engineer/u)
  assert.match(standardTop, /pi \/ glm-5\.2/u)
  assert.match(standard, /Local CLI Bridge/u)
  assert.match(standardBottom, /completed.*Ctrl\+P commands/u)
  assert.doesNotMatch(standard, /branch-1|in 1\.2k|out 567|\$0\.0312/u)
  assert.doesNotMatch(standard, /…/u)

  const wideTop = chrome.renderTop(120).join('\n')
  const wide = plainLines(chrome, 120).join('\n')
  assert.match(wide, /branch\s+branch-1/u)
  assert.match(wideTop, /model tangle-router\/glm-5\.2/u)
  assert.match(wideTop, /output ≤8\.2k/u)
  assert.match(wide, /in 1\.2k/u)
  assert.match(wide, /out 567/u)
  assert.match(wide, /\$0\.0312/u)
  assert.doesNotMatch(wide, /\/home\/drew|\.worktrees|…/u)

  for (const width of [1, 2, 10, 40, 80, 120, 200]) {
    for (const line of plainLines(chrome, width)) assert.ok(visibleWidth(line) <= width)
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
    },
    quitArmed: false,
    activityVisible: false,
    navigationHint: 'Ctrl+P commands',
  })
  const active = chrome.render(80).join('\n')
  assert.match(active, /Ctrl\+C cancel/u)
  assert.match(active, /Enter queues input/u)

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
    navigationHint: 'Ctrl+P commands',
  })
  const failed = chrome.render(80).join('\n')
  assert.match(failed, /outcome failed · operation operation-/u)
  assert.match(failed, /\/export preserve · \/new continue/u)
  assert.doesNotMatch(failed, /operation-that-is-long-enough-to-shorten/u)
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
    assert.match(viewport.join('\n'), /braid/u)
    assert.match(viewport.join('\n'), /completed/u)
    assert.ok(
      viewport.some((line) => line.includes('─')),
      `${columns}x${rows} composer border`,
    )
    const composerTop = viewport.findIndex((line) => line.includes('› send'))
    const composerBottom = viewport.findIndex((line) => line.includes('alt+enter newline'))
    assert.ok(composerTop >= 0, `${columns}x${rows} composer action`)
    assert.equal(composerBottom - composerTop, 4, `${columns}x${rows} idle composer rows`)
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
  assert.match(projection.actionLabel, /steer \/steer/u)
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
  assert.equal(unavailable.actionLabel, 'queue unavailable')

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
  const top = viewport.findIndex((line) => line.includes('queue next #2'))
  const bottom = viewport.findIndex((line) => line.includes('alt+enter newline'))
  assert.ok(top >= 0)
  assert.ok(bottom > top)
  assert.equal(bottom - top, 4, 'composer must retain three usable rows')
  assert.match(viewport.join('\n'), /steer \/steer/u)
  assert.ok(viewport.slice(top + 1, bottom).some((line) => line.includes('›')))
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
  const top = lines.findIndex((line) => line.includes('› send'))
  const bottom = lines.findIndex((line) => line.includes('alt+enter newline'))
  assert.ok(top >= 0)
  assert.ok(bottom > top)
  assert.equal(bottom - top, 4)
  assert.equal(lines.length, 12)
  for (const line of lines) assert.ok(visibleWidth(line) <= 40)
})
