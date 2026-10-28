import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { heldFixtureExecution } from './support/held-fixture.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const PROMPT = `This turn is part of Braid's live release test. ${'Write the marker file and report it. '.repeat(20)}`

async function waitUntil(
  label: string,
  condition: () => boolean,
  screen: () => readonly string[],
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) {
      const drawn = screen().filter((line) => line.trim().length > 0)
      throw new Error(`${label} did not happen in time; screen:\n${drawn.join('\n')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// LIVE-07 pasted branch B's prompt while `/new` was still opening the conversation under a
// streaming run; the inline frame then drew only the composer line and B's work never showed.
test('a prompt pasted while /new is still opening is admitted and the frame keeps rendering', async () => {
  const { execution, release } = heldFixtureExecution()
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const lifecycle = app.conversations.lifecycle
  const create = lifecycle.create.bind(lifecycle)
  lifecycle.create = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    return create(input)
  }
  const terminal = new VirtualTerminal(120, 40)
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-paste-during-new-${++operation}`,
  })
  const done = view.start()
  try {
    await terminal.waitForRender()
    terminal.sendInput('run A\r')
    await waitUntil('run A start', () => app.state().activeRuns.length === 1, () => terminal.getViewport())

    terminal.sendInput('/new B conversation\r')
    terminal.sendInput(`\u001b[200~${PROMPT}\u001b[201~`)
    terminal.sendInput('\r')
    await waitUntil('run B admission', () => app.state().activeRuns.length === 2, () => terminal.getViewport(), 20_000)
    await terminal.waitForRender()

    const screen = terminal.getViewport()
    const drawn = screen.filter((line) => line.trim().length > 0)
    assert.ok(drawn.length > 3, `frame drew only:\n${drawn.join('\n')}`)
    assert.ok(
      !drawn.some((line) => line.includes('Write the marker file and report it.')),
      `submitted prompt stayed in the composer:\n${drawn.join('\n')}`,
    )
  } finally {
    release()
    view.stop()
    await done
  }
})
