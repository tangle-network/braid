import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { comparePairedArms } from '@tangle-network/agent-eval'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import type { AnalysisComparisonResult } from '../src/app/analysis-comparison-contracts.js'
import { createBraidApplication } from '../src/app/composition.js'
import type { BraidViewModel, InteractionView } from '../src/views/shared/models.js'
import { ActivityBrowserPanel } from '../src/views/tui/activity-browser.js'
import { AnalysisViewPanel } from '../src/views/tui/analysis.js'
import {
  comparisonLines,
  comparisonViewForResult,
  ComparisonViewPanel,
} from '../src/views/tui/comparison.js'
import { ConversationConfirmation } from '../src/views/tui/conversation-dialogs.js'
import { ForkPreviewPanel } from '../src/views/tui/fork-preview.js'
import { GraphView } from '../src/views/tui/graph.js'
import { InteractionShell } from '../src/views/tui/interaction.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme(false)

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal input')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function renderOverlay(
  component: Parameters<TuiMainScreen['showOverlay']>[0],
  columns: number,
  rows: number,
): Promise<string[]> {
  const terminal = new VirtualTerminal(columns, rows)
  const tui = new TuiMainScreen(terminal)
  tui.showOverlay(component, {
    anchor: 'top-left',
    margin: 0,
    width: '100%',
    maxHeight: '100%',
  })
  tui.start()
  try {
    await terminal.waitForRender()
    return terminal.getViewport()
  } finally {
    tui.stop()
  }
}

function baseView(): BraidViewModel {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  return createApplicationUiController(app).view()
}

function assertFits(lines: readonly string[], columns: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= columns, line)
}

function forkView(): BraidViewModel {
  return {
    ...baseView(),
    forkPreview: {
      kind: 'conversation',
      source: 'conversation:source / branch:main',
      destination: 'conversation:copy / branch:fork',
      fields: [
        {
          label: 'transcript boundary',
          source: 'message:42',
          destination: 'message:42',
        },
        {
          label: 'profile snapshot',
          source: 'profile:source-digest',
          destination: 'profile:copy-digest',
        },
        {
          label: 'working tree',
          source: 'checkpoint:source',
          destination: 'checkpoint:copy',
        },
        {
          label: 'operation id',
          source: 'operation-fork-preview',
          destination: 'operation-fork-preview',
        },
        {
          label: 'plan digest',
          source: 'digest:fork-preview',
          destination: 'digest:fork-preview',
        },
      ],
      allowed: true,
    },
  }
}

function graphView(): BraidViewModel {
  return {
    ...baseView(),
    branch: 'branch-current',
    graph: [
      {
        id: 'conversation-1',
        type: 'conversation',
        title: 'Terminal workflow',
        status: 'completed',
        depth: 0,
      },
      {
        id: 'branch-current',
        type: 'branch',
        title: 'Main',
        status: 'completed',
        depth: 1,
        edgeLabel: 'continued',
      },
      {
        id: 'analysis-1',
        type: 'analysis',
        title: 'failure',
        status: 'completed',
        depth: 2,
        edgeLabel: 'analyzed',
      },
      {
        id: 'comparison-1',
        type: 'analysis',
        title: 'paired runs',
        status: 'completed',
        depth: 2,
        edgeLabel: 'compared_left',
      },
    ],
  }
}

function analysisView(recipe: string): BraidViewModel {
  return {
    ...baseView(),
    analysis: {
      source: 'run:source-run · digest:source-digest',
      question: 'Where did this run waste time?',
      analyst: 'profile:analyst',
      recipe,
      status: 'completed',
      findings: [
        {
          id: 'finding-1',
          title: 'retry dominates wait',
          severity: 'high',
          confidence: 'high',
          citationIds: ['event-1'],
        },
      ],
      citations: [
        {
          id: 'event-1',
          eventId: 'event-1',
          text: 'retry started after the provider timeout',
        },
      ],
      footer: [{ label: 'cost', value: '$0.02 · 120ms' }],
    },
  }
}

