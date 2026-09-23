import assert from 'node:assert/strict'
import test from 'node:test'
import type { InteractionRequest, InteractionResponse } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import {
  InteractionController,
  InteractionError,
} from '../src/controllers/interaction-controller.js'
import { MAX_ID_BYTES, MAX_TEXT_BYTES } from '../src/domain/bounds.js'
import {
  interactionKey,
  type InteractionEvent,
  type InteractionEventEnvelope,
} from '../src/domain/interaction-state.js'
import {
  interactionRequestDigest,
  interactionResponseFingerprint,
} from '../src/domain/interaction.js'
import { FixedClock } from '../src/ports/clock.js'
import type {
  InteractionAck,
  InteractionRuntimePort,
  ReconcileInteractionInput,
  ReconciledInteraction,
  RespondToInteractionPortInput,
  RespondInteractionInput,
} from '../src/ports/interactions.js'
import type { Scheduler } from '../src/ports/scheduler.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { buildAppView } from '../src/app/view-model.js'

const CAPABILITIES = {
  kinds: ['question', 'permission', 'plan'],
  answerTypes: ['text', 'number', 'boolean', 'select', 'secret'] as const,
  scopes: ['once', 'session', 'persistent', 'deny'] as const,
  secretAnswers: true,
  concurrentRequests: true,
  replay: true,
  responseIdempotency: true,
}

class ScriptedRuntime implements InteractionRuntimePort {
  readonly capabilities
  readonly responseInputs: RespondToInteractionPortInput[] = []
  readonly reconcileInputs: ReconcileInteractionInput[] = []
  readonly #ackFactory: (
    input: RespondToInteractionPortInput,
    base: InteractionAck,
  ) => InteractionAck
  readonly #reconcileFactory: (
    input: ReconcileInteractionInput,
  ) => ReconciledInteraction | Promise<ReconciledInteraction>

  constructor(
    options: {
      readonly capabilities?: InteractionRuntimePort['capabilities']
      readonly ack?: (input: RespondToInteractionPortInput, base: InteractionAck) => InteractionAck
      readonly reconcile?: (
        input: ReconcileInteractionInput,
      ) => ReconciledInteraction | Promise<ReconciledInteraction>
    } = {},
  ) {
    this.capabilities = options.capabilities ?? CAPABILITIES
    this.#ackFactory = options.ack ?? ((_input, base) => base)
    this.#reconcileFactory =
      options.reconcile ??
      ((input) => ({
        status: 'pending',
        runId: input.runId,
        interactionId: input.interactionId,
        ...(input.providerSessionId === undefined
          ? {}
          : { providerSessionId: input.providerSessionId }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
        ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
        ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.runner === undefined ? {} : { runner: input.runner }),
        ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
      }))
  }

  async respondToInteraction(input: RespondToInteractionPortInput): Promise<InteractionAck> {
    this.responseInputs.push(input)
    return this.#ackFactory(input, {
      status: 'accepted',
      runId: input.runId,
      interactionId: input.interactionId,
      operationId: input.operationId,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
      ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
      ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.runner === undefined ? {} : { runner: input.runner }),
      ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
    })
  }

  async reconcileInteraction(input: ReconcileInteractionInput): Promise<ReconciledInteraction> {
    this.reconcileInputs.push(input)
    return this.#reconcileFactory(input)
  }
}

class TestClock {
  #value: string

  constructor(value = '2026-08-01T00:00:00.000Z') {
    this.#value = value
  }

  now(): string {
    return this.#value
  }

  advance(milliseconds: number): void {
    this.#value = new Date(Date.parse(this.#value) + milliseconds).toISOString()
  }
}

class ManualScheduler implements Scheduler {
  #next = 0
  readonly #callbacks = new Map<number, () => void>()
  clearCount = 0

  set(callback: () => void): number {
    const handle = ++this.#next
    this.#callbacks.set(handle, callback)
    return handle
  }

  clear(handle: unknown): void {
    this.clearCount += 1
    this.#callbacks.delete(handle as number)
  }

