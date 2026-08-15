import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CombinedAutocompleteProvider,
  Editor,
  TuiMainScreen,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { InteractionRequestMaterial } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const SIZES = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
] as const

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal input')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function startSteeringTerminal(queue = false): Promise<{
  readonly app: ReturnType<typeof createBraidApplication>
  readonly terminal: VirtualTerminal
  readonly view: BraidTerminalApp
  readonly done: Promise<void>
  readonly calls: {
    send: number
    queue: number
    steer: number
    readonly steerTexts: string[]
  }
}> {
  let releaseStream: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => ({
      ...DEFAULT_RUN_CAPABILITIES,
      controls: { ...DEFAULT_RUN_CAPABILITIES.controls, queue, steer: true },
    }),
    async *streamTurn(input): AsyncIterable<never> {
      await new Promise<void>((resolve) => {
        releaseStream = resolve
        if (input.signal.aborted) resolve()
        else input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      yield* []
    },
    cancelRun: async (input) => {
      releaseStream?.()
      return { operationId: input.operationId, outcome: 'accepted' as const }
    },
    steerRun: async (input) => ({
      operationId: input.operationId,
      outcome: 'accepted' as const,
    }),
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const active = app.send({ operationId: 'op-steering-setup', text: 'keep this run active' })
  await active.admissionReady
  await waitUntil(() => app.state().activeRunId !== null)

  const calls = { send: 0, queue: 0, steer: 0, steerTexts: [] as string[] }
  const send = app.send.bind(app)
  app.send = (input) => {
    calls.send += 1
    return send(input)
  }
  const queueInput = app.queueInput.bind(app)
  app.queueInput = (input) => {
    calls.queue += 1
    return queueInput(input)
  }
  const steer = app.steer.bind(app)
  app.steer = async (input) => {
    calls.steer += 1
    calls.steerTexts.push(input.text)
    return steer(input)
  }

  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-steering-terminal-${++operation}`,
  })
  return { app, terminal, view, done: view.start(), calls }
}

function automationInteractionExecution(): {
  readonly execution: ExecutionPort
  readonly responses: () => number
} {
  const material: InteractionRequestMaterial = {
    id: 'interaction-terminal-automation',
    kind: 'question',
    title: 'Continue automatically?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    responseScopes: ['interaction', 'session', 'persistent'],
    binding: {
      runId: 'run-terminal-automation',
      provider: 'test-provider',
      environmentId: 'environment-terminal-automation',
      sessionId: 'session-terminal-automation',
      executionId: 'run-terminal-automation',
      interactionId: 'interaction-terminal-automation',
    },
  }
  const request = createInteractionRequest(material)
  let responses = 0
  let release: (() => void) | undefined
  return {
    execution: {
      capabilities: () => DEFAULT_RUN_CAPABILITIES,
      async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
        yield {
          type: 'interaction',
          request: rebindInteractionRequest(request, {
            ...request.binding,
            runId: input.runId,
            executionId: input.runId,
          }),
        }
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
      respondInteraction: async (input) => {
        responses += 1
        release?.()
        return { operationId: input.command.operationId, outcome: 'accepted' as const }
      },
    },
    responses: () => responses,
  }
}

test('/automate opens the keyboard rule manager instead of requiring JSON', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `operation-automation-view-${++operation}`,
  })
  const done = view.start()
  try {
    terminal.sendInput('/automate')
    terminal.sendInput('\r')
    await waitUntil(() => /automation rules/iu.test(terminal.getViewport().join('\n')))
    const screen = terminal.getViewport().join('\n')
    assert.match(screen, /automation rules/iu)
    assert.match(screen, /No saved automation rules/iu)
    assert.match(screen, /pending request with Alt\+A/iu)
    assert.doesNotMatch(screen, /matching commands|ctrl\+n new/iu)
    assert.doesNotMatch(screen, /JSON object/iu)
  } finally {
    view.stop()
    await done
  }
})

test('Alt+A creates a session rule and answers the real pending interaction', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const provider = automationInteractionExecution()
  const app = createBraidApplication({ fixture: 'deterministic', execution: provider.execution })
  app.initialize('/workspace')
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `operation-terminal-automation-${++operation}`,
  })
  const done = view.start()
  try {
    terminal.sendInput('ask for approval')
    terminal.sendInput('\r')
    await waitUntil(() => /Continue automatically\?/u.test(terminal.getViewport().join('\n')))
    terminal.sendInput('\u001ba')
    await waitUntil(() => /new automation rule/iu.test(terminal.getViewport().join('\n')))
    terminal.sendInput('\r')
    await waitUntil(() => /rule scope/iu.test(terminal.getViewport().join('\n')))
    terminal.sendInput('session')
    terminal.sendInput('\r')
    await waitUntil(() => provider.responses() === 1)

    assert.equal(app.state().rules[0]?.responseScope, 'session')
    assert.deepEqual(app.state().rules[0]?.answer, { continue: true })
    assert.equal(app.state().runs[0]?.interactions[0]?.status, 'resolved')
  } finally {
    view.stop()
    await done
  }
})

test('the real Braid root renders and sends at all four reference sizes', async () => {
  for (const [columns, rows] of SIZES) {
    const terminal = new VirtualTerminal(columns, rows)
    const tui = new TuiMainScreen(terminal)
    const app = createBraidApplication({ fixture: 'deterministic' })
    app.initialize('/workspace')
    const controller = createApplicationUiController(app)
    let operation = 0
    const view = new BraidTerminalApp({
      controller,
      tui,
      theme: createBraidTheme(false),
      workspace: '/workspace',
      nextOperationId: () => `op-${++operation}`,
    })
    const done = view.start()
    terminal.sendInput('hello Braid')
    terminal.sendInput('\r')
    await waitUntil(() => app.state().runs.length === 1)
    await app.waitForIdle()
    await terminal.waitForRender()

    const screen = terminal.getScrollBuffer().join('\n')
    assert.match(screen, /Braid starter/u)
    assert.match(screen, /hello\s+Braid/u)
    assert.match(screen, /Fixture response through pi/u)
    assert.equal(
      app.state().drafts.find((draft) => draft.branchId === app.state().branchId)?.text,
      '',
    )
    for (const line of terminal.getViewport()) assert.ok(visibleWidth(line) <= columns)

    view.stop()
    await done
  }
})

test('composer fallback steers exactly once without queueing or sending', async () => {
  const harness = await startSteeringTerminal()
  try {
    await harness.terminal.waitForRender()
    assert.match(harness.terminal.getViewport().join('\n'), /Enter steers/u)
    harness.terminal.sendInput('correct course')
    harness.terminal.sendInput('\r')
    await waitUntil(() => harness.calls.steer === 1)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.deepEqual(harness.calls.steerTexts, ['correct course'])
    assert.equal(harness.calls.send, 0)
    assert.equal(harness.calls.queue, 0)
  } finally {
    harness.view.stop()
    await harness.done
    await harness.app.close()
  }
})

test('/steer text uses the typed steer path exactly once without queueing or sending', async () => {
  const harness = await startSteeringTerminal()
  try {
    harness.terminal.sendInput('/steer focus on tests')
    harness.terminal.sendInput('\r')
    await waitUntil(() => harness.calls.steer === 1)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.deepEqual(harness.calls.steerTexts, ['focus on tests'])
    assert.equal(harness.calls.send, 0)
    assert.equal(harness.calls.queue, 0)
  } finally {
    harness.view.stop()
    await harness.done
    await harness.app.close()
  }
})

test('Alt+S changes an active composer from queue to steer', async () => {
  const harness = await startSteeringTerminal(true)
  try {
    await harness.terminal.waitForRender()
    assert.match(harness.terminal.getViewport().join('\n'), /Enter queues · Alt\+S steer/u)
    harness.terminal.sendInput('\u001bs')
    await harness.terminal.waitForRender()
    assert.match(harness.terminal.getViewport().join('\n'), /Enter steers · Alt\+S queue/u)

    harness.terminal.sendInput('change direction')
    harness.terminal.sendInput('\r')
    await waitUntil(() => harness.calls.steer === 1)
    assert.deepEqual(harness.calls.steerTexts, ['change direction'])
    assert.equal(harness.calls.queue, 0)
  } finally {
    harness.view.stop()
    await harness.done
    await harness.app.close()
  }
})

test('transcript navigation repaints the real terminal frame', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-history-frame-${++operation}`,
  })
  const done = view.start()
  const prompts = Array.from(
    { length: 8 },
    (_, index) => `history-frame-${String(index + 1).padStart(2, '0')}`,
  )

  for (const [index, prompt] of prompts.entries()) {
    terminal.sendInput(prompt)
    terminal.sendInput('\r')
    await waitUntil(() => app.state().runs.length === index + 1)
    await app.waitForIdle()
  }
  await terminal.waitForRender()
  assert.doesNotMatch(terminal.getViewport().join('\n'), /history-frame-01/u)

  terminal.sendInput('\u001b[1;3H')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /history-frame-01/u)

  terminal.sendInput('\u001b[1;3F')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /history-frame-08/u)

  view.stop()
  await done
})

