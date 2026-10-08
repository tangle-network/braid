import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import type { ChildTaskEvent } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { buildBraidViewModel } from '../src/adapters/tui/ui-view-model.js'
import { createBraidApplication } from '../src/app/composition.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { queryActivity } from '../src/views/shared/semantic-activity.js'
import { sessionUsageFor } from '../src/views/shared/usage-projection.js'
import { ActivityBrowserPanel, activityDocument } from '../src/views/tui/activity-browser.js'
import { projectActivityDocument } from '../src/views/tui/activity-document.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })
const started = Date.parse('2026-10-08T12:00:00.000Z')

function child(overrides: Partial<ChildTaskEvent> = {}): ChildTaskEvent {
  return {
    type: 'child-task',
    childId: 'reviewer',
    sourceEventId: 'reviewer-started',
    title: 'Survey code',
    status: 'running',
    runner: 'codex',
    model: 'fixture/model',
    time: { started, updated: started + 100 },
    ...overrides,
  }
}

async function nativeFixture(events: readonly ChildTaskEvent[]) {
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input) {
      for (const event of events) yield event
      yield {
        type: 'final',
        status: 'completed',
        reason: 'completed',
        text: 'Fixture complete.',
        metadata: { tokenUsage: { input: 13, output: 8 } },
        task: { id: input.runId, intent: 'native child presentation fixture' },
        timestamp: new Date(started + 1_000).toISOString(),
      }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-native-activity-1', text: 'Inspect the patch.' }).completion
  return app
}

test('canonical native-child activity preserves run-scoped identity, ancestry and own observations', async () => {
  const events = [
    child(),
    child({
      childId: 'verifier',
      parentChildId: 'reviewer',
      sourceEventId: 'verifier-failed',
      title: 'Verify patch',
      status: 'failed',
      time: { started, updated: started + 500, ended: started + 500 },
      terminalReason: 'Test failed.',
      usage: { inputTokens: 5, outputTokens: 3, cost: 0.002 },
    }),
    child({ childId: 'orphan', parentChildId: 'missing', sourceEventId: 'orphan-started' }),
    child({ childId: 'cycle-a', parentChildId: 'cycle-b', sourceEventId: 'cycle-a-started' }),
    child({ childId: 'cycle-b', parentChildId: 'cycle-a', sourceEventId: 'cycle-b-started' }),
  ]
  const app = await nativeFixture(events)
  await app.send({ operationId: 'op-native-activity-2', text: 'Inspect another patch.' }).completion
  const state = app.state()
  const firstRun = state.runs[0]
  const secondRun = state.runs[1]
  assert.ok(firstRun && secondRun)
  const activity = queryActivity(state).activity.filter((item) => item.kind === 'native-child')
  assert.equal(activity.length, 10)
  assert.equal(new Set(activity.map((item) => item.id)).size, 10)
  const first = queryActivity(state, { runId: firstRun.id }).activity
  const reviewer = first.find((item) => item.id.endsWith(',"reviewer"]'))
  const verifier = first.find((item) => item.id.endsWith(',"verifier"]'))
  const orphan = first.find((item) => item.id.endsWith(',"orphan"]'))
  const cycle = first.find((item) => item.id.endsWith(',"cycle-a"]'))
  assert.ok(reviewer && verifier && orphan && cycle)
  assert.ok(verifier.sourceEventId)
  assert.equal(reviewer.status, 'running', 'owner completion does not complete a native child')
  assert.equal(reviewer.depth, 1)
  assert.equal(verifier.parentId, reviewer.id)
  assert.equal(verifier.depth, 2)
  assert.equal(verifier.status, 'failed')
  assert.equal(verifier.elapsedMs, 500)
  assert.match(verifier.detail ?? '', /runner: codex\nmodel: fixture\/model/u)
  assert.match(verifier.detail ?? '', /observed tokens: 5 in \/ 3 out/u)
  assert.match(verifier.detail ?? '', /reported cost: \$0.0020/u)
  assert.match(reviewer.detail ?? '', /tokens: not reported\ncost: not reported/u)
  assert.doesNotMatch(reviewer.detail ?? '', /0 in|\$0\.0000/u)
  assert.equal(orphan.depth, 0)
  assert.match(orphan.detail ?? '', /parent not reported; depth unknown/u)
  assert.equal(cycle.depth, 0)
  assert.match(cycle.detail ?? '', /cycle reported; depth unknown/u)
  assert.equal(verifier.entityType, undefined, 'native children are not Runtime worker entities')
  const view = buildBraidViewModel(state)
  const workerRows = activityDocument(view, 'workers').rows
  assert.equal(workerRows.length, 10)
  assert.ok(workerRows.every((row) => row.kind === 'native-child'))
  assert.ok(
    workerRows.findIndex((row) => row.id === reviewer.id) <
      workerRows.findIndex((row) => row.id === verifier.id),
    'the native parent appears before its nested child',
  )
  assert.equal(activityDocument(view, 'runs').rows.length, 2)
  assert.equal(view.activity.find((item) => item.id === verifier.id)?.status, 'failed')
  assert.deepEqual(
    sessionUsageFor(state),
    sessionUsageFor({
      ...state,
      runs: state.runs.map((run) => ({
        ...run,
        nativeChildren: { children: [], appliedEventIds: [], truncated: false },
      })),
    }),
    'native usage does not increase direct-turn or Runtime-worker totals',
  )

  const collision = projectActivityDocument({
    ...view,
    messages: [
      {
        id: 'message-with-matching-event',
        role: 'assistant',
        text: '',
        status: 'complete',
        runId: firstRun.id,
        parts: [
          {
            id: 'tool-part',
            kind: 'tool',
            text: '',
            status: 'complete',
            sourceEventId: verifier.sourceEventId,
          },
        ],
      },
    ],
  }).items.find((item) => item.id === verifier.id)
  assert.equal(collision?.status, 'failed', 'a matching tool source cannot overwrite child status')
})