  async fire(): Promise<void> {
    const callbacks = [...this.#callbacks.values()]
    this.#callbacks.clear()
    for (const callback of callbacks) callback()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  get size(): number {
    return this.#callbacks.size
  }
}

function request(
  id: string,
  answerSpec: InteractionRequest['answerSpec'] = {
    fields: [{ type: 'text', name: 'value', label: 'Value', required: true }],
  },
  extra: Partial<InteractionRequest> = {},
): InteractionRequest {
  return {
    id,
    kind: 'question',
    title: 'Question',
    answerSpec,
    ...extra,
  }
}

function controller(
  runtime: InteractionRuntimePort,
  options: {
    readonly clock?: { now(): string }
    readonly scheduler?: Scheduler
    readonly secretResponseKey?: string
    readonly initialEvents?: ReturnType<InteractionController['events']>
    readonly defaultContext?: {
      readonly profileDigest?: string
      readonly connectionId?: string
      readonly workspaceId?: string
      readonly conversationId?: string
      readonly branchId?: string
      readonly model?: string
      readonly runner?: string
    }
  } = {},
): InteractionController {
  return new InteractionController({
    runtime,
    clock: options.clock ?? new FixedClock(),
    ids: new SequenceIds(),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.secretResponseKey === undefined
      ? {}
      : { secretResponseKey: options.secretResponseKey }),
    ...(options.initialEvents === undefined ? {} : { initialEvents: options.initialEvents }),
    ...(options.defaultContext === undefined ? {} : { defaultContext: options.defaultContext }),
  })
}

function bindingFor(
  controllerInstance: InteractionController,
  runId: string,
  interactionId: string,
) {
  const record = controllerInstance
    .state()
    .interactions.find((item) => item.runId === runId && item.interactionId === interactionId)
  assert.ok(record)
  return {
    runId,
    interactionId,
    ...(record.providerSessionId === undefined
      ? {}
      : { providerSessionId: record.providerSessionId }),
    ...(record.profileDigest === undefined ? {} : { profileDigest: record.profileDigest }),
    ...(record.connectionId === undefined ? {} : { connectionId: record.connectionId }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: record.workspaceId }),
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.branchId === undefined ? {} : { branchId: record.branchId }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.runner === undefined ? {} : { runner: record.runner }),
    ...(record.requestRevision === undefined ? {} : { requestRevision: record.requestRevision }),
  }
}

function response(
  controllerInstance: InteractionController,
  runId: string,
  interactionId: string,
  operationId: string,
  data: InteractionResponse['data'] = { value: 'answer' },
): RespondInteractionInput {
  return {
    ...bindingFor(controllerInstance, runId, interactionId),
    operationId,
    response: { id: interactionId, outcome: 'accepted', data },
  }
}

function runtimeEvent(event: object): RuntimeStreamEvent {
  return event as RuntimeStreamEvent
}

test('W9-01 normal composition exposes the canonical interaction controller', () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  assert.ok(app.interactionController())
  assert.deepEqual(app.interactionCapabilities().kinds, [])
  app.shutdown()
})

