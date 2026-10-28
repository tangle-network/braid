import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { heldFixtureExecution } from './support/held-fixture.js'
import { interactionResponseRunCapabilities } from './support/run-capabilities.js'
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
    const type = async (text: string) => {
      for (const character of text) terminal.sendInput(character)
      await terminal.waitForRender()
      terminal.sendInput('\r')
    }
    await type('run A')
    await waitUntil(
      'run A start',
      () => app.state().activeRuns.length === 1,
      () => terminal.getViewport(),
    )

    await type('/new B conversation')
    terminal.sendInput(`\u001b[200~${PROMPT}\u001b[201~`)
    terminal.sendInput('\r')
    await waitUntil(
      'run B admission',
      () => app.state().activeRuns.length === 2,
      () => terminal.getViewport(),
      20_000,
    )
    await terminal.waitForRender()

    const screen = terminal.getViewport()
    const drawn = screen.filter((line) => line.trim().length > 0)
    assert.ok(drawn.length > 3, `frame drew only:\n${drawn.join('\n')}`)
    assert.ok(
      !drawn.some((line) => /queued \d+\./u.test(line)),
      `the prompt was queued behind the old run:\n${drawn.join('\n')}`,
    )
    assert.equal(app.state().queuedInputs.length, 0)
  } finally {
    release()
    view.stop()
    await done
  }
})

// LIVE-07 again: run A asked for a permission right after `/new`, its form opened over the empty
// composer, and branch B's pasted prompt went into A's form.
test("another conversation's request waits in the status line instead of taking the prompt", async () => {
  const held = heldFixtureExecution()
  let ask!: () => void
  const asked = new Promise<void>((resolve) => {
    ask = resolve
  })
  const request = createInteractionRequest({
    id: 'interaction-run-a',
    kind: 'permission',
    title: 'Allow tool "bash"?',
    answerSpec: { fields: [{ type: 'boolean', name: 'allow', label: 'Allow', required: true }] },
    responseScopes: ['interaction'],
    binding: {
      runId: 'run-a',
      provider: 'test-provider',
      environmentId: 'environment-run-a',
      sessionId: 'session-run-a',
      executionId: 'run-a',
      interactionId: 'interaction-run-a',
    },
  })
  let turns = 0
  const execution: ExecutionPort = {
    ...held.execution,
    capabilities: () => interactionResponseRunCapabilities(),
    async *streamTurn(input) {
      if (++turns === 1) {
        await asked
        yield {
          type: 'interaction',
          request: rebindInteractionRequest(request, {
            ...request.binding,
            runId: input.runId,
            executionId: input.runId,
          }),
        }
      }
      yield* held.execution.streamTurn(input)
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const terminal = new VirtualTerminal(120, 40)
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-foreign-interaction-${++operation}`,
  })
  const done = view.start()
  const screen = () => terminal.getViewport()
  try {
    await terminal.waitForRender()
    for (const character of 'run A') terminal.sendInput(character)
    terminal.sendInput('\r')
    await waitUntil('run A start', () => app.state().activeRuns.length === 1, screen)
    const first = app.state().conversationId
    for (const character of '/new B conversation') terminal.sendInput(character)
    terminal.sendInput('\r')
    await waitUntil('/new', () => app.state().conversationId !== first, screen)

    ask()
    await waitUntil('the deferred request', () => /permission waiting/u.test(screen().join('\n')), screen)
    terminal.sendInput(`\u001b[200~${PROMPT}\u001b[201~`)
    terminal.sendInput('\r')
    await waitUntil('run B admission', () => app.state().activeRuns.length === 2, screen)

    const runA = app.state().runs.find((run) => run.conversationId === first)
    assert.equal(runA?.interactions[0]?.status, 'pending')
    terminal.sendInput('\u001bp')
    await waitUntil(
      'the opened form',
      () => /Allow tool "bash"\?/u.test(screen().join('\n')),
      screen,
    )
  } finally {
    held.release()
    view.stop()
    await done
  }
})