test('the editor preserves Unicode, multiline paste, undo, completion, and cursor on resize', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const theme = createBraidTheme(false)
  const editor = new Editor(tui, theme.editor, { paddingX: 1 })
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        { name: 'help', description: 'Keyboard and commands' },
        { name: 'quit', description: 'Close Braid' },
      ],
      '/workspace',
      null,
    ),
  )
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()

  terminal.sendInput('ASCII 漢字 e\u0301 👩🏽‍💻')
  terminal.sendInput('\n')
  terminal.sendInput('\u001b[200~مرحبا\nsecond line\u001b[201~')
  assert.equal(editor.getExpandedText(), 'ASCII 漢字 é 👩🏽‍💻\nمرحبا\nsecond line')
  const cursorBeforeResize = editor.getCursor()
  for (const [columns, rows] of SIZES) {
    terminal.resize(columns, rows)
    editor.render(columns)
    assert.deepEqual(editor.getCursor(), cursorBeforeResize)
  }

  editor.setText('undo me')
  terminal.sendInput('!')
  terminal.sendInput('\u001f')
  assert.equal(editor.getText(), 'undo me')

  editor.setText('/he')
  let submitted = ''
  editor.onSubmit = (text) => {
    submitted = text
  }
  terminal.sendInput('\t')
  await new Promise((resolve) => setTimeout(resolve, 30))
  terminal.sendInput('\r')
  assert.equal(submitted, '/help')
  assert.equal(editor.getText(), '')

  tui.stop()
})