const permission: InteractionView = {
  runId: 'run-permission',
  interactionId: 'interaction-permission',
  kind: 'permission',
  prompt: 'Allow the runner to read this file?',
  subject: {
    type: 'file',
    title: 'src/app/application.ts',
    target: 'read-only',
    detail: 'The runner will inspect the current source without changing it.',
  },
  answerSpec: { kind: 'boolean', required: true },
  allowedOutcomes: ['accept', 'reject', 'cancel'],
  responseScopes: ['once', 'session'],
  queuePosition: 0,
  secret: false,
}

test('core workflow overlays keep mode, consequence, and controls visible at 40x12 and 80x24', async () => {
  const fork = new ForkPreviewPanel(theme)
  fork.setView(forkView())
  const graph = new GraphView(theme)
  graph.setView(graphView())

  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
  ] as const) {
    const forkScreen = await renderOverlay(fork, columns, rows)
    assertFits(forkScreen, columns)
    assert.match(forkScreen.join('\n'), /source: conversation:source/u)
    assert.match(forkScreen.join('\n'), /destination: conversation:copy/u)
    assert.match(forkScreen.join('\n'), /boundary: message:42/u)
    assert.match(forkScreen.join('\n'), /enter\/y create fork · ←\/esc cancel/u)

    const graphScreen = await renderOverlay(graph, columns, rows)
    assertFits(graphScreen, columns)
    assert.match(graphScreen.join('\n'), /Main · branch .*current/u)
    if (columns === 80) {
      assert.match(graphScreen.join('\n'), /─analyzed→/u)
      assert.match(graphScreen.join('\n'), /─compared left→/u)
    }
    assert.match(graphScreen.join('\n'), /esc close/u)
  }
})

test('long workflow state preserves the closing key instead of pushing it below 40x12', async () => {
  const fork = new ForkPreviewPanel(theme)
  const forkBase = forkView().forkPreview
  assert(forkBase)
  fork.setView({
    ...forkView(),
    forkPreview: {
      ...forkBase,
      fields: [
        ...forkBase.fields,
        ...Array.from({ length: 8 }, (_, index) => ({
          label: `metadata ${index + 1}`,
          source: `source-${index + 1}`,
          destination: `destination-${index + 1}`,
        })),
      ],
    },
  })
  const forkScreen = await renderOverlay(fork, 40, 12)
  assert.match(forkScreen.join('\n'), /enter\/y create fork · ←\/esc cancel/u)

  const graph = new GraphView(theme)
  graph.setView({
    ...graphView(),
    graph: Array.from({ length: 16 }, (_, index) => ({
      id: index === 15 ? 'branch-current' : `run-${index + 1}`,
      type: index === 15 ? ('branch' as const) : ('run' as const),
      title: index === 15 ? 'Main' : `run ${index + 1}`,
      status: 'completed' as const,
      depth: index === 15 ? 1 : 2,
      ...(index === 15 ? { edgeLabel: 'continued' } : {}),
    })),
  })
  const graphScreen = await renderOverlay(graph, 40, 12)
  assert.match(graphScreen.join('\n'), /Main · branch .*current/u)
  assert.match(graphScreen.join('\n'), /16\/16/u)
  assert.match(graphScreen.join('\n'), /esc close/u)

  graph.handleInput('\u001b[H')
  assert.match(graph.render(40).join('\n'), /1\/16/u)
  graph.handleInput('\u001b[F')
  graph.handleInput('\u001b[C')
  assert.match(graph.render(40).join('\n'), /id: branch-current/u)
  graph.handleInput('\u001b[D')
  assert.match(graph.render(40).join('\n'), /Main · branch .*current/u)

  const analysisBase = analysisView('failure')
  const analysisValue = analysisBase.analysis
  assert(analysisValue)
  const analysis = new AnalysisViewPanel(theme)
  analysis.setView({
    ...analysisBase,
    analysis: {
      ...analysisValue,
      findings: Array.from({ length: 8 }, (_, index) => ({
        id: `finding-${index + 1}`,
        title: `finding ${index + 1}`,
        severity: 'high',
        confidence: 'medium',
        citationIds: [`event-${index + 1}`],
      })),
      citations: Array.from({ length: 8 }, (_, index) => ({
        id: `event-${index + 1}`,
        eventId: `event-${index + 1}`,
        text: `evidence ${index + 1}`,
      })),
      footer: [
        { label: 'cost', value: '$0.02' },
        { label: 'wall', value: '120ms' },
      ],
      error: 'The analysis adapter returned an unavailable result.',
    },
  })
  const analysisScreen = await renderOverlay(analysis, 40, 12)
  assert.match(analysisScreen.join('\n'), /page 1\/\d+/u)
  analysis.handleInput('\u001b[6~')
  assert.match(analysis.render(40).join('\n'), /finding 4/u)
  assert.match(analysisScreen.join('\n'), /←\/esc back/u)
})

