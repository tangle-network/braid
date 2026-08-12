import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { BraidViewModel } from '../src/views/shared/models.js'
import { ActivityView } from '../src/views/tui/activity.js'
import { activityDocument } from '../src/views/tui/activity-browser.js'
import { projectActivityDocument } from '../src/views/tui/activity-document.js'
import { activityVisibleFor } from '../src/views/tui/terminal-input-controller.js'
import { BraidShell } from '../src/views/tui/terminal-shell.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

test('one activity document preserves event status, tree identity, duration, usage, and source', () => {
  const view = activityView()
  const document = projectActivityDocument(view)
  const toolCall = document.items.find((item) => item.id === 'tool-call')
  const toolResult = document.items.find((item) => item.id === 'tool-result')
  const run = document.items.find((item) => item.id === 'run-1')

  assert.equal(toolCall?.status, 'running')
  assert.equal(toolResult?.status, 'failed')
  assert.equal(toolResult?.summary, 'permission denied')
  assert.equal(toolResult?.durationMs, 42)
  assert.deepEqual(toolResult?.source, {
    eventId: 'event-tool-result',
    entityType: 'run',
    entityId: 'run-1',
  })
  assert.equal(toolResult?.parentId, 'run-1')
  assert.equal(toolResult?.depth, 1)
  assert.deepEqual(run?.usage, view.runs[0]?.usage)

  const secondRun = {
    ...view,
    messages: [
      ...view.messages,
      {
        id: 'assistant-2',
        role: 'assistant' as const,
        text: '',
        status: 'complete' as const,
        runId: 'run-2',
        parts: [
          {
            id: 'part-tool-result-2',
            kind: 'result' as const,
            text: '',
            status: 'complete' as const,
            sourceEventId: 'event-tool-result',
          },
        ],
      },
    ],
    activity: [
      ...view.activity,
      {
        id: 'tool-result-2',
        kind: 'tool' as const,
        title: 'shell',
        status: 'completed' as const,
        sourceEventId: 'event-tool-result',
        runId: 'run-2',
      },
    ],
  }
  assert.equal(
    projectActivityDocument(secondRun).items.find((item) => item.id === 'tool-result-2')?.status,
    'complete',
  )

  const browserRows = activityDocument(view).rows
  assert.equal(browserRows.find((row) => row.id === 'tool-result')?.status, 'failed')

  const recordedRun = view.runs[0]
  assert.ok(recordedRun)
  const missingUsage = activityDocument({
    ...view,
    runs: [
      {
        ...recordedRun,
        usage: {
          tokenStatus: 'unknown',
          costStatus: 'unknown',
        },
      },
    ],
  })
  const missingDetail = missingUsage.rows.find((row) => row.id === 'run-1')?.detailLines.join('\n')
  assert.match(missingDetail ?? '', /model calls: not reported/u)
  assert.match(missingDetail ?? '', /model latency: not reported/u)
  assert.match(missingDetail ?? '', /token measurement: not reported/u)
  assert.match(missingDetail ?? '', /cost measurement: not reported/u)

  const rail = new ActivityView(theme)
  rail.setView(view)
  assert.match(rail.render(80).join('\n'), /running shell.*started/u)
  assert.doesNotMatch(rail.render(80).join('\n'), /failed shell|permission denied/u)
})

test('the wide live-work rail uses a divider and remains explicitly opt-in', async () => {
  assert.equal(activityVisibleFor({ activeRunId: 'run-1' }, 'auto'), false)
  assert.equal(activityVisibleFor({}, 'auto'), false)
  assert.equal(activityVisibleFor({}, 'visible'), true)
  assert.equal(activityVisibleFor({ activeRunId: 'run-1' }, 'hidden'), false)

  const view = activityView()
  const terminal = new VirtualTerminal(120, 30)
  const tui = new TuiMainScreen(terminal)
  const shell = new BraidShell(
    tui,
    theme,
    () => terminal.rows,
    () => {},
    () => {},
  )
  shell.setView(view, false)
  shell.setActivityVisible(true)
  tui.addChild(shell)
  tui.start()
  await terminal.waitForRender()

  assert.match(terminal.getViewport().join('\n'), /│/u)
  tui.stop()
})

function activityView(): BraidViewModel {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const base = createApplicationUiController(app).view()
  return {
    ...base,
    messages: [
      {
        id: 'assistant-1',
        role: 'assistant',
        text: 'The shell failed.',
        status: 'complete',
        runId: 'run-1',
        parts: [
          {
            id: 'part-tool-call',
            kind: 'tool',
            text: '',
            status: 'running',
            sourceEventId: 'event-tool-call',
            toolName: 'shell',
          },
          {
            id: 'part-tool-result',
            kind: 'result',
            text: '',
            status: 'failed',
            sourceEventId: 'event-tool-result',
            toolName: 'shell',
            error: 'permission denied',
          },
        ],
      },
    ],
    runs: [
      {
        id: 'run-1',
        status: 'completed',
        completeness: 'complete',
        usage: {
          input: 100,
          output: 50,
          costUsd: 0.02,
          costStatus: 'reported',
          tokenStatus: 'complete',
          elapsedMs: 123,
        },
      },
    ],
    activity: [
      {
        id: 'run-1',
        kind: 'run',
        title: 'run run-1',
        status: 'completed',
        runId: 'run-1',
        entityType: 'run',
        entityId: 'run-1',
        elapsedMs: 123,
      },
      {
        id: 'tool-call',
        kind: 'tool',
        title: 'shell',
        status: 'completed',
        detail: 'started',
        sourceEventId: 'event-tool-call',
        runId: 'run-1',
        entityType: 'run',
        entityId: 'run-1',
        parentId: 'run-1',
        depth: 1,
      },
      {
        id: 'tool-result',
        kind: 'tool',
        title: 'shell',
        status: 'completed',
        detail: 'permission denied',
        elapsedMs: 42,
        sourceEventId: 'event-tool-result',
        runId: 'run-1',
        entityType: 'run',
        entityId: 'run-1',
        parentId: 'run-1',
        depth: 1,
      },
    ],
  }
}
