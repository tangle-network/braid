import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import type { ProfileSummary } from '../src/app/profiles.js'
import { FixedClock } from '../src/ports/clock.js'
import type { BraidUiController } from '../src/views/shared/intents.js'
import type { BraidViewModel, InteractionView, ViewStatus } from '../src/views/shared/models.js'
import { ActivityView } from '../src/views/tui/activity.js'
import { AnalysisViewPanel } from '../src/views/tui/analysis.js'
import { profileItems } from '../src/views/tui/configuration-presenters.js'
import { ConnectionSetupViewPanel } from '../src/views/tui/connection-setup.js'
import { DetailsViewPanel } from '../src/views/tui/details.js'
import { DynamicAutocompleteProvider } from '../src/views/tui/dynamic-autocomplete.js'
import { ForkPreviewPanel } from '../src/views/tui/fork-preview.js'
import { GraphView } from '../src/views/tui/graph.js'
import { HelpViewPanel } from '../src/views/tui/help.js'
import { InteractionShell } from '../src/views/tui/interaction.js'
import { layoutFor } from '../src/views/tui/layout.js'
import { ProfileEditorViewPanel } from '../src/views/tui/profile-editor.js'
import { SearchableSelector } from '../src/views/tui/selector.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { TerminalChrome } from '../src/views/tui/terminal-chrome.js'
import { BraidShell } from '../src/views/tui/terminal-shell.js'
import { metricsFor } from '../src/views/tui/terminal-usage.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import {
  STREAMING_TAIL_BYTES,
  streamingTailText,
  TranscriptView,
} from '../src/views/tui/transcript.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme({ colors: false, highContrast: true, reducedMotion: true })
const sgrPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')

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
    conversationId: 'conversation-fixture',
    conversationTitle: 'Fixture conversation',
    conversations: [],
    branch: 'branch-1',
    status,
    statusText: status,
    queueCount: status === 'waiting' ? 1 : 0,
    sessionUsage: {
      turns: {
        sourceCount: 1,
        input: 6,
        output: 12,
        tokenStatus: 'complete',
        costUsd: 0.001,
        costStatus: 'reported',
        unknownTokenSources: 0,
        unknownCostSources: 0,
      },
      analyses: {
        sourceCount: 0,
        input: 0,
        output: 0,
        tokenStatus: 'unknown',
        costStatus: 'unknown',
        unknownTokenSources: 0,
        unknownCostSources: 0,
      },
      delegated: {
        sourceCount: 0,
        input: 0,
        output: 0,
        tokenStatus: 'unknown',
        costStatus: 'unknown',
        unknownTokenSources: 0,
        unknownCostSources: 0,
      },
      attribution: 'complete',
    } satisfies BraidViewModel['sessionUsage'],
    environments: [],
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

test('no-color and reduced-motion TUI suppress terminal metadata', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const titles: string[] = []
  terminal.setTitle = (title) => titles.push(title)
  const tui = new TuiMainScreen(terminal)
  const view = viewFor('ready')
  const controller = {
    view: () => view,
    subscribe: () => () => {},
    dispatch: async () => ({ kind: 'accepted' as const, revision: view.revision }),
  } as unknown as BraidUiController
  const app = new BraidTerminalApp({
    controller,
    tui,
    theme,
    workspace: '/workspace',
    nextOperationId: () => 'op-terminal-metadata',
  })
  const done = app.start()
  assert.deepEqual(titles, [])
  app.stop()
  await done
})

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
  assert.match(activity.render(80).join('\n'), /live work/u)
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

