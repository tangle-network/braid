import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type InteractionRequest,
  type InteractionRequestMaterial,
  type InteractionResponse,
  type InteractionResponseCommand,
  permissionAnswerSpec,
} from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { AppError, BraidApplication } from '../src/app/application.js'
import type { InteractionReceipt } from '../src/app/application-types.js'
import { evaluateAutomation } from '../src/app/automation-matching.js'
import {
  type AutomationContext,
  type AutomationStoreInput,
  applyAutomation,
  automationAudits,
  createAutomationRule,
  deleteAutomationRule,
  disableAutomationRule,
  dryRunAutomation,
} from '../src/app/automation-rules.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { checkInteractionResponse } from '../src/app/interaction-response.js'
import {
  createInteractionRequest,
  interactionRequestMaterial,
  interactionResponseBinding,
  parseInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import { MemoryJournal } from '../src/app/journal.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { replayEvents } from '../src/domain/reducer.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import type { BraidInteraction } from '../src/domain/runtime-projection.js'
import { type BraidState, initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'

const NOW = '2026-08-01T00:00:00.000Z'

function questionRequest(
  id = 'interaction-question',
  overrides: Partial<InteractionRequestMaterial> = {},
): InteractionRequest {
  const interactionId = overrides.id ?? id
  return createInteractionRequest({
    id: interactionId,
    kind: overrides.kind ?? 'question',
    title: overrides.title ?? 'Continue the operation?',
    answerSpec: overrides.answerSpec ?? {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    ...(overrides.body === undefined ? {} : { body: overrides.body }),
    ...(overrides.subject === undefined ? {} : { subject: overrides.subject }),
    ...(overrides.responseScopes === undefined ? {} : { responseScopes: overrides.responseScopes }),
    ...(overrides.allowedOutcomes === undefined
      ? {}
      : { allowedOutcomes: overrides.allowedOutcomes }),
    ...(overrides.default === undefined ? {} : { default: overrides.default }),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.onTimeout === undefined ? {} : { onTimeout: overrides.onTimeout }),
    binding: overrides.binding ?? interactionBinding(interactionId),
  })
}

function permissionRequest(id = 'interaction-permission'): InteractionRequest {
  return createInteractionRequest({
    id,
    kind: 'permission',
    title: 'Allow the operation?',
    answerSpec: permissionAnswerSpec({
      allowFeedback: true,
      responseScopes: ['interaction', 'session', 'persistent'],
    }),
    responseScopes: ['interaction', 'session', 'persistent'],
    binding: interactionBinding(id),
  })
}

function interactionBinding(interactionId: string, runId = 'run-interaction') {
  return {
    runId,
    provider: 'test-provider',
    environmentId: 'environment-test',
    sessionId: 'session-test',
    executionId: runId,
    interactionId,
  }
}

function interaction(request: InteractionRequest, runId = 'run-interaction'): BraidInteraction {
  return {
    request,
    responseBinding: interactionResponseBinding(request),
    runId,
    source: { occurredAt: NOW },
    status: 'pending',
  }
}

function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('Timed out waiting for interaction state'))
        return
      }
      setTimeout(check, 5)
    }
    check()
  })
}

function applicationFor(
  execution: ExecutionPort,
  journal = new MemoryJournal(new FixedClock(NOW)),
): BraidApplication {
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(NOW),
    ids: new SequenceIds(),
    journal,
  })
  app.initialize('/workspace')
  return app
}

function interactionExecution(request: InteractionRequest): {
  readonly execution: ExecutionPort
  readonly responses: () => number
  readonly lastResponse: () => InteractionResponse | undefined
  readonly lastCommand: () => InteractionResponseCommand | undefined
  readonly release: () => void
} {
  let responseCount = 0
  let lastResponse: InteractionResponse | undefined
  let lastCommand: InteractionResponseCommand | undefined
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
    respondInteraction: async (input) => {
      responseCount += 1
      lastCommand = structuredClone(input.command)
      lastResponse = structuredClone(input.command.response)
      releaseStream?.()
      return { operationId: input.command.operationId, outcome: 'accepted' as const }
    },
  }
  return {
    execution,
    responses: () => responseCount,
    lastResponse: () => lastResponse,
    lastCommand: () => lastCommand,
    release: () => releaseStream?.(),
  }
}