test('one activity browser keeps selection stable and makes left and escape equivalent', () => {
  const original = baseView()
  let current: BraidViewModel = {
    ...original,
    activity: [
      {
        id: 'analysis:older',
        kind: 'analysis',
        title: 'ask',
        status: 'completed',
        detail: 'Why did the first run stop?',
        entityType: 'analysis',
        entityId: 'older',
      },
      {
        id: 'analysis:newer',
        kind: 'analysis',
        title: 'failure',
        status: 'completed',
        detail: 'Find the retry loop.',
        entityType: 'analysis',
        entityId: 'newer',
      },
    ],
    entityDetails: [
      {
        entityType: 'analysis',
        entityId: 'older',
        title: '/ask · frozen question',
        status: 'completed',
        lines: ['source: older · frozen', '• [event-1] Retry stopped after one attempt.'],
      },
      {
        entityType: 'analysis',
        entityId: 'newer',
        title: '/analyze · failure',
        status: 'completed',
        lines: [
          'source: newer · frozen',
          '• [event-2] The retry loop reached its limit after the second provider attempt; final-proof-token remains visible.',
        ],
      },
    ],
  }
  let closes = 0
  const browser = new ActivityBrowserPanel(theme, {
    view: () => current,
    rows: () => 12,
    onClose: () => {
      closes += 1
    },
    scope: 'analyses',
  })

  const list = browser.render(40).join('\n')
  assert.match(list, /analyses · 2/u)
  assert.match(list, /^─{40}$/mu)
  assert.equal(browser.selectedId, 'analysis:newer')

  browser.handleInput('\u001b[C')
  assert.equal(browser.mode, 'detail')
  const wrappedDetail = browser.render(40)
  assertFits(wrappedDetail, 40)
  assert.match(wrappedDetail.join(' ').replace(/\s+/gu, ' '), /final-proof-token remains visible/u)
  browser.handleInput('\u001b[B')
  assert.equal(browser.selectedId, 'analysis:older')
  assert.match(browser.render(40).join('\n'), /Retry stopped after one/u)

  current = {
    ...current,
    activity: [
      ...current.activity,
      {
        id: 'analysis:latest',
        kind: 'analysis',
        title: 'cost',
        status: 'running',
        entityType: 'analysis',
        entityId: 'latest',
      },
    ],
  }
  browser.render(40)
  assert.equal(browser.selectedId, 'analysis:older')

  browser.handleInput('\u001b[D')
  assert.equal(browser.mode, 'list')
  browser.handleInput('\u001b[D')
  assert.equal(closes, 1)

  const escaped = new ActivityBrowserPanel(theme, {
    view: () => current,
    rows: () => 12,
    onClose: () => {
      closes += 1
    },
    scope: 'analyses',
    selectedId: 'analysis:older',
    openSelected: true,
  })
  escaped.handleInput('\u001b')
  assert.equal(escaped.mode, 'list')
  escaped.handleInput('\u001b')
  assert.equal(closes, 2)
})