test('stable chrome keeps identity and status outside transcript history', () => {
  const chrome = new TerminalChrome(theme)
  chrome.setState({
    view: viewFor('completed'),
    quitArmed: false,
    activityVisible: false,
    navigationHint: '/ commands · Ctrl+P',
    composerMode: 'queue',
  })
  const lines = chrome.render(40)
  const firstLine = lines[0] ?? ''
  assert.equal(lines.length, 1)
  assert.equal(firstLine, 'reviewer')
  assert.doesNotMatch(firstLine, /fixture|deterministic/u)
  assert.ok(visibleWidth(firstLine) <= 40)

  const standard = chrome.render(80)
  assert.equal(standard.length, 1)
  assert.match(standard[0] ?? '', /reviewer.*pi/u)
  assert.match(standard[0] ?? '', /via local/u)
  assert.doesNotMatch(standard[0] ?? '', /fixture|deterministic fixture/u)
  assert.doesNotMatch(standard[0] ?? '', /\/ commands/u)
  assert.doesNotMatch(standard[0] ?? '', /Ctrl\+P/u)
  const wide = chrome.render(120).join('\n')
  assert.match(wide, /profile reviewer · harness pi · backend local/u)
  assert.doesNotMatch(wide, /fixture|deterministic|50ms|in 6|out 12/u)
  for (const line of standard) assert.ok(visibleWidth(line) <= 80)
})

test('empty transcript keeps its starter hint beside the composer', () => {
  const transcript = new TranscriptView(theme)
  transcript.setViewportRows(8)
  transcript.setView({
    ...viewFor('empty'),
    messages: [],
    runs: [],
  })
  const lines = transcript.render(80)
  assert.equal(lines.at(-1)?.trimEnd(), ' Ask reviewer anything.')
})

test('terminal chrome aggregates known conversation metrics without filling gaps', () => {
  const baseRun = { status: 'completed' as const, completeness: 'complete' as const }
  const view = viewFor('completed')
  const mixed = {
    ...view,
    runs: [
      { ...baseRun, id: 'run-1', usage: { input: 2, costUsd: 0.01 } },
      { ...baseRun, id: 'run-2', usage: { output: 5 } },
      { ...baseRun, id: 'run-3', usage: { input: 3, output: 1, costUsd: 0.02 } },
    ],
    sessionUsage: {
      ...view.sessionUsage,
      turns: {
        ...view.sessionUsage.turns,
        sourceCount: 3,
        input: 5,
        output: 6,
        costUsd: 0.03,
      },
    },
  }
  assert.deepEqual(metricsFor(mixed), ['in 5', 'out 6', '$0.0300'])
  assert.deepEqual(
    metricsFor({
      ...view,
      runs: [{ ...baseRun, id: 'run-missing', usage: { output: 0 } }],
      sessionUsage: {
        ...view.sessionUsage,
        turns: {
          sourceCount: 1,
          output: 0,
          tokenStatus: 'complete',
          costStatus: 'unknown',
          unknownTokenSources: 0,
          unknownCostSources: 1,
        },
      },
    }),
    ['out 0'],
  )
  assert.deepEqual(
    metricsFor({
      ...view,
      runs: [{ ...baseRun, id: 'run-none' }],
      sessionUsage: {
        ...view.sessionUsage,
        turns: {
          sourceCount: 1,
          tokenStatus: 'unknown',
          costStatus: 'unknown',
          unknownTokenSources: 1,
          unknownCostSources: 1,
        },
      },
    }),
    [],
  )
})

test('transcript history stays anchored while reading and follows new output at the tail', () => {
  const view = viewFor('completed')
  const messages = Array.from({ length: 12 }, (_, index) => ({
    id: `history-${index}`,
    role: 'user' as const,
    text: `turn-${index}`,
    status: 'complete' as const,
    parts: [{ id: `history-${index}:text`, kind: 'text' as const, text: `turn-${index}` }],
  }))
  const transcript = new TranscriptView(theme)
  transcript.setViewportRows(6)
  transcript.setView({ ...view, messages })
  assert.match(transcript.render(80).join('\n'), /turn-11/u)
  assert.equal(transcript.followTail, true)

  assert.equal(transcript.handleInput('\u001b[H'), true)
  assert.equal(transcript.followTail, false)
  assert.match(transcript.render(80).join('\n'), /turn-0/u)

  const appended = {
    ...view,
    messages: [
      ...messages,
      {
        id: 'history-12',
        role: 'assistant' as const,
        text: 'turn-12',
        status: 'streaming' as const,
        parts: [{ id: 'history-12:text', kind: 'text' as const, text: 'turn-12' }],
      },
    ],
  }
  transcript.setView(appended)
  assert.match(transcript.render(80).join('\n'), /turn-0/u)

  assert.equal(transcript.handleInput('\u001b[F'), true)
  assert.equal(transcript.followTail, true)
  transcript.setView({
    ...appended,
    messages: [
      ...appended.messages,
      {
        id: 'history-13',
        role: 'assistant' as const,
        text: 'turn-13',
        status: 'complete' as const,
        parts: [{ id: 'history-13:text', kind: 'text' as const, text: 'turn-13' }],
      },
    ],
  })
  assert.match(transcript.render(80).join('\n'), /turn-13/u)
})

