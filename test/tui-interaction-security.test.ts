import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import type {
  InteractionRequest,
  InteractionRequestMaterial,
} from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import { isSensitiveFieldName } from '../src/domain/bounded-structured.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import type { InteractionView } from '../src/views/shared/models.js'
import { InteractionShell } from '../src/views/tui/interaction.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

const theme = createBraidTheme(false)

function requestFor(
  id: string,
  input: Pick<InteractionRequestMaterial, 'answerSpec' | 'allowedOutcomes'>,
): InteractionRequest {
  return createInteractionRequest({
    id,
    kind: 'question',
    title: 'Provide a response',
    body: 'The runner needs a response.',
    answerSpec: input.answerSpec,
    ...(input.allowedOutcomes === undefined ? {} : { allowedOutcomes: input.allowedOutcomes }),
    responseScopes: ['interaction'],
    binding: {
      runId: `run-${id}`,
      provider: 'test-provider',
      environmentId: 'environment-test',
      sessionId: 'session-test',
      executionId: `run-${id}`,
      interactionId: id,
    },
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for interaction state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function pendingInteraction(request: InteractionRequest): Promise<{
  readonly app: ReturnType<typeof createBraidApplication>
  readonly send: ReturnType<ReturnType<typeof createBraidApplication>['send']>
  readonly interaction: InteractionView
  readonly release: () => void
}> {
  let releaseStream: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      yield {
        type: 'interaction',
        request: rebindInteractionRequest(request, {
          ...request.binding,
          runId: input.runId,
          executionId: input.runId,
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        }),
      }
      await new Promise<void>((resolve) => {
        releaseStream = resolve
        if (input.signal.aborted) resolve()
        else input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const send = app.send({ operationId: `operation-${request.id}`, text: 'ask' })
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')
  const interaction = createApplicationUiController(app).view().interactions[0]
  assert.ok(interaction)
  return {
    app,
    send,
    interaction,
    release: () => releaseStream?.(),
  }
}

async function closePending(
  pending: Awaited<ReturnType<typeof pendingInteraction>>,
): Promise<void> {
  pending.release()
  await pending.send.completion
  await pending.app.close()
}

async function renderShell(shell: InteractionShell, terminal: VirtualTerminal): Promise<void> {
  const tui = new TuiMainScreen(terminal)
  tui.showOverlay(shell, {
    anchor: 'top-left',
    margin: 0,
    width: '100%',
    maxHeight: '100%',
  })
  tui.start()
  await terminal.waitForRender()
}

test('sensitive interaction names use the canonical predicate and never echo typed values', async () => {
  assert.equal(isSensitiveFieldName('apiKey'), true)
  assert.equal(isSensitiveFieldName('password'), true)
  assert.equal(isSensitiveFieldName('token'), true)

  const canary = 'typed-api-key-never-render'
  const pending = await pendingInteraction(
    requestFor('interaction-field-1', {
      answerSpec: {
        fields: [{ type: 'text', name: 'apiKey', label: 'API key', required: true }],
      },
      allowedOutcomes: ['accepted', 'cancelled'],
    }),
  )
  try {
    assert.equal(pending.interaction.secret, true)
    assert.deepEqual(pending.interaction.answerSpec, {
      kind: 'text',
      required: true,
      secret: true,
    })

    const responses: unknown[] = []
    const shell = new InteractionShell(pending.interaction, theme, (response) =>
      responses.push(response),
    )
    const terminal = new VirtualTerminal(80, 24)
    await renderShell(shell, terminal)
    terminal.sendInput(canary)
    await terminal.flush()

    assert.doesNotMatch(shell.render(80).join('\n'), new RegExp(canary, 'u'))
    assert.doesNotMatch(terminal.getViewport().join('\n'), new RegExp(canary, 'u'))
    assert.doesNotMatch(terminal.getScrollBuffer().join('\n'), new RegExp(canary, 'u'))
    assert.deepEqual(responses, [])
    terminal.stop()
  } finally {
    await closePending(pending)
  }
})

test('interaction projection preserves accepted-only and declined-only outcomes', async () => {
  const accepted = await pendingInteraction(
    requestFor('interaction-accepted-only', {
      answerSpec: {
        fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
      },
      allowedOutcomes: ['accepted'],
    }),
  )
  try {
    assert.deepEqual(accepted.interaction.allowedOutcomes, ['accept'])
    const acceptedResponses: unknown[] = []
    const acceptedShell = new InteractionShell(accepted.interaction, theme, (response) =>
      acceptedResponses.push(response),
    )
    const acceptedScreen = acceptedShell.render(80).join('\n')
    assert.match(acceptedScreen, /keys: alt\+1 approve/u)
    assert.doesNotMatch(acceptedScreen, /reject|cancel/u)
    acceptedShell.handleInput('\u001b')
    assert.deepEqual(acceptedResponses, [])
    assert.match(acceptedShell.render(80).join('\n'), /Cancellation is not allowed/u)
    acceptedShell.handleInput('\u001b1')
    assert.deepEqual(acceptedResponses, [{ outcome: 'accept', value: true }])
  } finally {
    await closePending(accepted)
  }

  const declined = await pendingInteraction(
    requestFor('interaction-declined-only', {
      answerSpec: {
        fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
      },
      allowedOutcomes: ['declined'],
    }),
  )
  try {
    assert.deepEqual(declined.interaction.allowedOutcomes, ['reject'])
    const declinedResponses: unknown[] = []
    const declinedShell = new InteractionShell(declined.interaction, theme, (response) =>
      declinedResponses.push(response),
    )
    const declinedScreen = declinedShell.render(80).join('\n')
    assert.match(declinedScreen, /keys: alt\+1 reject/u)
    assert.match(declinedScreen, /answer: n reject/u)
    assert.doesNotMatch(declinedScreen, /approve|cancel/u)
    declinedShell.handleInput('\u001b1')
    assert.deepEqual(declinedResponses, [{ outcome: 'reject' }])
  } finally {
    await closePending(declined)
  }
})