test('wide activity keeps the list and details together and tabs through bounded scopes', () => {
  const original = baseView()
  const view: BraidViewModel = {
    ...original,
    activity: [
      {
        id: 'analysis:first',
        kind: 'analysis',
        title: 'first analysis',
        status: 'completed',
        entityType: 'analysis',
        entityId: 'first',
      },
      {
        id: 'analysis:second',
        kind: 'analysis',
        title: 'second analysis',
        status: 'completed',
        entityType: 'analysis',
        entityId: 'second',
      },
    ],
    entityDetails: [
      {
        entityType: 'analysis',
        entityId: 'first',
        title: '/ask · first',
        status: 'completed',
        lines: ['first detail remains visible'],
      },
      {
        entityType: 'analysis',
        entityId: 'second',
        title: '/ask · second',
        status: 'completed',
        lines: ['second detail remains visible'],
      },
    ],
  }
  let leftCloses = 0
  const browser = new ActivityBrowserPanel(theme, {
    view: () => view,
    rows: () => 24,
    onClose: () => {
      leftCloses += 1
    },
    scope: 'analyses',
  })

  const initial = browser.render(120).join('\n')
  assert.match(initial, /\/ask · second/u)
  assert.match(initial, /second detail remains visible/u)
  assert.match(initial, /│/u)
  browser.handleInput('\u001b[B')
  assert.match(browser.render(120).join('\n'), /first detail remains visible/u)
  browser.handleInput('\t')
  assert.match(browser.render(120).join('\n'), /activity · workers · 0/u)
  browser.handleInput('\t')
  assert.match(browser.render(120).join('\n'), /tab filter: all/u)
  browser.handleInput('\u001b[D')
  assert.equal(leftCloses, 1)

  let escapeCloses = 0
  const escaped = new ActivityBrowserPanel(theme, {
    view: () => view,
    rows: () => 24,
    onClose: () => {
      escapeCloses += 1
    },
    scope: 'analyses',
  })
  escaped.render(120)
  escaped.handleInput('\u001b')
  assert.equal(escapeCloses, 1)
})

test('analysis mode copy distinguishes ask, named analyze recipes, and compare', async () => {
  const expected = [
    ['/ask · frozen question', 'ask'] as const,
    ['/analyze · failure', 'failure'] as const,
    ['/compare · paired sources', 'compare'] as const,
  ]
  for (const [heading, recipe] of expected) {
    const panel = new AnalysisViewPanel(theme)
    panel.setView(analysisView(recipe))
    const screen = await renderOverlay(panel, 40, 12)
    assertFits(screen, 40)
    assert.match(
      screen.join('\n'),
      new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'),
    )
    assert.match(screen.join('\n'), /source: run:source-run/u)
    assert.match(screen.join('\n'), /── question/u)
    assert.match(screen.join('\n'), /Where did this run waste time\?/u)
    assert.match(screen.join('\n'), /\[1\].*retry dominates wait/u)
    assert.match(screen.join('\n'), /←\/esc back/u)
  }
})