function automationStore(now = NOW): AutomationStoreInput & {
  readonly current: () => BraidState
  readonly allEvents: () => readonly BraidEventEnvelope[]
  readonly setNow: (value: string) => void
} {
  let current = initialState(DETERMINISTIC_PROFILE)
  let currentNow = now
  const events: BraidEventEnvelope[] = []
  const commitAndWait = async (event: Parameters<AutomationStoreInput['commitAndWait']>[0]) => {
    const envelope: BraidEventEnvelope = {
      sequence: current.sequence + 1,
      revision: current.revision + 1,
      occurredAt: currentNow,
      event,
    }
    events.push(envelope)
    current = replayEvents(current, [envelope])
  }
  return {
    state: () => current,
    events: () => events,
    commitAndWait,
    now: () => currentNow,
    current: () => current,
    allEvents: () => events,
    setNow: (value) => {
      currentNow = value
    },
  }
}

test('published interaction validation handles typed defaults and rejects mismatched responses', () => {
  const request = questionRequest('interaction-typed', {
    answerSpec: {
      fields: [
        { type: 'text', name: 'label', label: 'Label', required: true, default: 'default-label' },
        { type: 'number', name: 'count', label: 'Count', required: true, min: 1, max: 5 },
        { type: 'boolean', name: 'enabled', label: 'Enabled', required: true, default: true },
        {
          type: 'select',
          name: 'mode',
          label: 'Mode',
          required: true,
          options: [
            { value: 'safe', label: 'Safe' },
            { value: 'fast', label: 'Fast' },
          ],
          default: ['safe'],
        },
      ],
    },
  })
  const checked = checkInteractionResponse(request, {
    id: request.id,
    outcome: 'accepted',
    data: { count: 3, mode: ['safe'] },
  })
  assert.deepEqual(checked.publicData, {
    label: 'default-label',
    count: 3,
    enabled: true,
    mode: ['safe'],
  })
  assert.equal(checked.containsSecret, false)
  assert.ok(checked.dataDigest)
  assert.throws(
    () => checkInteractionResponse(request, { id: 'other-interaction', outcome: 'declined' }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_INTERACTION_RESPONSE',
  )
})

test('secret answers are validated in memory but never become public data or automation', async () => {
  const request = questionRequest('interaction-manual-answer', {
    answerSpec: {
      fields: [{ type: 'secret', name: 'credential', label: 'Credential', required: true }],
    },
  })
  const checked = checkInteractionResponse(request, {
    id: request.id,
    outcome: 'accepted',
    data: { credential: 'secret-answer-fixture' },
  })
  assert.equal(checked.containsSecret, true)
  assert.equal(checked.publicData, undefined)
  assert.equal(checked.dataDigest, undefined)
  assert.deepEqual(checked.response.data, { credential: 'secret-answer-fixture' })

  const provider = interactionExecution(request)
  const app = applicationFor(provider.execution)
  app.send({ operationId: 'operation-send-secret', text: 'ask-for-secret' })
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')
  const runId = app.state().runs[0]?.id ?? ''
  await app.respondInteraction({
    operationId: 'operation-respond-secret',
    runId,
    interactionId: request.id,
    response: checked.response,
  })
  assert.deepEqual(provider.lastResponse()?.data, { credential: 'secret-answer-fixture' })
  assert.equal(JSON.stringify(app.events()).includes('secret-answer-fixture'), false)

  const store = automationStore()
  await assert.rejects(
    createAutomationRule({
      ...store,
      operationId: 'operation-secret-rule',
      ruleId: 'rule-secret',
      request,
      answer: { credential: 'secret-answer-fixture' },
      responseScope: 'once',
    }),
    (error: unknown) => error instanceof AppError && error.code === 'AUTOMATION_SECRET_FORBIDDEN',
  )
  assert.equal(store.allEvents().length, 0)
  assert.equal(JSON.stringify(store.current()).includes('secret-answer-fixture'), false)
  assert.equal(
    evaluateAutomation(store.current().rules, interaction(request), { now: NOW }).detail,
    'AUTOMATION_SECRET_FORBIDDEN',
  )
})

test('sensitive request context stays usable through a redacted display copy', async () => {
  const canary = 'SECRET_REQUEST_CONTEXT_CANARY'
  const request = questionRequest('interaction-sensitive-context', {
    subject: {
      type: 'tool',
      toolName: 'deploy',
      input: { apiKey: canary, target: 'production' },
    },
  })
  const provider = interactionExecution(request)
  const app = applicationFor(provider.execution)
  app.send({ operationId: 'operation-send-sensitive-context', text: 'deploy' })
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')

  const stored = app.state().runs[0]?.interactions[0]
  assert.ok(stored)
  assert.equal(stored.request.kind, 'question')
  assert.ok(parseInteractionRequest(stored.request))
  assert.deepEqual(stored.request.subject, {
    type: 'tool',
    toolName: 'deploy',
    input: { apiKey: '[redacted]', target: 'production' },
  })
  assert.notEqual(stored.request.requestDigest, stored.responseBinding.requestDigest)
  assert.equal(JSON.stringify(app.events()).includes(canary), false)

  await app.respondInteraction({
    operationId: 'operation-respond-sensitive-context',
    runId: stored.runId,
    interactionId: request.id,
    response: { id: request.id, outcome: 'declined' },
  })
  const command = provider.lastCommand()
  assert.ok(command)
  assert.deepEqual(command.binding, stored.responseBinding)
})

test('permission scope validation only accepts grants offered by the request', () => {
  const request = permissionRequest()
  const once = checkInteractionResponse(request, {
    id: request.id,
    outcome: 'accepted',
    data: { grant: ['allow_once'] },
  })
  assert.equal(once.containsSecret, false)
  assert.throws(
    () =>
      checkInteractionResponse(
        createInteractionRequest({
          ...interactionRequestMaterial(request),
          responseScopes: ['interaction'],
        }),
        { id: request.id, outcome: 'accepted', data: { grant: ['allow_session'] } },
      ),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_INTERACTION_RESPONSE',
  )
})

test('application interaction response is idempotent, conflict-safe, and survives restart', async () => {
  const request = questionRequest('interaction-restart')
  const provider = interactionExecution(request)
  const journal = new MemoryJournal(new FixedClock(NOW))
  const app = applicationFor(provider.execution, journal)
  app.send({ operationId: 'operation-send-interaction', text: 'ask' })
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')

  const response: InteractionResponse = {
    id: request.id,
    outcome: 'accepted',
    data: { continue: true },
  }
  const first = await app.respondInteraction({
    operationId: 'operation-respond-interaction',
    runId: app.state().runs[0]?.id ?? '',
    interactionId: request.id,
    response,
  })
  assert.equal(first.acknowledgement.outcome, 'accepted')
  assert.equal(provider.responses(), 1)
  const command = provider.lastCommand()
  const storedRequest = app.state().runs[0]?.interactions[0]?.request
  assert.ok(command)
  assert.ok(storedRequest)
  assert.equal(command.binding.runId, first.runId)
  assert.equal(command.binding.interactionId, request.id)
  assert.equal(command.binding.requestDigest, storedRequest.requestDigest)

  await assert.rejects(
    app.respondInteraction({
      operationId: 'operation-stale-interaction',
      runId: first.runId,
      interactionId: request.id,
      response,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'INTERACTION_STALE',
  )

  const replay = await app.respondInteraction({
    operationId: 'operation-respond-interaction',
    runId: first.runId,
    interactionId: request.id,
    response,
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.acknowledgement.outcome, 'already-applied')
  assert.equal(provider.responses(), 1)
  assert.equal(
    app.events().filter((event) => event.event.kind === 'run.interaction.response.requested')
      .length,
    1,
  )
  assert.equal(
    app.events().filter((event) => event.event.kind === 'run.interaction.responded').length,
    1,
  )
  assert.equal(app.state().feedbackDecisions.length, 1)

  await assert.rejects(
    app.respondInteraction({
      operationId: 'operation-respond-interaction',
      runId: first.runId,
      interactionId: request.id,
      response: { id: request.id, outcome: 'accepted', data: { continue: false } },
    }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )
  const restarted = applicationFor(
    {
      capabilities: () => DEFAULT_RUN_CAPABILITIES,
      async *streamTurn(): AsyncIterable<BraidRuntimeEvent> {},
    },
    journal,
  )
  const afterRestart = await restarted.respondInteraction({
    operationId: 'operation-respond-interaction',
    runId: first.runId,
    interactionId: request.id,
    response,
  })
  assert.equal(afterRestart.replayed, true)
  assert.equal(afterRestart.acknowledgement.outcome, 'already-applied')
  provider.release()
})

test('declined and cancelled interaction outcomes remain distinct after restart', async () => {
  for (const outcome of ['declined', 'cancelled'] as const) {
    const request = questionRequest(`interaction-${outcome}`)
    const provider = interactionExecution(request)
    const journal = new MemoryJournal(new FixedClock(NOW))
    const app = applicationFor(provider.execution, journal)
    app.send({ operationId: `operation-send-${outcome}`, text: outcome })
    await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')
    await app.respondInteraction({
      operationId: `operation-respond-${outcome}`,
      runId: app.state().runs[0]?.id ?? '',
      interactionId: request.id,
      response: { id: request.id, outcome },
    })
    assert.equal(app.state().runs[0]?.interactions[0]?.status, outcome)

    const restarted = applicationFor(
      {
        capabilities: () => DEFAULT_RUN_CAPABILITIES,
        async *streamTurn(): AsyncIterable<BraidRuntimeEvent> {},
      },
      journal,
    )
    assert.equal(restarted.state().runs[0]?.interactions[0]?.status, outcome)
    provider.release()
  }
})

test('the terminal API never reports an unconfirmed interaction response as accepted', async () => {
  const request = questionRequest('interaction-unconfirmed')
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
        }),
      }
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
    },
    respondInteraction: async (input) => ({
      operationId: input.command.operationId,
      outcome: 'unknown',
      detail: 'The provider did not confirm the response',
    }),
  }
  const app = applicationFor(execution)
  const send = app.send({ operationId: 'operation-send-unconfirmed', text: 'ask' })
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')
  const controller = createApplicationUiController(app)
  const result = await controller.dispatch({
    type: 'respond-interaction',
    operationId: 'operation-respond-unconfirmed',
    runId: app.state().runs[0]?.id ?? '',
    interactionId: request.id,
    response: { outcome: 'accept', value: true },
  })

  assert.equal(result.kind, 'unavailable')
  if (result.kind === 'unavailable') {
    assert.equal(result.code, 'CAPABILITY_UNAVAILABLE')
    assert.match(result.reason, /did not mark it accepted/u)
  }
  assert.equal(app.state().runs[0]?.interactions[0]?.status, 'unknown')
  assert.equal(app.state().feedbackDecisions.length, 0)
  releaseStream?.()
  await send.completion
})

