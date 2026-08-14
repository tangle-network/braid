import assert from 'node:assert/strict'
import test from 'node:test'
import { STARTER_PROFILE } from '../src/app/composition.js'
import {
  createInteractionRequest,
  interactionRequestMaterial,
  interactionResponseBinding,
} from '../src/app/interaction-request.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import {
  createEventId,
  createInteractionId,
  createMessageId,
  createOperationId,
  createReplayCursor,
  createRuleId,
  createRunId,
  createTurnId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import {
  DuplicateEventConflictError,
  reduceEvent,
  replayEvents,
  SequenceGapError,
} from '../src/domain/reducer.js'
import { MAX_RUN_INTERACTIONS } from '../src/domain/reducer-support.js'
import { initialState } from '../src/domain/state.js'

const at = '2026-08-02T00:00:00.000Z'

function envelope(
  event: BraidEvent,
  sequence: number,
  eventId = createEventId(`event-${sequence}`),
): JournalEventEnvelope {
  return {
    eventId,
    sequence,
    revision: sequence,
    occurredAt: '2026-08-02T00:00:00.000Z',
    event,
  }
}

function verticalSliceEvents(): readonly JournalEventEnvelope[] {
  return [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope({ kind: 'draft.changed', text: 'hello' }, 2),
    envelope(
      {
        kind: 'run.requested',
        operationId: 'op-domain',
        runId: 'run-domain',
        turnId: 'turn-domain',
        userMessageId: 'message-user-domain',
        assistantMessageId: 'message-assistant-domain',
        text: 'hello',
      },
      3,
    ),
    envelope({ kind: 'run.text.delta', runId: 'run-domain', text: 'response' }, 4),
    envelope(
      {
        kind: 'run.finished',
        runId: 'run-domain',
        status: 'completed',
        finalText: 'response',
        usage: { input: 2, output: 1 },
      },
      5,
    ),
  ]
}

test('replay rejects malformed persisted interaction sources and automation rules', () => {
  const runId = createRunId('run-replay-interaction-invariants')
  const interactionId = createInteractionId('interaction-replay-invariants')
  const request = createInteractionRequest({
    id: interactionId,
    kind: 'question',
    title: 'Continue after replay?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    binding: {
      runId,
      provider: 'fixture',
      environmentId: 'environment-replay-interaction',
      sessionId: 'session-replay-interaction',
      executionId: 'execution-replay-interaction',
      interactionId,
    },
  })
  const prefix: readonly JournalEventEnvelope[] = [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope(
      {
        kind: 'run.requested',
        operationId: createOperationId('operation-replay-interaction'),
        runId,
        turnId: createTurnId('turn-replay-interaction'),
        userMessageId: createMessageId('message-replay-interaction-user'),
        assistantMessageId: createMessageId('message-replay-interaction-assistant'),
        text: 'wait for replay',
      },
      2,
    ),
  ]
  const interaction = (providerSequence: number): JournalEventEnvelope =>
    envelope(
      {
        kind: 'run.interaction',
        runId,
        request,
        responseBinding: interactionResponseBinding(request),
        provider: {
          eventId: 'provider-replay-interaction',
          providerSequence,
          occurredAt: '2026-08-02T00:00:00.000Z',
        },
      },
      3,
    )

  assert.throws(
    () => replayEvents(initialState(STARTER_PROFILE), [...prefix, interaction(0)]),
    /run\.interactions\[0\]\.source\.sequence must be a positive safe integer/u,
  )

  for (const field of ['key', 'privateKey', 'secretHandle']) {
    const invalidRule = {
      id: createRuleId(`rule-replay-interaction-invalid-${field}`),
      enabled: true,
      matcher: { interactionKind: 'question' },
      answer: { [field]: 'must-not-persist' },
      responseScope: 'once' as const,
      createdAt: '2026-08-02T00:00:00.000Z',
      uses: 0,
    }
    assert.throws(
      () =>
        replayEvents(initialState(STARTER_PROFILE), [
          ...prefix,
          interaction(1),
          envelope(
            {
              kind: 'run.interaction.response.requested',
              runId,
              interactionId,
              operationId: createOperationId(`operation-replay-interaction-response-${field}`),
              outcome: 'accepted',
              containsSecret: false,
              automationRule: invalidRule,
            },
            4,
          ),
        ]),
      new RegExp(`rule\\.answer\\.${field} is secret-designated and cannot be retained`, 'u'),
    )
  }
})