test('comparison view leads with both outcomes and pages through every captured field', async () => {
  const rows = [
    {
      pairKey: 'pair-1',
      arm: 'baseline',
      pass: true,
      metrics: { cost_usd: 0.02, latency_ms: 120 },
    },
    {
      pairKey: 'pair-1',
      arm: 'candidate',
      pass: false,
      metrics: { latency_ms: 80 },
    },
  ]
  const result: AnalysisComparisonResult = {
    baselineSourceDigest: 'digest-baseline',
    candidateSourceDigest: 'digest-candidate',
    baselineRunId: 'run-baseline',
    candidateRunId: 'run-candidate',
    fields: [
      {
        name: 'run.status',
        baseline: 'completed',
        candidate: 'failed',
        baselinePresent: true,
        candidatePresent: true,
        asymmetry: 'none',
      },
      {
        name: 'run.cost_usd',
        baseline: 0.02,
        baselinePresent: true,
        candidatePresent: false,
        asymmetry: 'baseline-only',
      },
      {
        name: 'run.input_tokens',
        baseline: 100,
        candidate: 80,
        baselinePresent: true,
        candidatePresent: true,
        asymmetry: 'none',
      },
    ],
    rows,
    paired: comparePairedArms(rows, {
      baselineArm: 'baseline',
      treatmentArm: 'candidate',
      bootstrap: { seed: 7 },
    }),
    semantic: {
      status: 'unavailable',
      reason: 'No semantic reviewer was supplied.',
    },
  }
  const view = comparisonViewForResult(result)
  const allLines = comparisonLines(view).join('\n')
  for (const field of result.fields) assert.match(allLines, new RegExp(field.name, 'u'))
  assert.match(allLines, /candidate outcome: failed/u)
  assert.match(allLines, /candidate outcome:[^\n]+cost: missing/u)
  assert.match(allLines, /source: not captured in frozen run/u)
  assert.match(allLines, /One pair is descriptive/u)

  const panel = new ComparisonViewPanel(theme)
  panel.setView(view)
  const firstPage = await renderOverlay(panel, 40, 12)
  assertFits(firstPage, 40)
  assert.match(firstPage.join('\n'), /baseline outcome: completed/u)
  assert.match(firstPage.join('\n'), /candidate outcome: failed/u)
  assert.match(firstPage.join('\n'), /page 1\//u)
  panel.handleInput('\u001b[6~')
  assert.match(panel.render(80).join('\n'), /run\.cost_usd/u)
})

test('approval actions are navigable and secret responses never render values', async () => {
  const responses: unknown[] = []
  const shell = new InteractionShell(permission, theme, (response) => responses.push(response))
  const screen = await renderOverlay(shell, 40, 12)
  assertFits(screen, 40)
  assert.match(screen.join('\n'), /permission/u)
  assert.match(screen.join('\n'), /1\. Approve/u)
  assert.match(screen.join('\n'), /2\. Reject/u)
  assert.match(screen.join('\n'), /3\. Cancel/u)
  assert.match(screen.join('\n'), /↑↓ move · enter confirm/u)

  shell.handleInput('y')
  assert.deepEqual(responses, [{ outcome: 'accept', value: true }])

  const arrowResponses: unknown[] = []
  const arrowShell = new InteractionShell(permission, theme, (response) =>
    arrowResponses.push(response),
  )
  arrowShell.handleInput('\u001b[B')
  assert.match(arrowShell.render(40).join('\n'), /› 2\. Reject/u)
  arrowShell.handleInput('\r')
  assert.deepEqual(arrowResponses, [{ outcome: 'reject' }])

  const secret = 'do-not-render'
  const secretInteraction: InteractionView = {
    ...permission,
    interactionId: 'interaction-secret',
    prompt: 'Provide the provider token.',
    subject: {
      type: 'credential',
      title: 'provider token',
      detail: `token=${secret}`,
      preview: [secret],
    },
    answerSpec: { kind: 'secret', required: true },
    allowedOutcomes: ['once', 'reject', 'cancel'],
    secret: true,
  }
  const secretResponses: unknown[] = []
  const secretShell = new InteractionShell(secretInteraction, theme, (response) => {
    secretResponses.push(response)
  })
  secretShell.handleInput(secret)
  const secretScreen = await renderOverlay(secretShell, 40, 12)
  assertFits(secretScreen, 40)
  assert.doesNotMatch(secretScreen.join('\n'), new RegExp(secret, 'u'))
  assert.match(secretScreen.join('\n'), /secret hidden/u)
  assert.match(secretScreen.join('\n'), /alt\+1 once · alt\+2 reject/u)
  assert.match(secretScreen.join('\n'), /alt\+3 cancel/u)
  secretShell.handleInput('\r')
  assert.deepEqual(secretResponses, [{ outcome: 'once', value: secret }])
})

test('fork and confirmation dialogs expose only short, actionable keys', () => {
  let confirmed = false
  let cancelled = false
  const panel = new ForkPreviewPanel(theme, {
    onConfirm: () => {
      confirmed = true
    },
    onCancel: () => {
      cancelled = true
    },
  })
  panel.setView(forkView())
  panel.handleInput('y')
  assert.equal(confirmed, true)
  panel.handleInput('\u001b')
  assert.equal(cancelled, true)

  const completeFork = forkView()
  const completePreview = completeFork.forkPreview
  assert.ok(completePreview)
  panel.setView({
    ...completeFork,
    forkPreview: {
      ...completePreview,
      fields: completePreview.fields.filter(
        (field) => field.label !== 'operation id' && field.label !== 'plan digest',
      ),
    },
  })
  const incomplete = panel.render(80).join('\n')
  assert.match(incomplete, /missing execution data/u)
  assert.doesNotMatch(incomplete, /enter\/y create fork/u)

  const dialog = new ConversationConfirmation({
    theme,
    title: 'delete conversation',
    target: 'Terminal workflow',
    detail: 'Local history is removed; external environment references remain.',
    confirmLabel: 'delete permanently',
    onConfirm: () => {},
    onCancel: () => {},
  })
  const lines = dialog.render(40)
  assertFits(lines, 40)
  assert.match(lines.join('\n'), /will delete permanently/u)
  assert.match(lines.join('\n'), /enter\/y confirm · n\/esc cancel/u)
})

test('digit-leading text, secret, and number answers stay editable', () => {
  const secretResponse: unknown[] = []
  const secretShell = new InteractionShell(
    {
      ...permission,
      interactionId: 'interaction-digit-secret',
      answerSpec: { kind: 'secret', required: true },
      allowedOutcomes: ['once', 'reject', 'cancel'],
      secret: true,
    },
    theme,
    (response) => secretResponse.push(response),
  )
  secretShell.handleInput('1secret-value')
  assert.doesNotMatch(secretShell.render(40).join('\n'), /secret-value/u)
  secretShell.handleInput('\u001b1')
  assert.deepEqual(secretResponse, [])
  secretShell.handleInput('\r')
  assert.deepEqual(secretResponse, [{ outcome: 'once', value: '1secret-value' }])

  const textResponse: unknown[] = []
  const textShell = new InteractionShell(
    {
      ...permission,
      interactionId: 'interaction-digit-text',
      kind: 'question',
      answerSpec: { kind: 'text', required: true, secret: false },
      allowedOutcomes: ['accept', 'reject', 'cancel'],
      secret: false,
    },
    theme,
    (response) => textResponse.push(response),
  )
  textShell.handleInput('1text-value')
  textShell.handleInput('\r')
  assert.deepEqual(textResponse, [{ outcome: 'accept', value: '1text-value' }])

  const numberResponse: unknown[] = []
  const numberShell = new InteractionShell(
    {
      ...permission,
      interactionId: 'interaction-digit-number',
      kind: 'question',
      answerSpec: { kind: 'number', required: true, minimum: 1 },
      allowedOutcomes: ['once', 'session', 'reject', 'cancel'],
      secret: false,
    },
    theme,
    (response) => numberResponse.push(response),
  )
  numberShell.handleInput('12.5')
  numberShell.handleInput('\u001b2')
  assert.deepEqual(numberResponse, [])
  assert.match(numberShell.render(40).join('\n'), /alt\+2 run/u)
  numberShell.handleInput('\r')
  assert.deepEqual(numberResponse, [{ outcome: 'session', value: 12.5 }])
})

test('short interaction surfaces keep validation failures visible', () => {
  const shell = new InteractionShell(
    {
      ...permission,
      interactionId: 'interaction-invalid-number',
      kind: 'question',
      subject: {
        type: 'file',
        title: 'src/app/application.ts',
        target: 'read-only',
        detail: 'The runner will inspect the current source without changing it.',
        preview: ['A preview row competes with the response controls.'],
      },
      answerSpec: { kind: 'number', required: true, minimum: 1 },
    },
    theme,
    () => {},
    undefined,
    () => 12,
  )

  shell.handleInput('0')
  shell.handleInput('\r')

  const screen = shell.render(40).join('\n')
  assert.match(screen, /Enter a number in the allowed range\./u)
  assert.match(screen, /alt\+1 approve · alt\+2 reject/u)
  assert.match(screen, /alt\+3 cancel/u)
  assert.match(screen, /enter submit · esc cancel/u)
})

test('alt-digit keys reach every allowed outcome without taking editable digits', () => {
  const outcomes = [
    'once',
    'session',
    'persistent',
    'accept',
    'revise',
    'reject',
    'deny',
    'cancel',
  ] as const
  for (const [index, outcome] of outcomes.entries()) {
    const responses: unknown[] = []
    const shell = new InteractionShell(
      {
        ...permission,
        interactionId: `interaction-outcome-${index}`,
        allowedOutcomes: outcomes,
      },
      theme,
      (response) => responses.push(response),
    )
    shell.handleInput(`\u001b${index + 1}`)
    assert.deepEqual(
      responses,
      [{ outcome, ...(isPositive(outcome) ? { value: true } : {}) }],
      `alt+${index + 1} should choose ${outcome}`,
    )
  }
})

test('completed export notices survive real terminal input at every supported width', async () => {
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [100, 30],
    [120, 40],
    [200, 60],
  ] as const) {
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    const app = createBraidApplication({ fixture: 'deterministic' })
    app.initialize('/workspace')
    const controller = createApplicationUiController(app)
    let operation = 0
    const view = new BraidTerminalApp({
      controller,
      tui,
      theme,
      workspace: '/workspace',
      nextOperationId: () => `op-export-notice-${++operation}`,
    })
    const done = view.start()
    try {
      terminal.sendInput('/export markdown')
      terminal.sendInput('\r')
      await waitUntil(
        () => controller.view().notice?.toLocaleLowerCase().includes('markdown') === true,
      )
      await terminal.waitForRender()
      const viewport = terminal.getViewport()
      assert.match(viewport.join('\n'), /prepared markdown export/iu)
      assert.equal(viewport.length, rows)
      assertFits(viewport, columns)
    } finally {
      view.stop()
      await done
    }
  }
})