test('W9-02 runtime questions_start becomes canonical application state and events', async () => {
  const runtime = new ScriptedRuntime()
  const task = { id: 'task-question', intent: 'ask for a value' }
  const session = {
    id: 'provider-session-1',
    backend: 'scripted',
    status: 'active' as const,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  }
  const execution: ExecutionPort = {
    interactions: runtime,
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield runtimeEvent({ type: 'session_created', task, session, timestamp: session.createdAt })
      yield runtimeEvent({
        type: 'questions_start',
        task,
        questions: [
          {
            id: 'runtime-question',
            question: 'Need a value',
            reason: 'The next action depends on it',
            requirementId: 'value',
            importance: 'high',
            answerType: 'free_text',
            impactIfUnknown: 'The action cannot continue',
          },
        ],
        timestamp: session.updatedAt,
      })
      yield runtimeEvent({
        type: 'final',
        status: 'completed',
        reason: 'question surfaced',
        text: '',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task,
        timestamp: session.updatedAt,
      })
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-question', text: 'start' }).completion
  assert.equal(app.state().interactions[0]?.interactionId, 'runtime-question')
  assert.equal(app.state().interactions[0]?.providerSessionId, 'provider-session-1')
  assert.equal(
    app.events().some((item) => item.event.kind === 'interaction.requested'),
    true,
  )
  assert.equal(app.interactionController().views().length, 1)
  app.shutdown()
})

test('W9-03 a changed provider session is an identity conflict, not a duplicate', () => {
  const app = controller(new ScriptedRuntime())
  const first = request('session-bound')
  app.receive({ runId: 'run-1', providerSessionId: 'session-a', request: first })
  assert.throws(
    () => app.receive({ runId: 'run-1', providerSessionId: 'session-b', request: first }),
    (error: unknown) => error instanceof InteractionError && error.code === 'IDENTITY_CONFLICT',
  )
  assert.equal(app.state().interactions.length, 1)
})

test('W9-03 reconciliation rejects a changed provider session identity', async () => {
  const runtime = new ScriptedRuntime({
    reconcile: (input) => ({
      status: 'resolved',
      runId: input.runId,
      interactionId: input.interactionId,
      providerSessionId: 'session-reconciled-other',
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
      outcome: 'accepted',
    }),
  })
  const app = controller(runtime)
  app.receive({
    runId: 'run-reconcile-session',
    providerSessionId: 'session-reconciled',
    request: request('reconcile-session'),
  })
  await app.reconcile()
  assert.equal(runtime.reconcileInputs.length, 1)
  assert.equal(app.state().interactions[0]?.status, 'identity_conflict')
  assert.equal(app.state().interactions[0]?.resolution, undefined)
})

test('W9-04 typed length-delimited identities do not collide', () => {
  assert.notEqual(interactionKey('a:b', 'c'), interactionKey('a', 'b:c'))
})

test('W9-05 every mismatched provider acknowledgement identity is rejected', async () => {
  const mutations: readonly [
    string,
    (input: RespondToInteractionPortInput) => Partial<InteractionAck>,
  ][] = [
    ['run', () => ({ runId: 'other-run' })],
    ['interaction', () => ({ interactionId: 'other-interaction' })],
    ['operation', () => ({ operationId: 'other-operation' })],
    ['session', () => ({ providerSessionId: 'other-session' })],
    ['profile', () => ({ profileDigest: 'other-profile' })],
    ['connection', () => ({ connectionId: 'other-connection' })],
    ['workspace', () => ({ workspaceId: 'other-workspace' })],
    ['conversation', () => ({ conversationId: 'other-conversation' })],
    ['branch', () => ({ branchId: 'other-branch' })],
    ['model', () => ({ model: 'other-model' })],
    ['runner', () => ({ runner: 'other-runner' })],
    ['revision', () => ({ requestRevision: 99 })],
    ['request', () => ({ requestDigest: 'other-request' })],
    ['response', () => ({ responseDigest: 'other-response' })],
  ]
  for (const [label, mutate] of mutations) {
    const runtime = new ScriptedRuntime({
      ack: (input, base) => ({ ...base, ...mutate(input) }),
    })
    const app = controller(runtime, {
      defaultContext: {
        profileDigest: 'profile',
        connectionId: 'connection',
        workspaceId: 'workspace',
        conversationId: 'conversation',
        branchId: 'branch',
        model: 'model',
        runner: 'runner',
      },
    })
    app.receive({
      runId: 'run-identity',
      providerSessionId: 'session-identity',
      request: request(`interaction-${label}`),
    })
    const result = await app.respond(
      response(app, 'run-identity', `interaction-${label}`, `operation-${label}`),
    )
    assert.equal(result.status, 'identity_conflict', label)
    assert.equal(app.state().interactions[0]?.resolution, undefined)
  }
})

test('W9-06 declined and expired acknowledgements never become accepted outcomes', async () => {
  for (const status of ['declined', 'expired'] as const) {
    const runtime = new ScriptedRuntime({ ack: (_input, base) => ({ ...base, status }) })
    const app = controller(runtime)
    const id = `interaction-${status}`
    app.receive({ runId: 'run-outcome', request: request(id) })
    const result = await app.respond(response(app, 'run-outcome', id, `operation-${status}`))
    assert.equal(result.status, status)
    assert.equal(app.state().interactions[0]?.status, status)
    assert.equal(
      app.state().interactions[0]?.resolution?.outcome,
      status === 'declined' ? 'declined' : undefined,
    )
    assert.equal(
      app.state().audits.some((audit) => audit.outcome === 'applied'),
      false,
    )
  }
})

test('W9-07 resolved reconciliation without an exact outcome fails closed', async () => {
  const runtime = new ScriptedRuntime({
    reconcile: (input) => ({
      status: 'resolved',
      runId: input.runId,
      interactionId: input.interactionId,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
    }),
  })
  const app = controller(runtime)
  app.receive({ runId: 'run-missing-outcome', request: request('missing-outcome') })
  await app.reconcile()
  assert.equal(runtime.reconcileInputs.length, 1)
  assert.equal(app.state().interactions[0]?.status, 'identity_conflict')
})

test('W9-08 restart retries reconcile an uncertain response and rejects changed input', async () => {
  const key = '0123456789abcdef0123456789abcdef'
  const firstRuntime = new ScriptedRuntime({
    ack: (_input, base) => ({ ...base, status: 'transport_error' }),
  })
  const first = controller(firstRuntime, { secretResponseKey: key })
  first.receive({
    runId: 'run-restart',
    providerSessionId: 'session-restart',
    request: request('restart-interaction'),
  })
  const firstResult = await first.respond(
    response(first, 'run-restart', 'restart-interaction', 'operation-restart'),
  )
  assert.equal(firstResult.status, 'transport_error')
  assert.equal(first.state().interactions[0]?.status, 'transport_error')

  let reconciliationCount = 0
  const restoredRuntime = new ScriptedRuntime({
    reconcile: (input) => {
      reconciliationCount += 1
      if (reconciliationCount === 1) {
        return {
          status: 'pending',
          runId: input.runId,
          interactionId: input.interactionId,
          ...(input.providerSessionId === undefined
            ? {}
            : { providerSessionId: input.providerSessionId }),
          ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
          ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
          ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
          ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
          ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
          ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.runner === undefined ? {} : { runner: input.runner }),
          ...(input.requestRevision === undefined
            ? {}
            : { requestRevision: input.requestRevision }),
        }
      }
      return {
        status: 'resolved',
        runId: input.runId,
        interactionId: input.interactionId,
        ...(input.providerSessionId === undefined
          ? {}
          : { providerSessionId: input.providerSessionId }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
        ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
        ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
        ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
        ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.runner === undefined ? {} : { runner: input.runner }),
        ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
        outcome: 'accepted',
      }
    },
  })
  const restored = controller(restoredRuntime, {
    secretResponseKey: key,
    initialEvents: first.events(),
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const retry = await restored.respond(
    response(restored, 'run-restart', 'restart-interaction', 'operation-restart'),
  )
  assert.equal(retry.status, 'accepted')
  assert.equal(restoredRuntime.responseInputs.length, 0)
  assert.equal(restored.state().interactions[0]?.status, 'resolved')
  const changed = await restored.respond(
    response(restored, 'run-restart', 'restart-interaction', 'operation-restart', {
      value: 'changed',
    }),
  )
  assert.equal(changed.status, 'conflict')
})

test('W9-08 a crash after intent persistence leaves responding and reconciles without dispatch', async () => {
  const secretKey = '0123456789abcdef0123456789abcdef'
  const first = controller(new ScriptedRuntime(), { secretResponseKey: secretKey })
  first.receive({ runId: 'run-crash-intent', request: request('crash-intent') })
  const record = first.state().interactions[0]
  assert.ok(record)
  const responseData = { value: 'answer' }
  const responseDigest = interactionResponseFingerprint(
    record.request,
    { outcome: 'accepted', data: responseData },
    secretKey,
  )
  const previous = first.events().at(-1)
  assert.ok(previous)
  const intent: InteractionEvent = {
    kind: 'interaction.response.requested',
    key: record.key,
    runId: record.runId,
    interactionId: record.interactionId,
    operationId: 'operation-crash-intent',
    outcome: 'accepted',
    ...(record.requestRevision === undefined ? {} : { requestRevision: record.requestRevision }),
    requestDigest: interactionRequestDigest(record.request),
    responseDigest,
    publicData: responseData,
    containsSecret: false,
  }
  const initialEvents: InteractionEventEnvelope[] = [
    ...first.events(),
    {
      eventId: 'event-crash-intent',
      sequence: previous.sequence + 1,
      revision: previous.revision + 1,
      occurredAt: '2026-08-01T00:00:01.000Z',
      event: intent,
    },
  ]
  const restoredRuntime = new ScriptedRuntime({
    reconcile: (input) => ({
      status: 'resolved',
      runId: input.runId,
      interactionId: input.interactionId,
      ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
      ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      outcome: 'accepted',
    }),
  })
  const restored = controller(restoredRuntime, { initialEvents, secretResponseKey: secretKey })
  assert.equal(restored.state().interactions[0]?.status, 'responding')
  const retry = await restored.respond(
    response(restored, 'run-crash-intent', 'crash-intent', 'operation-crash-intent'),
  )
  assert.equal(retry.status, 'accepted')
  assert.equal(restoredRuntime.responseInputs.length, 0)
  assert.equal(restored.state().interactions[0]?.status, 'resolved')
  const changed = await restored.respond(
    response(restored, 'run-crash-intent', 'crash-intent', 'operation-crash-intent', {
      value: 'changed',
    }),
  )
  assert.equal(changed.status, 'conflict')
})

test('W9-08b application restart keeps journal event identity unique', async () => {
  const journalKey = new Uint8Array(32).fill(7)
  const execution: ExecutionPort = {
    streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      return (async function* (): AsyncGenerator<RuntimeStreamEvent> {
        yield* []
      })()
    },
  }
  const first = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    interactionRuntime: new ScriptedRuntime(),
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journalKey,
    secretResponseKey: journalKey,
  })
  first.initialize('/workspace')
  first.receiveInteraction({
    runId: 'run-app-restart',
    providerSessionId: 'session-app-restart',
    request: request('app-restart-interaction'),
  })
  const initialEvents = first.events()
  const initialInteractionEvent = initialEvents.find(
    (event) => event.event.kind === 'interaction.requested',
  )
  assert.ok(initialInteractionEvent?.eventId)
  const runtime = new ScriptedRuntime()
  const restored = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    interactionRuntime: runtime,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    initialEvents,
    journalKey,
    secretResponseKey: journalKey,
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const view = restored.interactionController().views()[0]
  assert.ok(view)
  const result = await restored.respondInteraction({
    runId: view.runId,
    interactionId: view.interactionId,
    ...(view.providerSessionId === undefined ? {} : { providerSessionId: view.providerSessionId }),
    ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
    ...(view.conversationId === undefined ? {} : { conversationId: view.conversationId }),
    ...(view.branchId === undefined ? {} : { branchId: view.branchId }),
    ...(view.model === undefined ? {} : { model: view.model }),
    ...(view.runner === undefined ? {} : { runner: view.runner }),
    ...(view.requestRevision === undefined ? {} : { requestRevision: view.requestRevision }),
    operationId: 'operation-app-restart',
    response: { id: view.interactionId, outcome: 'accepted', data: { value: 'answer' } },
  })
  assert.equal(result.status, 'accepted')
  assert.ok(restored.events().length > initialEvents.length)
  assert.equal(
    restored.events().find((event) => event.event.kind === 'interaction.requested')?.eventId,
    initialInteractionEvent?.eventId,
  )
  assert.equal(
    restored.events().some((event) => event.event.kind === 'interaction.resolved'),
    true,
  )
  restored.shutdown()
  first.shutdown()
})