for (const [columns, rows] of [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
] as const) {
  test(`native child details remain keyboard reachable at ${columns}×${rows}`, async () => {
    const app = await nativeFixture([
      child(),
      child({
        childId: 'verifier',
        parentChildId: 'reviewer',
        sourceEventId: 'verifier-failed',
        title: 'Verify patch',
        status: 'failed',
        time: { started, updated: started + 500, ended: started + 500 },
        terminalReason: 'Test failed.',
        usage: { inputTokens: 5, outputTokens: 3 },
      }),
    ])
    let view = buildBraidViewModel(app.state())
    const selected = view.activity.find((item) => item.title === 'Verify patch')
    assert.ok(selected)
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    let closed = false
    const browser = new ActivityBrowserPanel(theme, {
      view: () => view,
      rows: () => terminal.rows,
      scope: 'workers',
      selectedId: selected.id,
      onClose: () => {
        closed = true
      },
    })
    tui.showOverlay(browser, { anchor: 'top-left', margin: 0, width: '100%', maxHeight: '100%' })
    tui.start()
    try {
      await terminal.waitForRender()
      assert.equal(browser.selectedId, selected.id)
      assert.match(terminal.getViewport().join('\n'), /Verify patch/u)
      terminal.sendInput('\r')
      await terminal.waitForRender()
      const detailPages = [terminal.getViewport().join('\n')]
      for (let page = 0; page < 6; page += 1) {
        terminal.sendInput('\u001b[6~')
        await terminal.waitForRender()
        const viewport = terminal.getViewport()
        assert.ok(viewport.every((line) => visibleWidth(line) <= columns))
        detailPages.push(viewport.join('\n'))
      }
      const details = detailPages.join('\n').replace(/\s+/gu, ' ')
      assert.match(details, /Native child · failed · read only/u)
      assert.match(details, /parent child: reviewer/u)
      assert.match(details, /observed tokens: 5 in \/ 3 out/u)
      assert.match(details, /terminal reason: Test failed\./u)
      const updatedActivity = view.activity.map((item) =>
        item.id === selected.id
          ? { ...item, detail: `${item.detail}\nrefreshed observation` }
          : item,
      )
      view = { ...view, activity: updatedActivity }
      tui.requestRender()
      await terminal.waitForRender()
      assert.equal(browser.selectedId, selected.id, 'refresh preserves selected child identity')
      terminal.sendInput('\u001b')
      await terminal.waitForRender()
      if (!closed) terminal.sendInput('\u001b')
      await terminal.waitForRender()
      assert.equal(closed, true)
    } finally {
      tui.stop()
    }
  })
}

test('native child keyboard actions explain unavailable controls without dispatching a worker action', async () => {
  const app = await nativeFixture([child()])
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  let serial = 0
  const ui = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme,
    workspace: '/workspace',
    nextOperationId: () => `op-native-controls-${serial++}`,
  })
  const done = ui.start()
  try {
    for (const key of ['s', 'x', 'a']) {
      terminal.sendInput('/activity')
      terminal.sendInput('\r')
      await terminal.waitForRender()
      for (let scope = 0; scope < 3; scope += 1) terminal.sendInput('\t')
      await terminal.waitForRender()
      assert.match(terminal.getViewport().join('\n'), /Survey code/u)
      const before = app.events().length
      terminal.sendInput(key)
      await terminal.waitForRender()
      assert.match(terminal.getViewport().join('\n'), /native child controls unavailable/u)
      assert.equal(app.events().length, before, 'no Runtime worker mutation was admitted')
      terminal.sendInput('\u001b')
      await terminal.waitForRender()
    }
  } finally {
    ui.stop()
    await done
  }
})
