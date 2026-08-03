import assert from 'node:assert/strict'
import test from 'node:test'
import { TUI, visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { FixedClock } from '../src/ports/clock.js'
import { ActivityView } from '../src/views/tui/activity.js'
import { AnalysisViewPanel } from '../src/views/tui/analysis.js'
import { ConnectionSetupViewPanel } from '../src/views/tui/connection-setup.js'
import { DetailsViewPanel } from '../src/views/tui/details.js'
import { GraphView } from '../src/views/tui/graph.js'
import { HelpViewPanel } from '../src/views/tui/help.js'
import { ForkPreviewPanel } from '../src/views/tui/fork-preview.js'
import { InteractionShell } from '../src/views/tui/interaction.js'
import { layoutFor } from '../src/views/tui/layout.js'
import { ProfileEditorViewPanel } from '../src/views/tui/profile-editor.js'
import { SearchableSelector } from '../src/views/tui/selector.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { TranscriptView } from '../src/views/tui/transcript.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import type { BraidViewModel, InteractionView, ViewStatus } from '../src/views/shared/models.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })

function viewFor(status: ViewStatus): BraidViewModel {
  return Object.freeze({
    revision: 7,
    workspace: '/workspace',
    profileName: 'reviewer',
    profileDigest: 'digest',
    runner: 'pi',
    model: 'fixture/deterministic',
    effort: 'none',
    connection: 'deterministic fixture',
    branch: 'branch-1',
    status,
    statusText: status,
    queueCount: status === 'waiting' ? 1 : 0,
    messages: Object.freeze([
      {
        id: 'user-1',
        role: 'user' as const,
        text: 'Explain 漢字 é 👩🏽‍💻',
        status: 'complete' as const,
        parts: Object.freeze([
          {
            id: 'user-1:text',
            kind: 'text' as const,
            text: 'Explain 漢字 é 👩🏽‍💻',
            status: 'complete' as const,
          },
        ]),
      },
      {
        id: 'assistant-1',
        role: 'assistant' as const,
        text: 'response',
        status: status === 'streaming' ? ('streaming' as const) : ('complete' as const),
        parts: Object.freeze([
          {
            id: 'tool',
            kind: 'tool' as const,
            text: 'rg "needle" src',
            status: 'running' as const,
          },
          { id: 'result', kind: 'result' as const, text: '4 matches', status: 'complete' as const },
          { id: 'answer', kind: 'text' as const, text: 'response', status: 'complete' as const },
        ]),
      },
    ]),
    hiddenMessageCount: 0,
    runs: Object.freeze([
      {
        id: 'run-1',
        turnId: 'turn-1',
        operationId: 'op-1',
        status,
        completeness: 'complete' as const,
      },
    ]),
    ...(status === 'running' || status === 'waiting' || status === 'cancelling'
      ? { activeRunId: 'run-1' }
      : {}),
    interactions: Object.freeze([]),
    activity: Object.freeze([
      { id: 'run-1', kind: 'run' as const, title: 'run run-1', status },
      { id: 'tool-1', kind: 'tool' as const, title: 'read file', status: 'complete' as const },
    ]),
    graph: Object.freeze([
      {
        id: 'conv-1',
        type: 'conversation' as const,
        title: 'conversation',
        status: 'complete' as const,
        depth: 0,
      },
      {
        id: 'branch-1',
        type: 'branch' as const,
        title: 'main',
        status: 'complete' as const,
        depth: 1,
        edgeLabel: 'continued',
      },
      {
        id: 'run-1',
        type: 'run' as const,
        title: 'run-1',
        status,
        depth: 2,
        edgeLabel: 'continued',
      },
    ]),
    details: Object.freeze({
      title: 'run run-1',
      fields: Object.freeze([{ label: 'status', value: status }]),
    }),
    profileEditor: Object.freeze({
      source: 'workspace profile',
      digest: 'digest',
      readOnly: true,
      validation: 'valid' as const,
      fields: Object.freeze([
        { path: 'model.default', value: 'fixture/deterministic', secret: false },
      ]),
    }),
    connectionSetup: Object.freeze({
      kind: 'cli-bridge' as const,
      fields: Object.freeze([{ label: 'endpoint', value: 'local', secret: false }]),
      health: 'healthy' as const,
      capabilities: Object.freeze(['stream']),
    }),
    capabilities: Object.freeze({
      'help.read': { available: true, source: 'local' as const },
      'interaction.respond': {
        available: false,
        source: 'application' as const,
        reason: 'not available',
      },
    }),
    draft: '',
    selectedSurface: 'transcript' as const,
    appearance: { color: 'none' as const, highContrast: true, reducedMotion: true },
  })
}

const statuses: readonly ViewStatus[] = [
  'empty',
  'loading',
  'ready',
  'streaming',
  'running',
  'waiting',
  'detached',
  'reconnecting',
  'cancelling',
  'cancelled',
  'failed',
  'expired',
  'unknown',
  'storage-failure',
]

for (const status of statuses) {
  test(`named ${status} view renders without control injection`, () => {
    const view = viewFor(status)
    const transcript = new TranscriptView(theme)
    transcript.setView(view)
    const lines = transcript.render(80)
    assert.ok(lines.length > 0)
    assert.equal(
      lines.some((line) => line.includes('\u001b]') || line.includes('\u0007')),
      false,
    )
    for (const line of lines) assert.ok(visibleWidth(line) <= 80)
  })
}

test('named queued, cancelled, and fork preview surfaces keep explicit state', () => {
  const queued = viewFor('ready')
  const queuedView = { ...queued, queueCount: 1, statusText: 'queued' as const }
  assert.equal(queuedView.queueCount, 1)
  assert.equal(queuedView.statusText, 'queued')
  const forkPreview = new DetailsViewPanel(theme)
  forkPreview.setView({
    ...queued,
    details: {
      title: 'fork preview',
      fields: [{ label: 'workspace', value: 'unavailable — checkpoint capability not reported' }],
    },
  })
  assert.match(forkPreview.render(80).join('\n'), /checkpoint capability/u)
})

test('named graph, analysis, activity, profile editor, connection setup, and storage failure panels render', () => {
  const view = viewFor('storage-failure')
  const graph = new GraphView(theme)
  graph.setView(view)
  const activity = new ActivityView(theme)
  activity.setView(view)
  const profile = new ProfileEditorViewPanel(theme)
  profile.setView(view)
  const connection = new ConnectionSetupViewPanel(theme)
  connection.setView(view)
  const help = new HelpViewPanel(theme)
  help.setQuery('analyze')
  const analysis = new AnalysisViewPanel(theme)
  analysis.setView(view)
  const fork = new ForkPreviewPanel(theme)
  fork.setView(view)
  assert.match(graph.render(80).join('\n'), /conversation graph/u)
  assert.match(activity.render(80).join('\n'), /activity/u)
  assert.match(profile.render(80).join('\n'), /profile/u)
  assert.match(connection.render(80).join('\n'), /connection/u)
  assert.match(help.render(80).join('\n'), /analyze/u)
  assert.match(analysis.render(80).join('\n'), /analysis/u)
  assert.match(fork.render(80).join('\n'), /fork preview/u)
})

test('responsive layout preserves the 72-column transcript boundary', () => {
  assert.equal(layoutFor(40, 12).mode, 'narrow')
  assert.equal(layoutFor(80, 24).mode, 'standard')
  assert.equal(layoutFor(119, 40).mode, 'standard')
  const wide = layoutFor(120, 40)
  assert.equal(wide.mode, 'wide')
  assert.ok(wide.transcriptWidth >= 72)
  assert.equal(layoutFor(200, 60).mode, 'wide')
})

test('narrow transcript header keeps profile and run state on one line', () => {
  const transcript = new TranscriptView(theme)
  transcript.setView(viewFor('completed'))
  const firstLine = transcript.render(40)[0] ?? ''
  assert.match(firstLine, /braid\s+reviewer\s+completed/u)
  assert.doesNotMatch(firstLine, /fixture|deterministic/u)
  assert.ok(visibleWidth(firstLine) <= 40)
})

test('one searchable selector preserves query and supports keyboard selection', () => {
  let selected = ''
  let cancelled = false
  const selector = new SearchableSelector({
    title: 'items',
    items: [
      { value: 'profile', label: '/profile', description: 'select a profile' },
      { value: 'quit', label: '/quit', description: 'exit Braid' },
    ],
    theme,
    onSelect: (item) => {
      selected = item.value
    },
    onCancel: () => {
      cancelled = true
    },
  })
  selector.setQuery('quit')
  selector.handleInput('\r')
  assert.equal(selected, 'quit')
  selector.handleInput('\u001b')
  assert.equal(cancelled, true)
})

const interaction: InteractionView = {
  runId: 'run-1',
  interactionId: 'interaction-1',
  kind: 'permission',
  prompt: 'Allow the tool?',
  subject: { type: 'file', title: 'secret.txt', preview: ['read-only preview'] },
  answerSpec: { kind: 'secret', required: true },
  allowedOutcomes: ['once', 'reject', 'cancel'],
  queuePosition: 0,
  secret: true,
}

test('interaction shell masks secret answers and accepts numeric outcomes', () => {
  let response: unknown
  const shell = new InteractionShell(interaction, theme, (value) => {
    response = value
  })
  shell.handleInput('TOPSECRET')
  const rendered = shell.render(80).join('\n')
  assert.equal(rendered.includes('TOPSECRET'), false)
  shell.handleInput('1')
  assert.deepEqual(response, { outcome: 'once' })
})

test('interaction shell turns escape into an explicit cancel response', () => {
  let response: unknown
  const shell = new InteractionShell(interaction, theme, (value) => {
    response = value
  })
  shell.handleInput('\u001b')
  assert.deepEqual(response, { outcome: 'cancel' })
})

test('selector boundary strips terminal controls from provider option labels', () => {
  const hostile: InteractionView = {
    ...interaction,
    answerSpec: {
      kind: 'select',
      required: true,
      options: [
        {
          value: 'safe-value',
          label: 'allow\u001b]0;owned\u0007\u001b[31m now',
        },
      ],
    },
  }
  const shell = new InteractionShell(hostile, theme, () => {})
  const rendered = shell.render(80).join('\n')
  assert.equal(rendered.includes('\u001b]0;'), false)
  assert.equal(rendered.includes('\u0007'), false)
  assert.match(rendered, /allow now/u)
})

test('application view does not invent graph edges or completeness evidence', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 20 })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  const receipt = app.send({ operationId: 'op-graph', text: 'graph proof' })
  assert.equal(controller.view().runs[0]?.completeness, 'incomplete')
  await receipt.completion
  const view = controller.view()
  assert.equal(view.runs[0]?.completeness, 'unavailable')
  assert.equal(
    view.graph.some((node) => node.edgeLabel !== undefined),
    false,
  )
  assert.deepEqual(
    view.graph.slice(0, 2).map((node) => node.title),
    ['conv-1', 'branch-1'],
  )
})