test('W9-09 replaying an automation operation does not duplicate its rule', () => {
  const first = controller(new ScriptedRuntime())
  const input = {
    operationId: 'automation-create-once',
    request: request('automation-template'),
    answer: { value: 'automatic' },
    responseScope: 'once' as const,
  }
  const rule = first.createAutomationRule(input)
  const restored = controller(new ScriptedRuntime(), { initialEvents: first.events() })
  const replay = restored.createAutomationRule(input)
  assert.equal(replay.id, rule.id)
  assert.equal(restored.state().rules.length, 1)
  assert.equal(restored.events().length, first.events().length)
})

test('W9-10 provider errors and profile metadata are absent from canonical state and events', async () => {
  const nestedSecret = 'NESTED-CANARY-SECRET-4567'
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield* []
      throw new Error(`provider failed: Bearer CANARY-SECRET-1234 ${nestedSecret}`)
    },
  }
  const app = new BraidApplication({
    profile: {
      ...DETERMINISTIC_PROFILE,
      metadata: { token: 'CANARY-SECRET-1234' },
      extensions: { auth: { token: nestedSecret } },
    } as unknown as typeof DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-error-secret', text: 'run' }).completion
  const serialized = JSON.stringify({ state: app.state(), events: app.events() })
  assert.equal(serialized.includes('CANARY-SECRET-1234'), false)
  assert.equal(serialized.includes(nestedSecret), false)
  assert.match(app.state().lastError ?? '', /<REDACTED>/u)
  app.shutdown()
})