test('interaction transitions reject reorder, unknown, conflicting, terminal, and evicted events', () => {
  const runId = createRunId('run-interaction-transition-contract')
  const interactionId = createInteractionId('interaction-transition-contract')
  const request = createInteractionRequest({
    id: interactionId,
    kind: 'question',
    title: 'Continue?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    binding: {
      runId,
      provider: 'fixture',
      environmentId: 'environment-transition-contract',
      sessionId: 'session-transition-contract',
      executionId: 'execution-transition-contract',
      interactionId,
    },
  })
  const prefix: readonly JournalEventEnvelope[] = [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope(
      {
        kind: 'run.requested',
        operationId: createOperationId('operation-transition-contract'),
        runId,
        turnId: createTurnId('turn-transition-contract'),
        userMessageId: createMessageId('message-transition-contract-user'),
        assistantMessageId: createMessageId('message-transition-contract-assistant'),
        text: 'wait for an answer',
      },
      2,
    ),
  ]
  const interactionEvent = (
    sequence: number,
    id = interactionId,
    providerSequence = sequence - 2,
    providerEventId = `provider-transition-${sequence}`,
    requestOverride?: typeof request,
  ): JournalEventEnvelope => {
    const eventRequest =
      requestOverride ??
      (id === interactionId
        ? request
        : createInteractionRequest({
            id,
            kind: 'question',
            title: `Question ${id}`,
            answerSpec: {
              fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
            },
            binding: {
              ...request.binding,
              interactionId: id,
            },
          }))
    return envelope(
      {
        kind: 'run.interaction',
        runId,
        request: eventRequest,
        responseBinding: interactionResponseBinding(eventRequest),
        provider: {
          eventId: providerEventId,
          providerSequence,
          occurredAt: at,
        },
      },
      sequence,
      createEventId(`event-transition-${sequence}`),
    )
  }
  const responseRequested = (sequence: number, operation = 'operation-transition-response') =>
    envelope(
      {
        kind: 'run.interaction.response.requested',
        runId,
        interactionId,
        operationId: createOperationId(operation),
        outcome: 'accepted',
        containsSecret: false,
      },
      sequence,
      createEventId(`event-transition-response-requested-${sequence}`),
    )
  const responded = (
    sequence: number,
    operation = 'operation-transition-response',
    outcome: 'accepted' | 'unknown' = 'accepted',
  ) =>
    envelope(
      {
        kind: 'run.interaction.responded',
        runId,
        interactionId,
        operationId: createOperationId(operation),
        outcome,
        containsSecret: false,
      },
      sequence,
      createEventId(`event-transition-responded-${sequence}`),
    )

  const beforeInteraction = replayEvents(initialState(STARTER_PROFILE), prefix)
  assert.throws(() => reduceEvent(beforeInteraction, responded(3)), /Interaction .* is unknown/u)
  assert.throws(
    () => reduceEvent(beforeInteraction, responseRequested(3)),
    /Interaction .* is unknown/u,
  )

  const afterInteraction = reduceEvent(beforeInteraction, interactionEvent(3))
  assert.throws(
    () => reduceEvent(afterInteraction, responded(4)),
    /cannot be resolved from pending/u,
  )
  const conflictingRequest = createInteractionRequest({
    ...interactionRequestMaterial(request),
    title: 'Different request data',
  })
  assert.throws(
    () =>
      reduceEvent(
        afterInteraction,
        interactionEvent(4, interactionId, 1, 'provider-transition-3', conflictingRequest),
      ),
    /was requested with different data/u,
  )
  const duplicateInteraction = reduceEvent(
    afterInteraction,
    interactionEvent(4, interactionId, 1, 'provider-transition-3'),
  )
  assert.equal(duplicateInteraction.runs[0]?.interactions.length, 1)
  const afterResponseRequested = reduceEvent(duplicateInteraction, responseRequested(5))
  const duplicateResponseRequested = reduceEvent(afterResponseRequested, responseRequested(6))
  assert.equal(duplicateResponseRequested.runs[0]?.interactions[0]?.status, 'responding')
  const afterResponded = reduceEvent(duplicateResponseRequested, responded(7))
  const duplicateResponded = reduceEvent(afterResponded, responded(8))
  assert.equal(duplicateResponded.runs[0]?.interactions[0]?.status, 'resolved')
  assert.throws(
    () => reduceEvent(duplicateResponded, responseRequested(9)),
    /cannot transition from resolved to responding/u,
  )
  assert.throws(
    () => reduceEvent(afterResponded, responded(8, 'operation-transition-other-response')),
    /different response result/u,
  )
  assert.throws(
    () =>
      reduceEvent(
        duplicateResponded,
        envelope(
          {
            kind: 'run.interaction.cancelled',
            runId,
            interactionId,
            provider: {
              eventId: 'provider-transition-cancelled',
              providerSequence: 7,
              occurredAt: at,
            },
          },
          9,
          createEventId('event-transition-cancelled'),
        ),
      ),
    /cannot transition from resolved to cancelled/u,
  )

  let evicted = beforeInteraction
  for (let index = 0; index < 257; index += 1) {
    evicted = reduceEvent(
      evicted,
      interactionEvent(index + 3, createInteractionId(`interaction-evicted-${index}`)),
    )
  }
  const evictedRun = evicted.runs[0]
  assert.ok(evictedRun)
  assert.equal(evictedRun.interactions.length, MAX_RUN_INTERACTIONS)
  assert.equal(
    evictedRun.interactions.some(
      (interaction) => interaction.request.id === 'interaction-evicted-0',
    ),
    false,
  )
  assert.equal(evictedRun.pendingInteractionIds?.includes('interaction-evicted-0'), true)
  assert.throws(
    () =>
      reduceEvent(
        evicted,
        envelope(
          {
            kind: 'run.interaction.cancelled',
            runId,
            interactionId: 'interaction-evicted-0',
            provider: {
              eventId: 'provider-transition-evicted-cancelled',
              providerSequence: 258,
              occurredAt: at,
            },
          },
          260,
          createEventId('event-transition-evicted-cancelled'),
        ),
      ),
    /Interaction interaction-evicted-0 is unknown/u,
  )
})

