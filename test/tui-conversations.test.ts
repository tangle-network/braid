import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

function operationIds(prefix: string): () => string {
  let index = 0
  return () => `${prefix}-${++index}`
}

async function settle(terminal: VirtualTerminal): Promise<string> {
  await terminal.waitForRender()
  return terminal.getViewport().join('\n')
}

function startTerminal(app: ReturnType<typeof createBraidApplication>, terminal: VirtualTerminal) {
  const tui = new TuiMainScreen(terminal)
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: operationIds('op-tui'),
  })
  return { view, done: view.start() }
}

async function stopTerminal(view: BraidTerminalApp, done: Promise<void>): Promise<void> {
  view.stop()
  await done
}

test('conversation search exposes metadata and opens the selected branch by keyboard', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const source = app.state().conversationId
  const archived = await app.conversations.lifecycle.create({
    operationId: 'op-tui-search-create',
    title: 'Archived release review',
  })
  await app.conversations.lifecycle.archive({
    operationId: 'op-tui-search-archive',
    conversationId: archived.id,
    archived: true,
  })
  await app.conversations.lifecycle.open({
    operationId: 'op-tui-search-open-source',
    conversationId: source,
  })

  const terminal = new VirtualTerminal(80, 24)
  const { view, done } = startTerminal(app, terminal)
  terminal.sendInput('\u000f')
  let screen = await settle(terminal)
  assert.match(screen, /conversations/u)
  assert.match(screen, /ws:workspace/u)
  assert.match(screen, /branch/u)
  assert.match(screen, /\d{4}-\d{2}-\d{2}/u)
  assert.match(screen, /archived/u)

  terminal.sendInput(archived.activeBranchId)
  screen = await settle(terminal)
  assert.match(screen, /Archived release review/u)
  terminal.sendInput('\r')
  await settle(terminal)
  assert.equal(app.state().conversationId, archived.id)
  assert.equal(app.state().branchId, archived.activeBranchId)

  terminal.sendInput('\u000f')
  await settle(terminal)
  terminal.sendInput('/workspace')
  screen = await settle(terminal)
  assert.match(screen, /Archived release review/u)
  terminal.sendInput('\u001b')
  await stopTerminal(view, done)
})

test('conversation selector stays keyboard usable at 40 columns by 12 rows', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const terminal = new VirtualTerminal(40, 12)
  const { view, done } = startTerminal(app, terminal)
  terminal.sendInput('\u000f')
  const screen = await settle(terminal)
  assert.match(screen, /conversations/u)
  assert.match(screen, /type to filter/u)
  for (const line of terminal.getViewport()) assert.ok(visibleWidth(line) <= 40)
  terminal.sendInput('New')
  terminal.sendInput('\r')
  await settle(terminal)
  assert.equal(app.state().conversationId.length > 0, true)
  await stopTerminal(view, done)
})

test('rename, archive, and delete require confirmation and preserve the selector on cancel', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const conversationId = app.state().conversationId
  const terminal = new VirtualTerminal(80, 24)
  const { view, done } = startTerminal(app, terminal)

  terminal.sendInput('\u000f')
  await settle(terminal)
  terminal.sendInput('\u0012')
  let screen = await settle(terminal)
  assert.match(screen, /rename conversation/u)
  terminal.sendInput('Renamed flow')
  terminal.sendInput('\r')
  await settle(terminal)
  assert.equal(
    app.state().conversations.find((item) => item.id === conversationId)?.title,
    'Renamed flow',
  )

  terminal.sendInput('\u000f')
  await settle(terminal)
  terminal.sendInput('\u0001')
  screen = await settle(terminal)
  assert.match(screen, /archive conversation/u)
  terminal.sendInput('n')
  screen = await settle(terminal)
  assert.match(screen, /conversations/u)
  assert.equal(
    app.state().conversations.find((item) => item.id === conversationId)?.archived,
    false,
  )

  terminal.sendInput('\u0001')
  await settle(terminal)
  terminal.sendInput('y')
  await settle(terminal)
  assert.equal(app.state().conversations.find((item) => item.id === conversationId)?.archived, true)

  terminal.sendInput('\u000f')
  await settle(terminal)
  terminal.sendInput('Renamed')
  await settle(terminal)
  terminal.sendInput('\u0004')
  screen = await settle(terminal)
  assert.match(screen, /delete conversation/u)
  terminal.sendInput('n')
  screen = await settle(terminal)
  assert.match(screen, /conversations/u)
  terminal.sendInput('\u0004')
  await settle(terminal)
  terminal.sendInput('y')
  await settle(terminal)
  assert.notEqual(
    app.state().conversations.find((item) => item.id === conversationId)?.deletedAt,
    undefined,
  )
  await stopTerminal(view, done)
})