test('streaming transcript bounds the live tail and restores full history on demand', () => {
  const text = `old-stream-marker\n${'history-line\n'.repeat(4_100)}${'word '.repeat(45_000)}latest-stream-marker`
  const transcript = new TranscriptView(theme)
  transcript.setViewportRows(6)
  transcript.setView({
    ...viewFor('streaming'),
    messages: [
      {
        id: 'long-stream',
        role: 'assistant',
        text,
        status: 'streaming',
        parts: [{ id: 'long-stream:text', kind: 'text', text, status: 'running' }],
      },
    ],
  })

  const tail = transcript.render(80).join('\n')
  assert.doesNotMatch(tail, /old-stream-marker/u)
  assert.match(tail, /latest-stream-marker/u)

  assert.equal(transcript.handleInput('\u001b[H'), true)
  assert.match(transcript.render(80).join('\n'), /old-stream-marker/u)
  assert.equal(transcript.followTail, false)

  assert.equal(transcript.handleInput('\u001b[F'), true)
  assert.match(transcript.render(80).join('\n'), /latest-stream-marker/u)
  assert.equal(transcript.followTail, true)
})

test('streaming tail stays within 32 KiB and starts on complete graphemes', () => {
  const graphemes = ['漢', 'e\u0301', '👍🏽', '🇺🇸', '👩🏽‍💻']
  for (const grapheme of graphemes) {
    const text = `prefix-${grapheme.repeat(20_000)}-suffix`
    const tail = streamingTailText(text, true)
    assert.ok(Buffer.byteLength(tail, 'utf8') <= STREAMING_TAIL_BYTES)
    assert.match(tail, /^…\n/u)
    assert.equal(tail.slice(2).startsWith(grapheme), true)
    assert.match(tail, /-suffix$/u)
  }
  const combiningBoundary = streamingTailText(`${'x'.repeat(40_000)}\u0301suffix`, true)
  assert.notEqual(combiningBoundary.codePointAt(2), 0x0301)
})

test('drafts keep plain Home and End while Alt bounds and Page keys move history', () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const shell = new BraidShell(
    tui,
    theme,
    () => 24,
    () => {},
    () => {},
  )
  const view = viewFor('completed')
  shell.setView(
    {
      ...view,
      messages: Array.from({ length: 12 }, (_, index) => ({
        id: `shell-${index}`,
        role: 'user' as const,
        text: `shell-${index}`,
        status: 'complete' as const,
        parts: [{ id: `shell-${index}:text`, kind: 'text' as const, text: `shell-${index}` }],
      })),
    },
    false,
  )
  shell.render(80)
  shell.editor.setText('draft')
  assert.equal(shell.handleTranscriptInput('\u001b[H'), false)
  assert.equal(shell.handleTranscriptInput('\u001b[F'), false)
  assert.equal(shell.handleTranscriptInput('\u001b[1;3H'), true)
  assert.equal(shell.handleTranscriptInput('\u001b[1;3F'), true)
  assert.equal(shell.handleTranscriptInput('\u001b[5~'), true)
  assert.equal(shell.handleTranscriptInput('\u001b[6~'), true)
})