test('incremental reduction and full replay produce the same complete projection', () => {
  const events = verticalSliceEvents()
  const initial = initialState(STARTER_PROFILE)
  const incremental = events.reduce(reduceEvent, initial)
  const replayed = replayEvents(initial, events)

  assert.deepEqual(replayed, incremental)
  assert.equal(incremental.projectionChecksum, replayed.projectionChecksum)
  assert.equal(incremental.workspaces.length, 1)
  assert.equal(incremental.conversations.length, 1)
  assert.equal(incremental.branches.length, 1)
  assert.equal(incremental.turns.length, 1)
  assert.equal(incremental.messages.length, 2)
  assert.equal(incremental.messageParts.length, 2)
  assert.equal(incremental.runs[0]?.status, 'completed')
  assert.equal(incremental.runs[0]?.complete, true)
  assert.equal(incremental.operations[0]?.status, 'terminal')
  assert.equal(incremental.health.status, 'healthy')
})

test('retained admission survives the pre-dispatch crash window and binds one exact run', () => {
  const environmentAdmission = {
    phase: 'environment' as const,
    provider: 'cli-bridge',
    environmentId: 'environment-retained-admission',
    idempotencyKey: 'environment-retained-admission',
    turnId: 'turn-retained-admission',
    sessionId: 'session-retained-admission',
    executionId: 'execution-retained-admission',
  }
  const dispatchedAdmission = {
    phase: 'dispatched' as const,
    idempotencyKey: environmentAdmission.idempotencyKey,
    turnId: environmentAdmission.turnId,
    controlRef: {
      provider: environmentAdmission.provider,
      environmentId: environmentAdmission.environmentId,
      sessionId: environmentAdmission.sessionId,
      executionId: environmentAdmission.executionId,
      runId: 'provider-run-retained-admission',
      requestDigest: `sha256:${'d'.repeat(64)}` as const,
    },
  }
  const initialEvents = [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope(
      {
        kind: 'run.requested',
        operationId: 'op-retained-admission',
        runId: 'run-retained-admission',
        turnId: environmentAdmission.turnId,
        userMessageId: 'message-user-retained-admission',
        assistantMessageId: 'message-assistant-retained-admission',
        text: 'retain this run',
      },
      2,
    ),
    envelope(
      {
        kind: 'run.retained.admitted',
        runId: 'run-retained-admission',
        admission: environmentAdmission,
      },
      3,
    ),
  ] as const

  const interrupted = replayEvents(initialState(STARTER_PROFILE), initialEvents)
  assert.deepEqual(interrupted.runs[0]?.retainedAdmission, environmentAdmission)
  assert.equal(interrupted.runs[0]?.controlRef, undefined)

  const dispatched = reduceEvent(
    interrupted,
    envelope(
      {
        kind: 'run.retained.admitted',
        runId: 'run-retained-admission',
        admission: dispatchedAdmission,
      },
      4,
    ),
  )
  assert.deepEqual(dispatched.runs[0]?.retainedAdmission, dispatchedAdmission)
  assert.deepEqual(dispatched.runs[0]?.controlRef, dispatchedAdmission.controlRef)
  assert.equal(dispatched.runs[0]?.providerSessionId, environmentAdmission.sessionId)

  const harnessSession = reduceEvent(
    dispatched,
    envelope(
      {
        kind: 'run.provider.event',
        runId: 'run-retained-admission',
        envelope: {
          runId: 'run-retained-admission',
          eventId: 'provider-event-native-session',
          sequence: 5,
          cursor: 'provider-cursor-5',
          receivedAt: '2026-08-02T00:00:05.000Z',
          event: { type: 'session.updated', sessionId: 'ses_native_harness' },
        },
        provider: {
          eventId: 'provider-event-native-session',
          providerSequence: 5,
          cursor: 'provider-cursor-5',
          receivedAt: '2026-08-02T00:00:05.000Z',
        },
      },
      5,
    ),
  )
  assert.equal(harnessSession.runs[0]?.providerSessionId, environmentAdmission.sessionId)
  assert.equal(harnessSession.runs[0]?.harnessSessionId, 'ses_native_harness')
  assert.deepEqual(harnessSession.runs[0]?.controlRef, dispatchedAdmission.controlRef)
  assert.equal(harnessSession.runs[0]?.lastCursor, 'provider-cursor-5')

  const retriedEnvironment = reduceEvent(
    harnessSession,
    envelope(
      {
        kind: 'run.retained.admitted',
        runId: 'run-retained-admission',
        admission: environmentAdmission,
      },
      6,
    ),
  )
  assert.deepEqual(retriedEnvironment.runs[0]?.retainedAdmission, dispatchedAdmission)

  assert.throws(
    () =>
      reduceEvent(
        retriedEnvironment,
        envelope(
          {
            kind: 'run.retained.admitted',
            runId: 'run-retained-admission',
            admission: {
              ...environmentAdmission,
              environmentId: 'environment-retained-conflict',
            },
          },
          7,
        ),
      ),
    /conflicts with its environment admission/u,
  )
})