test('the searchable command overlay restores editor focus after close', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-1',
  })
  const done = view.start()

  terminal.sendInput('\u0010')
  terminal.sendInput('q')
  await terminal.waitForRender()
  const overlay = terminal.getViewport().join('\n')
  assert.match(overlay, /\/quit/u)
  assert.doesNotMatch(overlay, /alt\+enter newline/u)
  terminal.sendInput('\u001b')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /profile Braid starter.*Ctrl\+P commands/u)
  terminal.sendInput('focus restored')
  assert.equal(view.editor.getText(), 'focus restored')

  view.stop()
  await done
})

test('Ctrl+K exposes one five-row run switcher and updates the branch runner', async () => {
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-run-switcher-${++operation}`,
  })
  const done = view.start()

  terminal.sendInput('\u000b')
  await terminal.waitForRender()
  const switcher = terminal.getViewport().join('\n')
  assert.match(switcher, /Run configuration/u)
  for (const label of ['Profile', 'Connection', 'Runner', 'Model', 'Thinking']) {
    assert.match(switcher, new RegExp(`\\b${label}\\b`, 'u'))
  }
  assert.match(switcher, /enter to change · esc to close/u)

  terminal.sendInput('\u001b[B')
  terminal.sendInput('\u001b[B')
  terminal.sendInput('\r')
  await terminal.waitForRender()
  assert.equal(view.editor.getText(), '/runner ')
  terminal.sendInput('codex')
  terminal.sendInput('\r')
  await waitUntil(
    () =>
      app.state().branches.find((branch) => branch.id === app.state().branchId)?.overrides
        .runner === 'codex',
  )
  assert.equal(controller.view().runner, 'codex')
  assert.equal(controller.view().runOverrides?.runner, 'codex')

  terminal.sendInput('\u000b')
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /codex · branch override/u)
  terminal.sendInput('\u001b')

  view.stop()
  await done
})

test('global shortcuts cannot replace an open overlay or discard its query', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'op-overlay-focus',
  })
  const done = view.start()

  terminal.sendInput('\u0010')
  terminal.sendInput('quit')
  await terminal.waitForRender()
  terminal.sendInput('\u0007')
  await terminal.waitForRender()
  const screen = terminal.getViewport().join('\n')
  assert.match(screen, /Commands/u)
  assert.match(screen, /\/quit/u)
  assert.doesNotMatch(screen, /conversation graph/u)

  terminal.sendInput('\u001b')
  view.stop()
  await done
})

test('conversation commands work through the real terminal input path', async () => {
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-conversation-ui-${++operation}`,
  })
  const done = view.start()

  terminal.sendInput('/new Terminal workflow')
  terminal.sendInput('\r')
  await waitUntil(() => app.state().conversations.length === 2)
  assert.equal(
    app.state().conversations.find((conversation) => conversation.id === app.state().conversationId)
      ?.title,
    'Terminal workflow',
  )

  terminal.sendInput('message before branch')
  terminal.sendInput('\r')
  await waitUntil(() => app.state().runs.length === 1)
  await app.waitForIdle()
  const messageId = app.state().messages.find((message) => message.role === 'user')?.id
  assert(messageId)
  terminal.sendInput(`/branch ${messageId}`)
  terminal.sendInput('\r')
  await waitUntil(() => app.state().branches.length === 3)

  terminal.sendInput('/clone Terminal copy')
  terminal.sendInput('\r')
  await waitUntil(() => app.state().conversations.length === 3)
  assert.equal(
    app.state().conversations.find((conversation) => conversation.id === app.state().conversationId)
      ?.title,
    'Terminal copy',
  )

  terminal.sendInput('/fork')
  terminal.sendInput('\r')
  await waitUntil(() => controller.view().forkPreview !== undefined)
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /fork preview/iu)
  terminal.sendInput('\u001b')

  terminal.sendInput('/export markdown')
  terminal.sendInput('\r')
  await waitUntil(() => controller.view().notice?.includes('MARKDOWN') === true)
  await terminal.waitForRender()
  assert.match(terminal.getViewport().join('\n'), /prepared markdown export/iu)

  terminal.sendInput('\u000f')
  await terminal.waitForRender()
  const selector = terminal.getViewport().join('\n')
  assert.match(selector, /Terminal workflow/u)
  assert.match(selector, /Terminal copy/u)
  terminal.sendInput('\u001b')

  view.stop()
  await done
})