test('workflow presentation modules stay bounded and acyclic', () => {
  const directSource = new URL('../src/views/tui/interaction.ts', import.meta.url)
  const directRoot = new URL('../src/views/tui/', import.meta.url)
  const compiledRoot = new URL('../../src/views/tui/', import.meta.url)
  const tuiRoot = fileURLToPath(existsSync(directSource) ? directRoot : compiledRoot)
  const interactionPath = join(tuiRoot, 'interaction.ts')
  const overlayPath = join(tuiRoot, 'conversation-overlays.ts')
  const entityBrowserPath = join(tuiRoot, 'entity-browser.ts')
  const activityBrowserPath = join(tuiRoot, 'activity-browser.ts')
  assert.ok(readFileSync(interactionPath, 'utf8').split('\n').length - 1 < 250)
  assert.ok(readFileSync(overlayPath, 'utf8').split('\n').length - 1 < 300)
  assert.ok(readFileSync(entityBrowserPath, 'utf8').split('\n').length - 1 < 450)
  assert.ok(readFileSync(activityBrowserPath, 'utf8').split('\n').length - 1 < 400)

  const files = new Set(tuiSourceFiles(tuiRoot))
  const graph = new Map<string, Set<string>>()
  for (const file of files) {
    const targets = new Set<string>()
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(
      /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)['"](\.[^'"]+)['"]/gu,
    )) {
      const target = resolveTuiImport(file, match[1] ?? '', files)
      if (target !== undefined) targets.add(target)
    }
    graph.set(file, targets)
  }
  assert.deepEqual(findCycles(graph), [])
})

function tuiSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? tuiSourceFiles(path) : extname(path) === '.ts' ? [path] : []
  })
}

function resolveTuiImport(
  importer: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  const raw = resolve(dirname(importer), specifier)
  const candidates = [
    raw,
    raw.endsWith('.js') ? `${raw.slice(0, -3)}.ts` : `${raw}.ts`,
    join(raw, 'index.ts'),
  ]
  return candidates.find((candidate) => files.has(candidate))
}

function findCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const cycles: string[][] = []
  const active: string[] = []
  const activeSet = new Set<string>()
  const visited = new Set<string>()
  const visit = (node: string): void => {
    if (activeSet.has(node)) {
      cycles.push(active.slice(active.indexOf(node)))
      return
    }
    if (visited.has(node)) return
    visited.add(node)
    active.push(node)
    activeSet.add(node)
    for (const target of graph.get(node) ?? []) visit(target)
    active.pop()
    activeSet.delete(node)
  }
  for (const node of graph.keys()) visit(node)
  return cycles
}

function isPositive(outcome: string): boolean {
  return ['accept', 'once', 'session', 'persistent'].includes(outcome)
}