test('a cancellation request that loses the terminal race preserves the proven result', () => {
  const completed = replayEvents(initialState(STARTER_PROFILE), verticalSliceEvents())
  const operationId = 'op-cancel-after-terminal'
  const requested = reduceEvent(
    completed,
    envelope(
      {
        kind: 'run.control.requested',
        runId: 'run-domain',
        operationId,
        control: 'cancel',
        digest: 'a'.repeat(64),
        reason: 'cancel raced with completion',
      },
      6,
    ),
  )
  const legacyRequested = reduceEvent(
    requested,
    envelope(
      {
        kind: 'run.cancel.requested',
        runId: 'run-domain',
        operationId,
        reason: 'cancel raced with completion',
      },
      7,
    ),
  )

  assert.equal(requested.runs[0]?.status, 'completed')
  assert.equal(requested.runs[0]?.complete, true)
  assert.equal(legacyRequested.runs[0]?.status, 'completed')
  assert.equal(legacyRequested.runs[0]?.complete, true)
})

test('a terminal unknown run does not re-enter cancelling when cancellation is requested', () => {
  const unknown = replayEvents(initialState(STARTER_PROFILE), [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope(
      {
        kind: 'run.requested',
        operationId: 'op-unknown-run',
        runId: 'run-unknown-run',
        turnId: 'turn-unknown-run',
        userMessageId: 'message-user-unknown-run',
        assistantMessageId: 'message-assistant-unknown-run',
        text: 'unknown run',
      },
      2,
    ),
    envelope(
      { kind: 'run.unknown', runId: 'run-unknown-run', detail: 'provider stopped responding' },
      3,
    ),
  ])

  const requested = reduceEvent(
    unknown,
    envelope(
      {
        kind: 'run.control.requested',
        runId: 'run-unknown-run',
        operationId: 'op-unknown-cancel',
        control: 'cancel',
        digest: 'a'.repeat(64),
      },
      4,
    ),
  )

  assert.equal(requested.runs[0]?.status, 'unknown')
  assert.equal(requested.runs[0]?.complete, false)
})