test('W9-11 response identity is bound to the provider session in state, events, and dispatch', async () => {
  const runtime = new ScriptedRuntime()
  const app = controller(runtime, {
    defaultContext: {
      profileDigest: 'profile',
      connectionId: 'connection',
      workspaceId: 'workspace',
      runner: 'pi',
    },
  })
  app.receive({
    runId: 'run-binding',
    providerSessionId: 'session-binding',
    request: request('binding-interaction'),
  })
  const result = await app.respond(
    response(app, 'run-binding', 'binding-interaction', 'operation-binding'),
  )
  assert.equal(result.status, 'accepted')
  assert.equal(runtime.responseInputs[0]?.providerSessionId, 'session-binding')
  const responseEvent = app
    .events()
    .find((event) => event.event.kind === 'interaction.response.requested')
  assert.equal(responseEvent?.event.kind, 'interaction.response.requested')
  if (responseEvent?.event.kind === 'interaction.response.requested') {
    assert.equal(responseEvent.event.providerSessionId, 'session-binding')
  }
})

test('W9-12 unknown provider interaction state is reconciled with its typed status', async () => {
  const runtime = new ScriptedRuntime({
    reconcile: (input) => ({
      status: 'unknown_interaction',
      runId: input.runId,
      interactionId: input.interactionId,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
      ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.runner === undefined ? {} : { runner: input.runner }),
      ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
    }),
  })
  const app = controller(runtime)
  app.receive({ runId: 'run-unknown', request: request('unknown-interaction') })
  await app.reconcile()
  assert.equal(runtime.reconcileInputs.length, 1)
  assert.equal(app.state().interactions[0]?.status, 'unknown_interaction')
})