test('the terminal saves and restores independent unsent conversation drafts', async () => {
  const terminal = new VirtualTerminal(100, 30)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const firstConversationId = app.state().conversationId
  const firstBranchId = app.state().branchId
  await app.conversations.lifecycle.rename({
    operationId: 'op-draft-ui-rename-first',
    conversationId: firstConversationId,
    title: 'Alpha draft source',
  })
  const secondConversation = await app.conversations.lifecycle.create({
    operationId: 'op-draft-ui-create-second',
    title: 'Beta draft target',
  })
  await app.conversations.lifecycle.open({
    operationId: 'op-draft-ui-open-first',
    conversationId: firstConversationId,
    branchId: firstBranchId,
  })
  const controller = createApplicationUiController(app)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-draft-ui-${++operation}`,
  })
  const done = view.start()

  terminal.sendInput('alpha unsent draft')
  await waitUntil(
    () =>
      app.state().drafts.find((draft) => draft.branchId === firstBranchId)?.text ===
      'alpha unsent draft',
  )
  terminal.sendInput('\u000f')
  await waitUntil(() => terminal.getViewport().join('\n').includes('type to filter'))
  terminal.sendInput('Beta draft target')
  terminal.sendInput('\r')
  await waitUntil(() => app.state().conversationId === secondConversation.id)
  assert.equal(view.editor.getText(), '')

  terminal.sendInput('beta unsent draft')
  await waitUntil(
    () =>
      app.state().drafts.find((draft) => draft.branchId === secondConversation.activeBranchId)
        ?.text === 'beta unsent draft',
  )
  terminal.sendInput('\u000f')
  await waitUntil(() => terminal.getViewport().join('\n').includes('type to filter'))
  terminal.sendInput('Alpha draft source')
  terminal.sendInput('\r')
  await waitUntil(() => app.state().conversationId === firstConversationId)
  await waitUntil(() => view.editor.getText() === 'alpha unsent draft')
  assert.equal(
    app.state().drafts.find((draft) => draft.branchId === firstBranchId)?.text,
    'alpha unsent draft',
  )
  assert.equal(
    app.state().drafts.find((draft) => draft.branchId === secondConversation.activeBranchId)?.text,
    'beta unsent draft',
  )

  view.stop()
  await done
})

test('Ctrl+C clears, cancels, then requires a second idle press to quit', async () => {
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 100 })
  app.initialize('/workspace')
  const controller = createApplicationUiController(app)
  let operation = 0
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-cancel-flow-${++operation}`,
  })
  let stopped = false
  const done = view.start().then(() => {
    stopped = true
  })

  terminal.sendInput('running turn')
  terminal.sendInput('\r')
  await waitUntil(() => app.state().activeRunId !== null)
  terminal.sendInput('unsent draft')
  terminal.sendInput('\u0003')
  assert.equal(view.editor.getText(), '')
  assert.notEqual(app.state().activeRunId, null)

  terminal.sendInput('\u0003')
  await app.waitForIdle()
  assert.equal(app.state().runs[0]?.status, 'aborted')
  assert.equal(stopped, false)

  terminal.sendInput('\u0003')
  await terminal.waitForRender()
  assert.equal(stopped, false)
  assert.match(terminal.getViewport().join('\n'), /Ctrl\+C again to quit/u)
  terminal.sendInput('\u0003')
  await done
  assert.equal(stopped, true)
})