test('cancellation correction requires its durable cancel operation and updates active output', () => {
  const withoutCancelOperation = replayEvents(initialState(STARTER_PROFILE), [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope(
      {
        kind: 'run.requested',
        operationId: 'op-failed-without-cancel',
        runId: 'run-failed-without-cancel',
        turnId: 'turn-failed-without-cancel',
        userMessageId: 'message-user-failed-without-cancel',
        assistantMessageId: 'message-assistant-failed-without-cancel',
        text: 'independent failure',
      },
      2,
    ),
    envelope(
      {
        kind: 'run.status.changed',
        runId: 'run-failed-without-cancel',
        status: 'failed',
        detail: 'RUNTIME_FINAL_ERROR',
      },
      3,
    ),
  ])
  assert.throws(
    () =>
      reduceEvent(
        withoutCancelOperation,
        envelope(
          {
            kind: 'run.reconciled',
            runId: 'run-failed-without-cancel',
            operationId: 'op-not-a-cancel',
            status: 'cancelled',
            from: 'failed',
            to: 'cancelled',
            correction: 'cancellation-confirmed',
            evidence: 'b'.repeat(64),
          },
          4,
        ),
      ),
    /invalid cancellation reconciliation evidence/u,
  )

  const pendingCancellation = replayEvents(initialState(STARTER_PROFILE), [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope(
      {
        kind: 'run.requested',
        operationId: 'op-failed-with-cancel',
        runId: 'run-failed-with-cancel',
        turnId: 'turn-failed-with-cancel',
        userMessageId: 'message-user-failed-with-cancel',
        assistantMessageId: 'message-assistant-failed-with-cancel',
        text: 'cancellation race',
      },
      2,
    ),
    envelope(
      {
        kind: 'run.cancel.requested',
        operationId: 'op-cancel-confirmed',
        runId: 'run-failed-with-cancel',
        reason: 'cancel the race',
      },
      3,
    ),
    envelope(
      {
        kind: 'run.reasoning.delta',
        runId: 'run-failed-with-cancel',
        partId: 'part-failed-with-cancel',
        text: 'tearing down',
        provider: {
          eventId: 'provider-failed-with-cancel',
          providerSequence: 1,
          occurredAt: '2026-08-02T00:00:00.000Z',
        },
      },
      4,
    ),
    envelope(
      {
        kind: 'run.status.changed',
        runId: 'run-failed-with-cancel',
        status: 'failed',
        detail: 'RUNTIME_FINAL_ERROR',
      },
      5,
    ),
  ])

  const corrected = reduceEvent(
    pendingCancellation,
    envelope(
      {
        kind: 'run.reconciled',
        runId: 'run-failed-with-cancel',
        operationId: 'op-cancel-confirmed',
        status: 'cancelled',
        from: 'failed',
        to: 'cancelled',
        correction: 'cancellation-confirmed',
        evidence: 'c'.repeat(64),
      },
      6,
    ),
  )
  const assistant = corrected.messages.find((message) => message.role === 'assistant')
  assert.equal(corrected.runs[0]?.status, 'cancelled')
  assert.equal(corrected.runs[0]?.complete, true)
  assert.equal(assistant?.status, 'cancelled')
  assert.equal(assistant?.complete, true)
  assert.equal(assistant?.parts.find((part) => part.kind === 'reasoning')?.status, 'cancelled')
})

