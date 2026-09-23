import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { type InteractionResponse, permissionAnswerSpec } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { interactionResponseRunCapabilities } from './support/run-capabilities.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for permission response')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('Enter on Allow once sends a valid Pi permission response through the terminal', async () => {
  const request = createInteractionRequest({
    id: 'interaction-pi-bash',
    kind: 'permission',
    title: 'Permission: bash',
    answerSpec: permissionAnswerSpec({ allowFeedback: false, responseScopes: ['interaction'] }),
    responseScopes: ['interaction'],
    binding: {
      runId: 'run-pi-bash',
      provider: 'cli-bridge',
      environmentId: 'environment-pi-bash',
      sessionId: 'session-pi-bash',
      executionId: 'run-pi-bash',
      interactionId: 'interaction-pi-bash',
    },
  })
  let release: (() => void) | undefined
  let providerResponse: InteractionResponse | undefined
  const execution: ExecutionPort = {
    capabilities: () => interactionResponseRunCapabilities(),
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
      providerResponse = input.command.response
      release?.()
      return { operationId: input.command.operationId, outcome: 'accepted' as const }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const terminal = new VirtualTerminal(80, 24)
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `operation-pi-bash-permission-${++operation}`,
  })
  const done = view.start()
  try {
    terminal.sendInput('run bash')
    terminal.sendInput('\r')
    await waitUntil(() => terminal.getViewport().join('\n').includes('Permission: bash'))
    assert.match(terminal.getViewport().join('\n'), /Allow once/u)
    terminal.sendInput('\r')
    await waitUntil(() => providerResponse !== undefined)

    assert.deepEqual(providerResponse, {
      id: 'interaction-pi-bash',
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })
    assert.equal(
      app.events().filter((event) => event.event.kind === 'run.interaction.response.requested')
        .length,
      1,
    )
    assert.equal(app.state().runs[0]?.interactions[0]?.status, 'resolved')
  } finally {
    release?.()
    view.stop()
    await done
  }
})