test('Ctrl+E cycles through every collapsible detail card', () => {
  const transcript = new TranscriptView(theme)
  transcript.setView(viewFor('completed'))
  transcript.setViewportRows(30)
  assert.match(transcript.navigationHint(), /next detail \(2\/2\)/u)

  assert.equal(transcript.toggleDetails(), true)
  let rendered = transcript.render(100).join('\n')
  assert.match(rendered, /result · complete 2\/2 · details open/u)
  assert.match(rendered, /tool · running 1\/2 · Ctrl\+E details/u)

  assert.equal(transcript.toggleDetails(), true)
  rendered = transcript.render(100).join('\n')
  assert.match(rendered, /tool · running 1\/2 · details open/u)
  assert.match(rendered, /result · complete 2\/2 · Ctrl\+E details/u)
})

test('terminal presentation translates runtime result labels without changing detail access', () => {
  const transcript = new TranscriptView(theme)
  transcript.setView({
    ...viewFor('completed'),
    messages: [
      {
        id: 'assistant-result',
        role: 'assistant',
        text: 'done',
        status: 'complete',
        parts: [
          {
            id: 'part-result',
            kind: 'analysis',
            text: 'receipt details',
            subject: { type: 'proposal', title: 'agent-turn-result' },
          },
        ],
      },
    ],
  })

  const rendered = transcript.render(80).join('\n')
  assert.match(rendered, /run result · Ctrl\+E details/u)
  assert.doesNotMatch(rendered, /agent-turn-result|unknown|collapsed/u)
})

test('one searchable selector preserves query and supports keyboard selection', () => {
  let selected = ''
  let cancellations = 0
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
      cancellations += 1
    },
  })
  selector.setQuery('quit')
  selector.handleInput('\r')
  assert.equal(selected, 'quit')
  selector.handleInput('\u001b')
  selector.handleInput('\u001b[D')
  assert.equal(cancellations, 2)
})

test('searchable selector marks descriptions that do not fit the terminal row', () => {
  const selector = new SearchableSelector({
    title: 'commands',
    items: [
      {
        value: 'branch',
        label: '/branch',
        description: 'Create and open a branch at a message boundary',
      },
    ],
    theme,
    markDescriptionOverflow: true,
    onSelect: () => {},
    onCancel: () => {},
  })

  const standard = selector.render(80).join('\n').replace(sgrPattern, '')
  assert.match(standard, /Create and open a branch at a message bound…/u)
  assert.ok(selector.render(80).every((line) => visibleWidth(line) <= 80))

  const wide = selector.render(120).join('\n').replace(sgrPattern, '')
  assert.match(wide, /Create and open a branch at a message boundary/u)
  assert.doesNotMatch(wide, /boundary…/u)
})

test('profile selector rows keep the profile identity intact at responsive widths', () => {
  const profile = {
    id: 'profile-braid-starter',
    name: 'Braid starter',
    tags: [],
    source: {
      kind: 'inline',
      reference: 'workspace',
      label: 'Braid starter',
      writable: false,
      trusted: true,
    },
    digest: 'digest',
    runner: 'pi',
    model: 'openai-codex/gpt-5.6-luna',
    tools: [],
    skills: [],
    connections: [],
  } satisfies ProfileSummary
  const [item] = profileItems([profile], profile.name, profile.id)
  assert(item)
  assert.doesNotMatch(item.description ?? '', /Braid starter/u)

  const selector = new SearchableSelector({
    title: 'profiles',
    items: [item],
    theme,
    onSelect: () => {},
    onCancel: () => {},
  })
  for (const width of [40, 80, 120]) {
    for (const line of selector.render(width)) assert.ok(visibleWidth(line) <= width)
  }
})

test('searching a selector resets stale navigation to the best match', () => {
  let selected = ''
  const selector = new SearchableSelector({
    title: 'commands',
    items: [
      { value: 'quit', label: '/quit', description: 'exit Braid' },
      { value: 'queue', label: '/queue', description: 'queue input' },
    ],
    theme,
    onSelect: (item) => {
      selected = item.value
    },
    onCancel: () => {},
  })
  selector.handleInput('\u001b[B')
  assert.equal(selector.selectedItem()?.value, 'queue')
  selector.setQuery('quit')
  selector.handleInput('\r')
  assert.equal(selected, 'quit')
})