test('terminal outcomes close every running reasoning and tool part precisely', () => {
  const cases = [
    ['completed', 'complete'],
    ['failed', 'failed'],
    ['aborted', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['blocked', 'unknown'],
    ['expired', 'unknown'],
    ['unknown', 'unknown'],
  ] as const

  for (const [terminalStatus, partStatus] of cases) {
    const runId = `run-terminal-${terminalStatus}`
    const provider = (providerSequence: number) => ({
      eventId: `provider-${terminalStatus}-${providerSequence}`,
      providerSequence,
      occurredAt: '2026-08-02T00:00:00.000Z',
    })
    const state = replayEvents(initialState(STARTER_PROFILE), [
      envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
      envelope(
        {
          kind: 'run.requested',
          operationId: `op-${terminalStatus}`,
          runId,
          turnId: `turn-${terminalStatus}`,
          userMessageId: `message-user-${terminalStatus}`,
          assistantMessageId: `message-assistant-${terminalStatus}`,
          text: 'inspect',
        },
        2,
      ),
      envelope(
        {
          kind: 'run.reasoning.delta',
          runId,
          partId: `part-reasoning-${terminalStatus}`,
          text: 'checking',
          provider: provider(1),
        },
        3,
      ),
      envelope(
        {
          kind: 'run.tool.call',
          runId,
          partId: `part-tool-${terminalStatus}`,
          toolName: 'read_file',
          input: { path: 'README.md' },
          provider: provider(2),
        },
        4,
      ),
      envelope(
        {
          kind: 'run.finished',
          runId,
          status: terminalStatus,
          finalText: '',
          usage: { input: 0, output: 0 },
        },
        5,
      ),
    ])
    const assistant = state.messages.find((message) => message.role === 'assistant')
    assert.ok(assistant)
    assert.deepEqual(
      assistant.parts
        .filter((part) => part.kind === 'reasoning' || part.kind === 'tool-call')
        .map((part) => part.status),
      [partStatus, partStatus],
      terminalStatus,
    )
  }
})

test('incremental and full replay checksums agree for 1,000 generated histories', () => {
  for (let index = 0; index < 1_000; index += 1) {
    const suffix = String(index).padStart(4, '0')
    const text = `history-${suffix}`
    const events = [
      envelope(
        { kind: 'workspace.opened', workspace: `/workspace/${suffix}` },
        1,
        createEventId(`event-${suffix}-workspace`),
      ),
      envelope({ kind: 'draft.changed', text }, 2, createEventId(`event-${suffix}-draft`)),
      envelope(
        {
          kind: 'run.requested',
          operationId: `op-${suffix}`,
          runId: `run-${suffix}`,
          turnId: `turn-${suffix}`,
          userMessageId: `message-user-${suffix}`,
          assistantMessageId: `message-assistant-${suffix}`,
          text,
        },
        3,
        createEventId(`event-${suffix}-request`),
      ),
      envelope(
        { kind: 'run.text.delta', runId: `run-${suffix}`, text: 'response' },
        4,
        createEventId(`event-${suffix}-delta`),
      ),
      envelope(
        {
          kind: 'run.finished',
          runId: `run-${suffix}`,
          status: 'completed',
          finalText: 'response',
          usage: { input: index, output: 1 },
        },
        5,
        createEventId(`event-${suffix}-finished`),
      ),
    ]
    const initial = initialState(STARTER_PROFILE)
    const incremental = events.reduce(reduceEvent, initial)
    const replayed = replayEvents(initial, events)
    assert.equal(incremental.projectionChecksum, replayed.projectionChecksum, suffix)
  }
})

test('the reducer acknowledges an identical durable duplicate without a second transition', () => {
  const first = envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1)
  const state = reduceEvent(initialState(STARTER_PROFILE), first)
  const duplicate = reduceEvent(state, first)

  assert.strictEqual(duplicate, state)
  assert.equal(duplicate.revision, 1)
  assert.equal(duplicate.sequence, 1)
  assert.equal(duplicate.workspaces.length, 1)
})

