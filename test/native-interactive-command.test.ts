import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import type {
  NativeInteractiveCommand,
  NativeInteractiveUiActions,
} from '../src/views/shared/native-interactive-actions.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for native terminal command')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function terminalWith(actions?: NativeInteractiveUiActions): {
  readonly terminal: VirtualTerminal
  readonly view: BraidTerminalApp
  readonly done: Promise<void>
} {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const terminal = new VirtualTerminal(80, 24)
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => 'operation-native-command',
    ...(actions === undefined ? {} : { nativeInteractive: actions }),
  })
  return { terminal, view, done: view.start() }
}

test('native terminal commands cross one typed terminal-only port', async () => {
  const commands: NativeInteractiveCommand[] = []
  const actions: NativeInteractiveUiActions = {
    availability: () => ({ available: true }),
    run: async (command) => {
      commands.push(command)
      return { kind: 'returned', runId: 'run-native', outcome: 'detached' }
    },
  }
  for (const input of ['/interactive inspect the failing tests', '/attach run-native']) {
    const { terminal, view, done } = terminalWith(actions)
    const expectedCount = commands.length + 1
    try {
      terminal.sendInput(input)
      terminal.sendInput('\r')
      await waitUntil(() => commands.length === expectedCount)
    } finally {
      view.stop()
      await done
    }
  }
  assert.deepEqual(commands, [
    { action: 'start', initialPrompt: 'inspect the failing tests' },
    { action: 'attach', runId: 'run-native' },
  ])
})

test('native commands explain unavailable capability without calling the port', async () => {
  let calls = 0
  const actions: NativeInteractiveUiActions = {
    availability: (action) => ({
      available: false,
      reason: action === 'start' ? 'This connection has no native terminal' : 'No retained session',
    }),
    run: async () => {
      calls += 1
      return { kind: 'error', message: 'must not run' }
    },
  }
  const { terminal, view, done } = terminalWith(actions)
  try {
    terminal.sendInput('/interactive\r')
    await waitUntil(() =>
      /This connection has no native terminal/u.test(terminal.getViewport().join('\n')),
    )
    assert.equal(calls, 0)
  } finally {
    view.stop()
    await done
  }
})