test('a lifecycle failure keeps the confirmation target available for recovery', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 1_000 })
  app.initialize('/workspace')
  const terminal = new VirtualTerminal(80, 24)
  const { view, done } = startTerminal(app, terminal)
  terminal.sendInput('\u000f')
  await settle(terminal)
  const receipt = app.send({ operationId: 'op-tui-busy-run', text: 'keep this run active' })
  await settle(terminal)
  terminal.sendInput('\u0004')
  await settle(terminal)
  terminal.sendInput('y')
  const screen = await settle(terminal)
  assert.match(screen, /delete conversation/u)
  assert.match(screen, /failed|active run|busy|not terminal/u)
  terminal.sendInput('n')
  await settle(terminal)
  app.cancelActive()
  await receipt.completion
  await stopTerminal(view, done)
})

test('fork preview executes the existing plan and branch navigation works with alt arrows', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const sourceBranch = app.state().branchId
  await app.conversations.branches.create({ operationId: 'op-tui-branch-create' })
  const branched = app.state().branchId
  assert.notEqual(branched, sourceBranch)

  const terminal = new VirtualTerminal(80, 24)
  const { view, done } = startTerminal(app, terminal)
  terminal.sendInput('\u001bp')
  await settle(terminal)
  assert.equal(app.state().branchId, sourceBranch)

  terminal.sendInput('\u001b')
  await settle(terminal)
  terminal.sendInput('/fork')
  terminal.sendInput('\r')
  let screen = await settle(terminal)
  assert.match(screen, /fork preview/u)
  assert.match(screen, /enter\/y create fork/u)
  const beforeFork = app.state().branches.length
  terminal.sendInput('y')
  await settle(terminal)
  assert.ok(app.state().branches.length > beforeFork)
  screen = await settle(terminal)
  assert.doesNotMatch(screen, /enter\/y create fork/u)
  await stopTerminal(view, done)
})

test('fork confirmation preserves an earlier message boundary from the preview plan', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const sourceBranch = app.state().branchId
  const sent = app.send({
    operationId: 'op-tui-fork-boundary-send',
    text: 'preserve this boundary',
  })
  await sent.completion
  const boundary = app
    .state()
    .messages.find((message) => message.branchId === sourceBranch && message.role === 'user')
  assert(boundary)

  const controller = createApplicationUiController(app)
  const terminal = new VirtualTerminal(80, 24)
  const tui = new TuiMainScreen(terminal)
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: operationIds('op-tui-fork-boundary'),
  })
  const done = view.start()

  terminal.sendInput(`/fork ${boundary.id}`)
  terminal.sendInput('\r')
  let screen = await settle(terminal)
  assert.match(screen, /boundary:/u)
  assert.match(screen, new RegExp(boundary.id, 'u'))
  const preview = controller.view().forkPreview
  assert.equal(preview?.plan?.sourceBranchId, sourceBranch)
  assert.equal(preview?.plan?.throughMessageId, boundary.id)
  assert.equal(Object.isFrozen(preview?.plan), true)

  const beforeFork = app.state().branches.length
  terminal.sendInput('y')
  await settle(terminal)
  const created = app.state().branches.at(-1)
  assert.equal(app.state().branches.length, beforeFork + 1)
  assert.equal(created?.source?.branchId, sourceBranch)
  assert.equal(created?.source?.throughMessageId, boundary.id)
  screen = await settle(terminal)
  assert.doesNotMatch(screen, /enter\/y create fork/u)
  await stopTerminal(view, done)
})