test('the reducer rejects a duplicate event identifier with changed payload', () => {
  const eventId = createEventId('event-conflict')
  const state = reduceEvent(
    initialState(STARTER_PROFILE),
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1, eventId),
  )

  assert.throws(
    () =>
      reduceEvent(state, envelope({ kind: 'workspace.opened', workspace: '/other' }, 1, eventId)),
    (error: unknown) => error instanceof DuplicateEventConflictError,
  )
})

test('the reducer rejects sequence and revision gaps before applying the event', () => {
  const initial = initialState(STARTER_PROFILE)
  assert.throws(
    () => reduceEvent(initial, envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 2)),
    (error: unknown) => error instanceof SequenceGapError,
  )

  const state = reduceEvent(
    initial,
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
  )
  assert.throws(
    () =>
      reduceEvent(state, { ...envelope({ kind: 'draft.changed', text: 'gap' }, 2), revision: 3 }),
    (error: unknown) => error instanceof SequenceGapError,
  )
  assert.equal(state.draft, '')
})

test('the reducer rejects parseable but non-canonical event timestamps', () => {
  assert.throws(
    () =>
      reduceEvent(initialState(STARTER_PROFILE), {
        ...envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
        occurredAt: '1',
      }),
    /canonical ISO date/u,
  )
})

test('batch replay rejects a transient invalid state even if a later event would repair it', () => {
  const workspaceId = createWorkspaceId('workspace-transient-invalid')
  const invalid = {
    id: workspaceId,
    root: '/workspace',
    trusted: false,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '1',
  }
  const valid = { ...invalid, updatedAt: '2026-08-02T00:00:00.000Z' }

  assert.throws(
    () =>
      replayEvents(initialState(STARTER_PROFILE), [
        envelope({ kind: 'workspace.recorded', workspace: invalid }, 1),
        envelope({ kind: 'workspace.recorded', workspace: valid }, 2),
      ]),
    /canonical ISO date/u,
  )
})