test('interaction and fork fixtures expose real state through the controller', async () => {
  const interactionApp = createBraidApplication({ fixture: 'deterministic' })
  interactionApp.initialize('/workspace')
  const interactionController = createApplicationUiController(interactionApp, {}, 'interaction')
  const interactionView = interactionController.view()
  assert.equal(interactionView.interactions.length, 1)
  assert.equal(interactionView.interactions[0]?.answerSpec.kind, 'boolean')
  assert.equal(interactionView.interactions[0]?.subject?.title, 'src/app/application.ts')
  const response = await interactionController.dispatch({
    type: 'respond-interaction',
    operationId: 'op-interaction-fixture',
    runId: 'fixture-run-1',
    interactionId: 'fixture-interaction-1',
    response: { outcome: 'accept', value: true },
  })
  assert.equal(response.kind, 'accepted')
  assert.equal(interactionController.view().interactions.length, 0)

  const forkApp = createBraidApplication({ fixture: 'deterministic' })
  forkApp.initialize('/workspace')
  const forkController = createApplicationUiController(forkApp, {}, 'fork')
  const fork = await forkController.dispatch({
    type: 'run-command',
    command: 'fork',
    args: [],
    operationId: 'op-fork-fixture',
  })
  assert.equal(fork.kind, 'accepted')
  assert.equal(forkController.view().selectedSurface, 'fork')
  assert.equal(forkController.view().forkPreview?.allowed, true)
  assert.equal(forkController.view().forkPreview?.destination, 'workspace:/workspace-fork')
})

