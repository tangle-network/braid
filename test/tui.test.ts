import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CombinedAutocompleteProvider,
  Editor,
  TuiMainScreen,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
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
    assert.match(screen, /braid/u)
    assert.match(screen, /hello Braid/u)
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
  assert.match(terminal.getViewport().join('\n'), /\/quit/u)
  terminal.sendInput('\u001b')
  terminal.sendInput('focus restored')
  assert.equal(view.editor.getText(), 'focus restored')

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
  assert.match(terminal.getViewport().join('\n'), /ctrl\+c again to quit/u)
  terminal.sendInput('\u0003')
  await done
  assert.equal(stopped, true)
})