test('slash command autocomplete refreshes descriptions after capabilities change', async () => {
  let description = 'unavailable — complete a run first'
  const provider = new DynamicAutocompleteProvider({
    commands: () => [{ name: 'ask', description }],
    basePath: '/workspace',
  })
  const options = { signal: new AbortController().signal }
  const before = await provider.getSuggestions(['/ask'], 0, 4, options)
  assert.equal(before?.items[0]?.description, description)

  description = 'Analyze a frozen run with citations'
  const after = await provider.getSuggestions(['/ask'], 0, 4, options)
  assert.equal(after?.items[0]?.description, description)
})

const interaction: InteractionView = {
  runId: 'run-1',
  interactionId: 'interaction-1',
  profileName: 'Product engineer',
  runner: 'pi',
  kind: 'permission',
  prompt: 'Allow the tool?',
  subject: { type: 'file', title: 'secret.txt', preview: ['read-only preview'] },
  answerSpec: { kind: 'secret', required: true },
  allowedOutcomes: ['once', 'reject', 'cancel'],
  responseScopes: ['once'],
  queuePosition: 0,
  queueTotal: 1,
  secret: true,
}

test('interaction shell masks secret answers and accepts alt-digit outcomes', () => {
  let response: unknown
  const shell = new InteractionShell(interaction, theme, (value) => {
    response = value
  })
  shell.handleInput('TOPSECRET')
  const rendered = shell.render(80).join('\n')
  assert.equal(rendered.includes('TOPSECRET'), false)
  assert.match(rendered, /Product engineer · pi/u)
  assert.doesNotMatch(rendered, /run-1/u)
  shell.handleInput('\u001b1')
  shell.handleInput('\r')
  assert.deepEqual(response, { outcome: 'once', value: 'TOPSECRET' })
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

test('application view projects canonical graph edges without inventing completeness evidence', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 20 })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  const receipt = app.send({ operationId: 'op-graph', text: 'graph proof' })
  await receipt.admissionReady
  assert.equal(controller.view().runs[0]?.completeness, 'incomplete')
  await receipt.completion
  const view = controller.view()
  assert.equal(view.runs[0]?.completeness, 'unavailable')
  const state = app.state()
  const nodeByReference = new Map(
    state.graphNodes.map((node) => [`${node.reference.kind}:${node.reference.id}`, node]),
  )
  const edgeByDestination = new Map(state.graphEdges.map((edge) => [edge.destination, edge.kind]))
  for (const node of view.graph) {
    const stored = nodeByReference.get(`${node.type}:${node.id}`)
    assert.ok(stored)
    assert.equal(node.edgeLabel, edgeByDestination.get(stored.id))
  }
  assert.deepEqual(
    view.graph.slice(0, 2).map((node) => node.title),
    ['New conversation', 'Main'],
  )
})

test('visual fixtures expose interaction, fork, analysis, and comparison results', async () => {
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

  const analysisApp = createBraidApplication({ fixture: 'deterministic' })
  analysisApp.initialize('/workspace')
  const analysisController = createApplicationUiController(analysisApp, {}, 'analysis')
  assert.equal(analysisController.view().capabilities['analysis.ask']?.available, true)
  const analysis = await analysisController.dispatch({
    type: 'run-command',
    command: 'ask',
    args: ['Where', 'did', 'this', 'run', 'waste', 'time?'],
    operationId: 'op-analysis-fixture',
  })
  assert.equal(analysis.kind, 'accepted')
  assert.equal(
    (analysis.data as { analysis?: { findings?: unknown[] } }).analysis?.findings?.length,
    2,
  )
  assert.equal(
    analysisController.view().activity.some((item) => item.id === 'analysis:analysis-fixture-1'),
    true,
  )
  const replacementAnalysisApp = createBraidApplication({ fixture: 'deterministic' })
  await analysisController.replaceApplication(replacementAnalysisApp, '/replacement-workspace')
  assert.equal(
    analysisController.view().activity.some((item) => item.id === 'analysis:analysis-fixture-1'),
    false,
  )

  const comparisonApp = createBraidApplication({ fixture: 'deterministic' })
  comparisonApp.initialize('/workspace')
  const comparisonController = createApplicationUiController(comparisonApp, {}, 'comparison')
  assert.equal(comparisonController.view().capabilities['analysis.compare']?.available, true)
  const comparison = await comparisonController.dispatch({
    type: 'run-command',
    command: 'compare',
    args: ['run-route-serial', 'run-route-parallel'],
    operationId: 'op-comparison-fixture',
  })
  assert.equal(comparison.kind, 'accepted')
  assert.equal((comparison.data as { paired?: { nPairs?: number } }).paired?.nPairs, 1)
  assert.equal(
    comparisonController
      .view()
      .activity.some((item) => item.id === 'analysis:analysis-fixture-comparison'),
    true,
  )
})