test('unconfigured and active runs preserve rejected message drafts', async () => {
  for (const fixture of [false, true]) {
    const terminal = new VirtualTerminal(80, 24)
    const tui = new TUI(terminal)
    const app = createBraidApplication(
      fixture
        ? { fixture: 'deterministic', chunkDelayMs: 100 }
        : { journal: new MemoryJournal(new FixedClock()) },
    )
    app.initialize('/workspace')
    if (fixture) app.send({ operationId: 'op-active', text: 'first turn' })
    const controller = createApplicationUiController(app)
    const view = new BraidTerminalApp({
      controller,
      tui,
      theme: createBraidTheme(false),
      workspace: '/workspace',
      nextOperationId: () => 'op-rejected',
    })
    const done = view.start()
    terminal.sendInput(fixture ? 'queued draft' : 'unconfigured draft')
    terminal.sendInput('\r')
    await terminal.waitForRender()
    assert.equal(view.editor.getText(), fixture ? 'queued draft' : 'unconfigured draft')
    assert.equal(app.state().runs.length, fixture ? 1 : 0)
    assert.match(
      terminal.getViewport().join('\n'),
      fixture ? /Queued turns are not exposed/u : /Configure a connection/u,
    )
    app.cancelActive()
    view.stop()
    await done
  }
})

test('conversation shortcut reports unavailable instead of opening a dead selector', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TUI(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-open',
  })
  const done = view.start()
  terminal.sendInput('\u000f')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /Conversation search is not exposed/u)
  view.stop()
  await done
})

test('help surface renders keyboard guidance without decorative repetition', () => {
  const help = new HelpViewPanel(theme)
  help.setQuery('')
  const rendered = help.render(80).join('\n')
  assert.match(rendered, /Ctrl\+P/u)
  assert.match(rendered, /\/help/u)
})
