import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  InteractionRequest,
  InteractionRequestMaterial,
  InteractionResponse,
} from '@tangle-network/agent-interface'
import { defaultTangleSandboxCapabilities } from '@tangle-network/agent-provider-tangle'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { automationAudits } from '../src/app/automation-rules.js'
import { createBraidApplication } from '../src/app/composition.js'
import { AppError } from '../src/app/errors.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  type RunCapabilities,
} from '../src/ports/execution.js'
import { interactionResponseRunCapabilities } from './support/run-capabilities.js'

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

function retainedRunCapabilities(responseSupported: boolean): RunCapabilities {
  const environment = structuredClone(defaultTangleSandboxCapabilities('opencode'))
  if (!responseSupported) delete environment.interactions
  return {
    ...DEFAULT_RUN_CAPABILITIES,
    streaming: { ...DEFAULT_RUN_CAPABILITIES.streaming, replay: true, detach: true },
    sessions: { ...DEFAULT_RUN_CAPABILITIES.sessions, continue: true },
    controls: { ...DEFAULT_RUN_CAPABILITIES.controls, recreate: true },
    events: { ...DEFAULT_RUN_CAPABILITIES.events, stableIdentity: true, cursor: true },
    environment,
  }
}

function retainedInteractionExecution(responseCapability: true | false | 'unknown'): {
  readonly execution: ExecutionPort
  readonly release: () => void
  readonly responseCount: () => number
} {
  const source = interactionRequest(
    responseCapability === true
      ? 'interaction-retained-capable'
      : `interaction-retained-${responseCapability === false ? 'incapable' : 'unknown'}`,
  )
  let releaseStream: (() => void) | undefined
  let responseCount = 0
  return {
    execution: {
      capabilities: () =>
        responseCapability === 'unknown'
          ? DEFAULT_RUN_CAPABILITIES
          : retainedRunCapabilities(responseCapability),
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
      // Retained ports expose this method even when the environment cannot record responses.
      respondInteraction: async (input) => {
        responseCount += 1
        releaseStream?.()
        return { operationId: input.command.operationId, outcome: 'accepted' }
      },
    },
    release: () => releaseStream?.(),
    responseCount: () => responseCount,
  }
}

test('retained response actions follow the admitted environment capability', async () => {
  for (const responseCapability of [true, false, 'unknown'] as const) {
    const responseSupported = responseCapability === true
    const retained = retainedInteractionExecution(responseCapability)
    const app = createBraidApplication({ fixture: 'deterministic', execution: retained.execution })
    app.initialize('/workspace')
    const send = app.send({
      operationId: `operation-send-retained-${String(responseCapability)}`,
      text: 'ask',
    })
    await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')
    const run = app.state().runs[0]
    const interaction = run?.interactions[0]
    assert(run && interaction)

    assert.equal(
      run.receipt.capabilities.environment?.interactions?.responseIdempotency === true,
      responseSupported,
    )
    assert.equal(app.canRespondToInteractions(run.id), responseSupported)
    assert.equal(app.canRespondToInteractions(), false)
    const controller = createApplicationUiController(app)
    assert.equal(
      controller.view().capabilities['interaction.respond']?.available,
      responseSupported,
    )
    assert.equal(
      controller.view().capabilities['interaction.automation']?.available,
      responseSupported,
    )

    if (responseSupported) {
      const receipt = await app.respondInteraction({
        operationId: `operation-respond-retained-${responseSupported}`,
        runId: run.id,
        interactionId: interaction.request.id,
        response: {
          id: interaction.request.id,
          outcome: 'accepted',
          data: { continue: true },
        },
      })
      assert.equal(receipt.acknowledgement.outcome, 'accepted')
      assert.equal(retained.responseCount(), 1)
    } else {
      await assert.rejects(
        app.respondInteraction({
          operationId: 'operation-respond-retained-incapable',
          runId: run.id,
          interactionId: interaction.request.id,
          response: {
            id: interaction.request.id,
            outcome: 'accepted',
            data: { continue: true },
          },
        }),
        (error: unknown) => error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE',
      )
      await assert.rejects(
        app.automation.apply({
          operationId: 'operation-automate-retained-incapable',
          runId: run.id,
          interactionId: interaction.request.id,
        }),
        (error: unknown) => error instanceof AppError && error.code === 'CAPABILITY_UNAVAILABLE',
      )
      assert.equal(retained.responseCount(), 0)
      assert.equal(
        app.events().filter((event) => event.event.kind === 'run.interaction.response.requested')
          .length,
        0,
      )
    }

    retained.release()
    await send.completion
    await app.close()
  }
})

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
    capabilities: () => interactionResponseRunCapabilities(),
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
