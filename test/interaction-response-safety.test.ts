import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  InteractionRequest,
  InteractionRequestMaterial,
  InteractionResponse,
} from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { AppError } from '../src/app/errors.js'
import { automationAudits } from '../src/app/automation-rules.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'

function interactionRequest(id: string): InteractionRequest {
  const material: InteractionRequestMaterial = {
    id,
    kind: 'question',
    title: 'Continue?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    responseScopes: ['interaction'],
    binding: {
      runId: 'run-request',
      provider: 'test-provider',
      environmentId: 'environment-test',
      sessionId: 'session-test',
      executionId: 'run-request',
      interactionId: id,
    },
  }
  return createInteractionRequest(material)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for interaction state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('an adapter without response support leaves interactions and rules untouched', async () => {
  const source = interactionRequest('interaction-unsupported')
  let releaseStream: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      yield {
        type: 'interaction',
        request: rebindInteractionRequest(source, {
          ...source.binding,
          runId: input.runId,
          executionId: input.runId,
        }),
      }
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  await app.automation.create({
    operationId: 'operation-create-unsupported-rule',
    ruleId: 'rule-unsupported',
    request: source,
    answer: { continue: true },
    responseScope: 'once',
    maximumUses: 1,
  })

  const send = app.send({ operationId: 'operation-send-unsupported', text: 'ask' })
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')
  const run = app.state().runs[0]
  const interaction = run?.interactions[0]
  assert(run && interaction)

  const controller = createApplicationUiController(app)
  assert.equal(controller.view().capabilities['interaction.respond']?.available, false)
  assert.equal(controller.view().capabilities['interaction.automation']?.available, false)
  const response = await controller.dispatch({
    type: 'respond-interaction',
    operationId: 'operation-manual-unsupported',
    runId: run.id,
    interactionId: interaction.request.id,
    response: { outcome: 'accept', value: true },
  })
  assert.equal(response.kind, 'unavailable')
  await assert.rejects(
    app.automation.apply({
      operationId: 'operation-automatic-unsupported',
      runId: run.id,
      interactionId: interaction.request.id,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE',
  )

  assert.equal(app.state().runs[0]?.interactions[0]?.status, 'pending')
  assert.equal(app.state().rules[0]?.uses, 0)
  assert.equal(automationAudits(app.events()).length, 0)
  assert.equal(
    app.events().filter((event) => event.event.kind === 'run.interaction.response.requested')
      .length,
    0,
  )
  releaseStream?.()
  await send.completion
  await app.close()
})

test('automatic and manual responses dispatch exactly once when they race', async () => {
  const source = interactionRequest('interaction-response-race')
  let releaseStream: (() => void) | undefined
  let releaseResponse: (() => void) | undefined
  let responseStarted: (() => void) | undefined
  const responseStartedPromise = new Promise<void>((resolve) => {
    responseStarted = resolve
  })
  let responseCount = 0
  let automaticResponse: InteractionResponse | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      yield {
        type: 'interaction',
        request: rebindInteractionRequest(source, {
          ...source.binding,
          runId: input.runId,
          executionId: input.runId,
        }),
      }
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
    },
    respondInteraction: async (input) => {
      responseCount += 1
      automaticResponse = structuredClone(input.command.response)
      responseStarted?.()
      await new Promise<void>((resolve) => {
        releaseResponse = resolve
      })
      releaseStream?.()
      return { operationId: input.command.operationId, outcome: 'accepted' }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  await app.automation.create({
    operationId: 'operation-create-race-rule',
    ruleId: 'rule-response-race',
    request: source,
    answer: { continue: true },
    responseScope: 'once',
    maximumUses: 1,
  })

  const send = app.send({ operationId: 'operation-send-response-race', text: 'ask' })
  await responseStartedPromise
  const run = app.state().runs[0]
  const interaction = run?.interactions[0]
  assert(run && interaction)
  const manual = app.respondInteraction({
    operationId: 'operation-manual-response-race',
    runId: run.id,
    interactionId: interaction.request.id,
    response: {
      id: interaction.request.id,
      outcome: 'accepted',
      data: { continue: false },
    },
  })
  releaseResponse?.()

  await assert.rejects(
    manual,
    (error: unknown) =>
      error instanceof AppError &&
      (error.code === 'INTERACTION_RESPONSE_IN_PROGRESS' || error.code === 'INTERACTION_STALE'),
  )
  await send.completion
  assert.equal(responseCount, 1)
  assert.deepEqual(automaticResponse?.data, { continue: true })
  assert.equal(
    app.events().filter((event) => event.event.kind === 'run.interaction.response.requested')
      .length,
    1,
  )
  assert.equal(
    app.events().filter((event) => event.event.kind === 'run.interaction.responded').length,
    1,
  )
  await app.close()
})