test('replay cursors and missing history remain explicit in state', () => {
  const requested = {
    ...verticalSliceEvents()[2],
    cursor: createReplayCursor('cursor-after-request'),
  } as JournalEventEnvelope
  const state = replayEvents(initialState(STARTER_PROFILE), [
    verticalSliceEvents()[0] as JournalEventEnvelope,
    verticalSliceEvents()[1] as JournalEventEnvelope,
    requested,
    envelope(
      {
        kind: 'history.missing',
        range: { runId: 'run-domain', fromSequence: 4, toSequence: 5, reason: 'provider-missing' },
      },
      4,
    ),
  ])

  assert.equal(state.replayCursors[0]?.cursor, 'cursor-after-request')
  assert.equal(state.missingHistory.length, 1)
  assert.equal(state.health.status, 'incomplete')
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[1]?.complete, false)
})

test('legacy event payloads still reject cross-domain identifiers at the reducer boundary', () => {
  assert.throws(
    () =>
      reduceEvent(
        initialState(STARTER_PROFILE),
        envelope(
          {
            kind: 'run.requested',
            operationId: 'op-invalid',
            runId: 'branch-wrong-domain',
            turnId: 'turn-invalid',
            userMessageId: 'message-user-invalid',
            assistantMessageId: 'message-assistant-invalid',
            text: 'invalid',
          },
          1,
        ),
      ),
    /Invalid run identifier/u,
  )
})

test('branch updates require one acknowledged run-override operation for the exact branch', () => {
  const opened = reduceEvent(
    initialState(STARTER_PROFILE),
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
  )
  const branch = opened.branches[0]
  assert(branch)
  const updated = {
    ...branch,
    overrides: { runner: 'codex' as const },
    updatedAt: '2026-08-02T00:00:00.001Z',
  }
  const operation = {
    id: 'op-domain-run-override',
    kind: 'run-override' as const,
    requestDigest: canonicalDigest({ runner: 'codex' }),
    status: 'acknowledged' as const,
    target: { kind: 'branch' as const, id: branch.id },
    createdAt: '2026-08-02T00:00:00.001Z',
    updatedAt: '2026-08-02T00:00:00.001Z',
    acknowledgedAt: '2026-08-02T00:00:00.001Z',
  }

  const accepted = reduceEvent(
    opened,
    envelope({ kind: 'branch.updated', branch: updated, operation }, 2),
  )
  assert.equal(accepted.branches[0]?.overrides.runner, 'codex')
  assert.equal(accepted.operations[0]?.kind, 'run-override')

  assert.throws(
    () =>
      reduceEvent(
        opened,
        envelope(
          {
            kind: 'branch.updated',
            branch: updated,
            operation: {
              ...operation,
              target: { kind: 'branch', id: 'branch-other' },
            },
          },
          2,
        ),
      ),
    /does not acknowledge/u,
  )
})

test('branch updates reject unsupported override values during replay', () => {
  const opened = reduceEvent(
    initialState(STARTER_PROFILE),
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
  )
  const branch = opened.branches[0]
  assert(branch)
  assert.throws(
    () =>
      reduceEvent(
        opened,
        envelope(
          {
            kind: 'branch.updated',
            branch: {
              ...branch,
              overrides: { runner: 'not-a-runner' },
              updatedAt: '2026-08-02T00:00:00.001Z',
            } as unknown as typeof branch,
            operation: {
              id: 'op-domain-invalid-run-override',
              kind: 'run-override',
              requestDigest: canonicalDigest({ runner: 'not-a-runner' }),
              status: 'acknowledged',
              target: { kind: 'branch', id: branch.id },
              createdAt: '2026-08-02T00:00:00.001Z',
              updatedAt: '2026-08-02T00:00:00.001Z',
              acknowledgedAt: '2026-08-02T00:00:00.001Z',
            },
          },
          2,
        ),
      ),
    /branch\.overrides\.runner is not supported/u,
  )
})