test('generic reconciliation unknown stays distinct from transport failure', async () => {
  const runtime = new ScriptedRuntime({
    reconcile: (input) => ({
      status: 'unknown',
      runId: input.runId,
      interactionId: input.interactionId,
      ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
    }),
  })
  const app = controller(runtime)
  app.receive({ runId: 'run-generic-unknown', request: request('generic-unknown') })
  await app.reconcile()
  assert.equal(app.state().interactions[0]?.status, 'unknown')
})

test('W9-12 an uncertain response immediately asks the provider for reconciliation', async () => {
  const runtime = new ScriptedRuntime({
    ack: (_input, base) => ({ ...base, status: 'transport_error' }),
    reconcile: (input) => ({
      status: 'resolved',
      runId: input.runId,
      interactionId: input.interactionId,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
      ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
      outcome: 'accepted',
    }),
  })
  const app = controller(runtime)
  app.receive({ runId: 'run-uncertain', request: request('uncertain') })
  const result = await app.respond(response(app, 'run-uncertain', 'uncertain', 'op-uncertain'))
  assert.equal(result.status, 'transport_error')
  assert.equal(runtime.responseInputs.length, 1)
  assert.equal(runtime.reconcileInputs.length, 1)
  assert.equal(app.state().interactions[0]?.status, 'resolved')
  const retry = await app.respond(response(app, 'run-uncertain', 'uncertain', 'op-uncertain'))
  assert.equal(retry.status, 'already_resolved')
  assert.equal(retry.replayed, true)
  const retryAgain = await app.respond(response(app, 'run-uncertain', 'uncertain', 'op-uncertain'))
  assert.equal(retryAgain.status, 'already_resolved')
  assert.equal(retryAgain.replayed, true)
  assert.equal(runtime.responseInputs.length, 1)
})

test('W9-13 responseIdempotency=false blocks dispatch before the provider effect', async () => {
  const runtime = new ScriptedRuntime({
    capabilities: { ...CAPABILITIES, responseIdempotency: false },
  })
  const app = controller(runtime)
  app.receive({ runId: 'run-no-replay', request: request('no-replay') })
  const result = await app.respond(
    response(app, 'run-no-replay', 'no-replay', 'operation-no-replay'),
  )
  assert.equal(result.status, 'invalid')
  assert.equal(runtime.responseInputs.length, 0)
  assert.equal(app.state().interactions[0]?.status, 'pending')
})

test('W9-14 secret response operation identity distinguishes changed plaintext without persistence', async () => {
  const canary = 'CANARY-SECRET-1234'
  const runtime = new ScriptedRuntime()
  const app = controller(runtime, {
    secretResponseKey: '0123456789abcdef0123456789abcdef',
  })
  app.receive({
    runId: 'run-secret-retry',
    request: request('secret-retry', {
      fields: [{ type: 'secret', name: 'token', label: 'Token', required: true }],
    }),
  })
  const first = await app.respond(
    response(app, 'run-secret-retry', 'secret-retry', 'operation-secret', { token: canary }),
  )
  const changed = await app.respond(
    response(app, 'run-secret-retry', 'secret-retry', 'operation-secret', {
      token: 'different-secret',
    }),
  )
  assert.equal(first.status, 'accepted')
  assert.equal(changed.status, 'conflict')
  assert.equal(runtime.responseInputs.length, 1)
  assert.equal(JSON.stringify({ state: app.state(), events: app.events() }).includes(canary), false)
})

test('W9-14 secret provider diagnostics never reach receipts or state', async () => {
  const runtime = new ScriptedRuntime({
    ack: (_input, base) => ({
      ...base,
      status: 'transport_error',
      reason: 'Bearer CANARY-SECRET-1234',
    }),
  })
  const app = controller(runtime, { secretResponseKey: '0123456789abcdef0123456789abcdef' })
  app.receive({
    runId: 'run-secret-diagnostic',
    request: request('secret-diagnostic', {
      fields: [{ type: 'secret', name: 'token', label: 'Token', required: true }],
    }),
  })
  const result = await app.respond(
    response(app, 'run-secret-diagnostic', 'secret-diagnostic', 'operation-diagnostic', {
      token: 'CANARY-SECRET-1234',
    }),
  )
  assert.equal(result.status, 'transport_error')
  assert.equal(
    JSON.stringify({ result, state: app.state(), events: app.events() }).includes(
      'CANARY-SECRET-1234',
    ),
    false,
  )
})