test('stale and expired interactions are rejected before provider dispatch', async () => {
  const request = questionRequest('interaction-expired', { timeoutMs: 1, onTimeout: 'fail' })
  const provider = interactionExecution(request)
  const app = applicationFor(provider.execution)
  app.send({ operationId: 'operation-send-expired', text: 'expire' })
  await waitFor(() => app.state().runs[0]?.interactions[0]?.status === 'pending')
  const runId = app.state().runs[0]?.id ?? ''
  await assert.rejects(
    app.respondInteraction({
      operationId: 'operation-respond-expired',
      runId,
      interactionId: request.id,
      response: { id: request.id, outcome: 'accepted', data: { continue: true } },
    }),
    (error: unknown) => error instanceof AppError && error.code === 'INTERACTION_EXPIRED',
  )
  assert.equal(provider.responses(), 0)
  provider.release()
})

test('automation rules persist scopes, audit outcomes, limits, and mutations through one journal', async () => {
  const store = automationStore()
  const request = questionRequest('interaction-automation', {
    responseScopes: ['interaction', 'session', 'persistent'],
    subject: { type: 'tool', toolName: 'write_file' },
  })
  const context: AutomationContext = { runner: 'pi', providerSessionId: 'session-one' }
  const created = await createAutomationRule({
    ...store,
    operationId: 'operation-create-rule',
    ruleId: 'rule-automation',
    request,
    answer: { continue: true },
    responseScope: 'once',
    context,
    maximumUses: 1,
  })
  assert.equal(created.replayed, false)
  assert.equal(store.current().rules[0]?.uses, 0)
  assert.equal(store.current().operations[0]?.id, 'operation-create-rule')

  const replayedCreate = await createAutomationRule({
    ...store,
    operationId: 'operation-create-rule',
    ruleId: 'rule-automation',
    request,
    answer: { continue: true },
    responseScope: 'once',
    context,
    maximumUses: 1,
  })
  assert.equal(replayedCreate.replayed, true)
  await assert.rejects(
    createAutomationRule({
      ...store,
      operationId: 'operation-create-rule',
      ruleId: 'rule-automation',
      request,
      answer: { continue: false },
      responseScope: 'once',
      context,
      maximumUses: 1,
    }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )

  const dryRun = await dryRunAutomation({
    ...store,
    operationId: 'operation-dry-run',
    interaction: interaction(request),
    context,
  })
  assert.equal(dryRun.evaluation.status, 'eligible')
  assert.equal(automationAudits(store.allEvents()).at(-1)?.outcome, 'dry-run')

  let callbackUses = -1
  let responseCalls = 0
  const apply = await applyAutomation({
    ...store,
    operationId: 'operation-apply-rule',
    interaction: interaction(request),
    context,
    respond: async (response) => {
      responseCalls += 1
      callbackUses = store.current().rules[0]?.uses ?? -1
      assert.deepEqual(response.data, { continue: true })
      const receipt: InteractionReceipt = {
        operationId: 'operation-response-automation',
        runId: 'run-interaction',
        interactionId: request.id,
        replayed: false,
        acknowledgement: { operationId: 'operation-response-automation', outcome: 'accepted' },
        completion: Promise.resolve(store.current()),
      }
      return receipt
    },
  })
  assert.equal(apply.evaluation.status, 'eligible')
  assert.equal(callbackUses, 1)
  assert.equal(responseCalls, 1)
  assert.equal(automationAudits(store.allEvents()).at(-1)?.outcome, 'applied')

  const replayedApply = await applyAutomation({
    ...store,
    operationId: 'operation-apply-rule',
    interaction: interaction(request),
    context,
    respond: async () => {
      responseCalls += 1
      throw new Error('replayed automation dispatched twice')
    },
  })
  assert.equal(replayedApply.replayed, true)
  assert.equal(responseCalls, 1)

  const limited = await dryRunAutomation({
    ...store,
    operationId: 'operation-dry-run-limited',
    interaction: interaction(request),
    context,
  })
  assert.equal(limited.evaluation.status, 'use-limit')

  await disableAutomationRule({
    ...store,
    operationId: 'operation-disable-rule',
    ruleId: 'rule-automation',
  })
  assert.equal(store.current().rules[0]?.enabled, false)
  await deleteAutomationRule({
    ...store,
    operationId: 'operation-delete-rule',
    ruleId: 'rule-automation',
  })
  assert.equal(
    store.current().rules.some((rule) => rule.id === 'rule-automation'),
    false,
  )

  await createAutomationRule({
    ...store,
    operationId: 'operation-create-expiring-rule',
    ruleId: 'rule-expiring',
    request,
    answer: { continue: true },
    responseScope: 'once',
    context,
    expiresAt: '2026-08-02T00:00:00.000Z',
  })
  store.setNow('2026-08-03T00:00:00.000Z')
  const expired = await dryRunAutomation({
    ...store,
    operationId: 'operation-dry-run-expired',
    interaction: interaction(request),
    context,
  })
  assert.equal(expired.evaluation.status, 'expired')
  assert.equal(automationAudits(store.allEvents()).at(-1)?.outcome, 'expired')
})

test('automation resumes a reserved one-use answer after a crash', async () => {
  const store = automationStore()
  const request = questionRequest('interaction-automation-resume', {
    responseScopes: ['interaction'],
    subject: { type: 'tool', toolName: 'write_file' },
  })
  await createAutomationRule({
    ...store,
    operationId: 'operation-create-resumable-rule',
    ruleId: 'rule-resumable',
    request,
    answer: { continue: true },
    responseScope: 'once',
    maximumUses: 1,
  })

  await assert.rejects(
    applyAutomation({
      ...store,
      operationId: 'operation-apply-resumable-rule',
      interaction: interaction(request),
      context: {},
      respond: async () => {
        throw new Error('simulated crash after durable reservation')
      },
    }),
    /simulated crash/u,
  )
  assert.equal(store.current().rules[0]?.uses, 1)
  assert.equal(automationAudits(store.allEvents()).length, 0)

  let responses = 0
  const resumed = await applyAutomation({
    ...store,
    operationId: 'operation-apply-resumable-rule',
    interaction: interaction(request),
    context: {},
    respond: async (response) => {
      responses += 1
      assert.deepEqual(response.data, { continue: true })
      return {
        operationId: 'operation-apply-resumable-rule',
        runId: 'run-interaction',
        interactionId: request.id,
        replayed: true,
        acknowledgement: {
          operationId: 'operation-apply-resumable-rule',
          outcome: 'already-applied',
        },
        completion: Promise.resolve(store.current()),
      }
    },
  })

  assert.equal(responses, 1)
  assert.equal(resumed.evaluation.status, 'eligible')
  assert.equal(store.current().rules[0]?.uses, 1)
  assert.equal(automationAudits(store.allEvents()).at(-1)?.outcome, 'applied')
})

test('a matching saved rule answers an incoming interaction automatically', async () => {
  const request = questionRequest('interaction-automatic', {
    responseScopes: ['interaction'],
    subject: { type: 'tool', toolName: 'write_file' },
  })
  const provider = interactionExecution(request)
  const app = applicationFor(provider.execution)
  await app.automation.create({
    operationId: 'operation-create-automatic-rule',
    ruleId: 'rule-automatic',
    request,
    answer: { continue: true },
    responseScope: 'once',
    maximumUses: 1,
  })

  const send = app.send({ operationId: 'operation-send-automatic', text: 'write the file' })
  await waitFor(() => provider.responses() === 1)
  await send.completion

  assert.deepEqual(provider.lastResponse()?.data, { continue: true })
  assert.equal(app.state().runs[0]?.interactions[0]?.status, 'resolved')
  assert.equal(app.state().rules[0]?.uses, 1)
  assert.equal(automationAudits(app.events()).at(-1)?.outcome, 'applied')
  assert.equal(app.state().feedbackDecisions.at(-1)?.automated, true)
})

test('session and persistent automation require offered scope and exact context', async () => {
  const sessionStore = automationStore()
  const sessionRequest = questionRequest('interaction-session', { responseScopes: ['session'] })
  await assert.rejects(
    createAutomationRule({
      ...sessionStore,
      operationId: 'operation-session-unbound',
      ruleId: 'rule-session-unbound',
      request: sessionRequest,
      answer: { continue: true },
      responseScope: 'session',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'AUTOMATION_SCOPE_CONTEXT_REQUIRED',
  )
  await createAutomationRule({
    ...sessionStore,
    operationId: 'operation-session-rule',
    ruleId: 'rule-session',
    request: sessionRequest,
    answer: { continue: true },
    responseScope: 'session',
    context: { providerSessionId: 'session-one' },
  })
  assert.equal(
    (
      await dryRunAutomation({
        ...sessionStore,
        operationId: 'operation-session-match',
        interaction: interaction(sessionRequest),
        context: { providerSessionId: 'session-one' },
      })
    ).evaluation.status,
    'eligible',
  )
  assert.equal(
    (
      await dryRunAutomation({
        ...sessionStore,
        operationId: 'operation-session-miss',
        interaction: interaction(sessionRequest),
        context: { providerSessionId: 'session-two' },
      })
    ).evaluation.status,
    'none',
  )

  const persistentStore = automationStore()
  const persistentRequest = questionRequest('interaction-persistent', {
    responseScopes: ['persistent'],
  })
  await assert.rejects(
    createAutomationRule({
      ...persistentStore,
      operationId: 'operation-persistent-unconfirmed',
      ruleId: 'rule-persistent-unconfirmed',
      request: persistentRequest,
      answer: { continue: true },
      responseScope: 'persistent',
      context: { runner: 'pi' },
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'AUTOMATION_CONFIRMATION_REQUIRED',
  )
  await createAutomationRule({
    ...persistentStore,
    operationId: 'operation-persistent-rule',
    ruleId: 'rule-persistent',
    request: persistentRequest,
    answer: { continue: true },
    responseScope: 'persistent',
    confirmPersistent: true,
    context: { runner: 'pi' },
  })
  assert.equal(
    (
      await dryRunAutomation({
        ...persistentStore,
        operationId: 'operation-persistent-match',
        interaction: interaction(persistentRequest),
        context: { runner: 'pi' },
      })
    ).evaluation.status,
    'eligible',
  )
  assert.equal(
    (
      await dryRunAutomation({
        ...persistentStore,
        operationId: 'operation-persistent-scope-change',
        interaction: interaction(persistentRequest),
        context: { runner: 'other-runner' },
      })
    ).evaluation.status,
    'none',
  )
})

test('equal-priority structured rules fail closed instead of choosing an answer', async () => {
  const store = automationStore()
  const request = questionRequest('interaction-conflict', {
    responseScopes: ['interaction'],
    subject: { type: 'command', command: 'deploy' },
  })
  const context: AutomationContext = { runner: 'pi' }
  for (const [operationId, ruleId, answer] of [
    ['operation-conflict-one', 'rule-conflict-one', true],
    ['operation-conflict-two', 'rule-conflict-two', false],
  ] as const) {
    await createAutomationRule({
      ...store,
      operationId,
      ruleId,
      request,
      answer: { continue: answer },
      responseScope: 'once',
      context,
    })
  }
  const dryRun = await dryRunAutomation({
    ...store,
    operationId: 'operation-dry-run-conflict',
    interaction: interaction(request),
    context,
  })
  assert.equal(dryRun.evaluation.status, 'conflict')
  assert.equal(automationAudits(store.allEvents()).at(-1)?.outcome, 'conflict')
})