test('approve and reject commands resolve the focused pending interaction', async () => {
  const approvedApp = createBraidApplication({ fixture: 'deterministic' })
  approvedApp.initialize('/workspace')
  const approved = createApplicationUiController(approvedApp, {}, 'interaction')
  const approveResult = await approved.dispatch({
    type: 'run-command',
    command: 'approve',
    operationId: 'op-approve-focused',
    args: [],
  })
  assert.equal(approveResult.kind, 'accepted')
  assert.equal(approved.view().interactions.length, 0)

  const rejectedApp = createBraidApplication({ fixture: 'deterministic' })
  rejectedApp.initialize('/workspace')
  const rejected = createApplicationUiController(rejectedApp, {}, 'interaction')
  const rejectResult = await rejected.dispatch({
    type: 'run-command',
    command: 'reject',
    operationId: 'op-reject-focused',
    args: [],
  })
  assert.equal(rejectResult.kind, 'accepted')
  assert.equal(rejected.view().interactions.length, 0)

  const noPending = await approved.dispatch({
    type: 'run-command',
    command: 'reject',
    operationId: 'op-reject-missing',
    args: [],
  })
  assert.equal(noPending.kind, 'error')
  if (noPending.kind === 'error') assert.equal(noPending.code, 'NO_PENDING_INTERACTION')
})

test('unconfigured runs preserve drafts while active runs queue input', async () => {
  for (const fixture of [false, true]) {
    const terminal = new VirtualTerminal(80, 24)
    const tui = new TuiMainScreen(terminal)
    const app = createBraidApplication(
      fixture
        ? { fixture: 'deterministic', chunkDelayMs: 100 }
        : { journal: new MemoryJournal(new FixedClock()) },
    )
    app.initialize('/workspace')
    if (fixture) {
      const active = app.send({ operationId: 'op-active', text: 'first turn' })
      await active.admissionReady
    }
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
    assert.equal(view.editor.getText(), fixture ? '' : 'unconfigured draft')
    assert.equal(app.state().runs.length, fixture ? 1 : 0)
    if (fixture) {
      assert.deepEqual(
        app.state().queuedInputs.map((queued) => queued.text),
        ['queued draft'],
      )
    }
    if (fixture)
      assert.doesNotMatch(terminal.getViewport().join('\n'), /Queued turns are not exposed/u)
    else assert.match(terminal.getViewport().join('\n'), /Configure a connection/u)
    app.cancelActive()
    view.stop()
    await done
  }
})

test('conversation shortcut opens the searchable conversation picker', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
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
  const screen = terminal.getViewport().join('\n')
  assert.match(screen, /conversation/u)
  assert.match(screen, /New conversation/u)
  assert.match(screen, /type to filter · enter to choose · ←\/esc close/u)
  view.stop()
  await done
})

test('help surface renders keyboard guidance without decorative repetition', () => {
  const help = new HelpViewPanel(theme)
  help.setQuery('')
  const rendered = help.render(80).join('\n')
  assert.match(rendered, /Ctrl\+P/u)
  assert.match(rendered, /Ctrl\+O/u)
  assert.match(rendered, /Ctrl\+K/u)
  assert.match(rendered, /Ctrl\+G/u)
  assert.match(rendered, /Ctrl\+C/u)
  assert.match(rendered, /Ctrl\+D/u)
  assert.match(rendered, /\/help/u)
})