test('W9-15 automatic timeout uses the injected scheduler and cleans its handle', async () => {
  const clock = new TestClock()
  const scheduler = new ManualScheduler()
  const runtime = new ScriptedRuntime()
  const app = controller(runtime, { clock, scheduler })
  app.receive({
    runId: 'run-timeout',
    request: request('timeout', undefined, {
      timeoutMs: 10,
      onTimeout: 'fail',
    }),
  })
  assert.equal(scheduler.size, 1)
  await scheduler.fire()
  assert.equal(app.state().interactions[0]?.status, 'pending')
  assert.equal(scheduler.size, 1)
  clock.advance(10)
  await scheduler.fire()
  assert.equal(app.state().interactions[0]?.status, 'declined')
  assert.equal(scheduler.size, 0)
  app.dispose()
  assert.equal(scheduler.size, 0)

  const waitingClock = new TestClock()
  const waitingScheduler = new ManualScheduler()
  const waiting = controller(new ScriptedRuntime(), {
    clock: waitingClock,
    scheduler: waitingScheduler,
  })
  waiting.receive({
    runId: 'run-timeout-wait',
    request: request('timeout-wait', undefined, { timeoutMs: 10, onTimeout: 'wait' }),
  })
  assert.equal(waitingScheduler.size, 1)
  await waitingScheduler.fire()
  assert.equal(waiting.state().interactions[0]?.status, 'pending')
  assert.equal(waitingScheduler.size, 1)
  waitingClock.advance(10)
  await waitingScheduler.fire()
  assert.equal(waiting.state().interactions[0]?.status, 'pending')
  assert.equal(waitingScheduler.size, 0)
  waiting.dispose()
})

test('automation disable and delete reject invalid operation identity before mutation', () => {
  const app = controller(new ScriptedRuntime())
  const rule = app.createAutomationRule({
    operationId: 'automation-command-create',
    request: request('automation-command'),
    answer: { value: 'automatic' },
    responseScope: 'once',
  })
  assert.throws(
    () => app.disableAutomationRule('', rule.id),
    (error: unknown) =>
      error instanceof InteractionError && error.code === 'INVALID_AUTOMATION_RULE',
  )
  assert.equal(app.state().rules[0]?.enabled, true)
  assert.throws(
    () => app.deleteAutomationRule('', rule.id),
    (error: unknown) =>
      error instanceof InteractionError && error.code === 'INVALID_AUTOMATION_RULE',
  )
  assert.equal(app.state().rules.length, 1)
})

test('W9-16 application and controller views use the same injected clock', () => {
  const clock = new TestClock()
  const app = createBraidApplication({
    fixture: 'deterministic',
    clock,
    ids: new SequenceIds(),
    interactionRuntime: new ScriptedRuntime(),
  })
  app.receiveInteraction({
    runId: 'run-clock',
    request: request('clock-interaction', undefined, { timeoutMs: 60_000 }),
  })
  const applicationView = buildAppView(app.state(), app.interactionCapabilities(), app.now())
  const controllerView = app.interactionController().views()
  assert.equal(applicationView.interactions[0]?.remainingMs, 60_000)
  assert.equal(controllerView[0]?.remainingMs, 60_000)
  app.shutdown()
})

test('W9-20 unknown kinds render generic and cannot be accepted', async () => {
  const runtime = new ScriptedRuntime({
    capabilities: { ...CAPABILITIES, kinds: ['future_kind'] },
  })
  const app = controller(runtime)
  app.receive({
    runId: 'run-future',
    request: request('future-kind', undefined, { kind: 'future_kind' }),
  })
  const view = app.views()[0]
  assert.ok(view)
  assert.equal(view.surface, 'generic')
  assert.equal(view.canRespond, false)
  const result = await app.respond(response(app, 'run-future', 'future-kind', 'operation-future'))
  assert.equal(result.status, 'invalid')
  assert.equal(runtime.responseInputs.length, 0)
})

test('W9-29 automation is applied only after an exact accepted provider outcome', async () => {
  const runtime = new ScriptedRuntime({
    ack: (_input, base) => ({ ...base, status: 'declined' }),
  })
  const app = controller(runtime)
  const received = app.receive({
    runId: 'run-automation-decline',
    request: request('automation-decline'),
  })
  app.createAutomationRule({
    operationId: 'operation-rule-decline',
    interactionKey: received.key,
    answer: { value: 'automatic' },
    responseScope: 'once',
  })
  await app.waitForAutomation()
  assert.equal(app.state().interactions[0]?.status, 'declined')
  assert.equal(app.state().rules[0]?.uses, 0)
  assert.equal(
    app.state().audits.some((audit) => audit.outcome === 'applied'),
    false,
  )
  assert.equal(
    app.state().audits.some((audit) => audit.outcome === 'skipped'),
    true,
  )
})

test('uncertain automation is finalized only after reconciliation proves acceptance', async () => {
  const runtime = new ScriptedRuntime({
    ack: (_input, base) => ({ ...base, status: 'transport_error' }),
    reconcile: (input) => ({
      status: 'resolved',
      runId: input.runId,
      interactionId: input.interactionId,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
      ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
      ...(input.requestRevision === undefined ? {} : { requestRevision: input.requestRevision }),
      ...(input.requestDigest === undefined ? {} : { requestDigest: input.requestDigest }),
      ...(input.responseDigest === undefined ? {} : { responseDigest: input.responseDigest }),
      outcome: 'accepted',
    }),
  })
  const app = controller(runtime)
  const received = app.receive({
    runId: 'run-automation-reconcile',
    request: request('automation-reconcile'),
  })
  app.createAutomationRule({
    operationId: 'operation-rule-reconcile',
    interactionKey: received.key,
    answer: { value: 'automatic' },
    responseScope: 'once',
  })
  await app.waitForAutomation()
  assert.equal(app.state().interactions[0]?.status, 'resolved')
  assert.equal(app.state().rules[0]?.uses, 1)
  assert.equal(
    app
      .state()
      .audits.some((audit) => audit.interactionKey === received.key && audit.outcome === 'applied'),
    true,
  )
})

test('W9-27 provider streams are bounded before they enter application state', async () => {
  const text = 'x'.repeat(300_000)
  const task = { id: 'task-stream-bound', intent: 'stream a lot' }
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield runtimeEvent({ type: 'text_delta', text, task })
      yield runtimeEvent({
        type: 'final',
        status: 'completed',
        reason: 'bounded',
        text: '',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task,
        timestamp: '2026-08-01T00:00:00.000Z',
      })
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'operation-stream-bound', text: 'start' }).completion
  const assistant = app.state().messages.find((message) => message.role === 'assistant')
  assert.ok(assistant)
  assert.ok(Buffer.byteLength(assistant.text) <= MAX_TEXT_BYTES)
  const delta = app.events().find((event) => event.event.kind === 'run.text.delta')
  assert.equal(delta?.event.kind, 'run.text.delta')
  if (delta?.event.kind === 'run.text.delta') {
    assert.ok(Buffer.byteLength(delta.event.text) <= MAX_TEXT_BYTES)
  }
  app.shutdown()
})

test('provider session identities are bounded and malformed streams fail closed', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield runtimeEvent({
        type: 'session_created',
        session: { id: 'x'.repeat(MAX_ID_BYTES + 1) },
      })
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'operation-invalid-session', text: 'start' }).completion
  assert.equal(app.state().runs[0]?.status, 'failed')
  assert.equal(app.state().runs[0]?.providerSessionId, undefined)
  assert.equal(app.state().activeRunId, null)
  app.shutdown()
})

test('a second provider final event cannot rewrite the canonical run result', async () => {
  const task = { id: 'task-duplicate-final', intent: 'return once' }
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield runtimeEvent({
        type: 'final',
        status: 'completed',
        text: 'first result',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task,
        timestamp: '2026-08-01T00:00:00.000Z',
      })
      yield runtimeEvent({
        type: 'final',
        status: 'failed',
        text: 'second result must be ignored',
        metadata: { tokenUsage: { input: 2, output: 2 } },
        task,
        timestamp: '2026-08-01T00:00:00.000Z',
      })
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'operation-duplicate-final', text: 'start' }).completion
  const finished = app.events().filter((event) => event.event.kind === 'run.finished')
  assert.equal(finished.length, 1)
  assert.equal(app.state().runs[0]?.status, 'completed')
  assert.equal(
    app.state().messages.find((message) => message.role === 'assistant')?.text,
    'first result',
  )
  app.shutdown()
})
