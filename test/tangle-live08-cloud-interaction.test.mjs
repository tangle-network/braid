import assert from 'node:assert/strict'
import test from 'node:test'
import { interactionRequestDigest } from '@tangle-network/agent-interface'
import {
  assertCloudInteractionEvidence,
  cloudInteractionFailureSnapshot,
  cloudProviderEventTypeProjection,
  cloudProviderEventTypeSnapshot,
  cloudProviderFailureProjection,
  cloudQuestionResponse,
  cloudRecoveryDetailCategory,
  refreshBraidFailureState,
  retainedCloudQuestionRequest,
} from '../scripts/live-required/tangle-sandbox-braid-cloud-interaction.mjs'

const requestMaterial = {
  id: 'question-1',
  kind: 'question',
  title: 'Choose an action',
  answerSpec: {
    fields: [
      {
        type: 'select',
        name: 'q0',
        label: 'Action',
        required: true,
        options: [{ value: 'continue', label: 'Continue' }],
      },
    ],
  },
  binding: {
    runId: 'run-1',
    provider: 'opencode',
    environmentId: 'environment-1',
    sessionId: 'session-1',
    executionId: 'execution-1',
    interactionId: 'question-1',
  },
}
const request = { ...requestMaterial, requestDigest: interactionRequestDigest(requestMaterial) }

function proof() {
  const event = (sequence, kind, value) => ({
    type: 'event',
    sequence,
    event: { kind, payload: { runId: 'run-1', ...(value === undefined ? {} : { value }) } },
  })
  const pending = {
    revision: 21,
    sequence: 22,
    runs: [{ id: 'run-1', status: 'waiting' }],
    interactions: [{ runId: 'run-1', interactionId: request.id, kind: 'question' }],
  }
  const reconnected = structuredClone(pending)
  reconnected.runs[0].status = 'reconnecting'
  return {
    firstResponses: [
      {
        type: 'event',
        sequence: 12,
        event: {
          kind: 'run.interaction',
          payload: {
            runId: 'run-1',
            interaction: {
              id: request.id,
              kind: request.kind,
              title: request.title,
              answerSpec: request.answerSpec,
            },
          },
        },
      },
    ],
    freshResponses: [
      event(23, 'run.interaction.response.requested', {
        interactionId: request.id,
        operationId: 'operation-response-1',
        outcome: 'accepted',
      }),
      event(24, 'run.interaction.responded', {
        interactionId: request.id,
        operationId: 'operation-response-1',
        outcome: 'accepted',
      }),
    ],
    initialState: pending,
    reconnectedState: reconnected,
    terminalState: {
      runs: [{ id: 'run-1', status: 'completed' }],
      messages: [{ runId: 'run-1', role: 'assistant', text: 'AFTER_ANSWER' }],
    },
    runId: 'run-1',
    interactionId: request.id,
    operationId: 'operation-response-1',
    reconnectAck: { type: 'ack', operationId: 'operation-reconnect-1', revision: 20 },
    responseAck: { type: 'ack', operationId: 'operation-response-1', outcome: 'accepted' },
    marker: 'AFTER_ANSWER',
  }
}

test('cloud question answer uses the declared shape', () => {
  assert.deepEqual(cloudQuestionResponse(request, 'AFTER_ANSWER'), {
    id: request.id,
    outcome: 'accepted',
    data: { q0: ['continue'] },
  })
  assert.throws(
    () => cloudQuestionResponse({ ...request, kind: 'permission' }, 'AFTER_ANSWER'),
    /real cloud question/u,
  )
})

test('cloud answer uses public event fields after the pending view confirms identity', () => {
  const evidence = proof()
  const projected = evidence.firstResponses[0].event.payload.interaction
  assert.deepEqual(cloudQuestionResponse(projected, 'AFTER_ANSWER'), {
    id: request.id,
    outcome: 'accepted',
    data: { q0: ['continue'] },
  })
  assert.deepEqual(
    retainedCloudQuestionRequest(evidence.reconnectedState, 'run-1', request.id, projected),
    projected,
  )
  assert.throws(
    () =>
      retainedCloudQuestionRequest(
        { interactions: [{ runId: 'other-run', interactionId: request.id, kind: 'question' }] },
        'run-1',
        request.id,
        projected,
      ),
    /no longer pending/u,
  )
})

test('cloud proof requires one pending question before and after reconnect', () => {
  const valid = proof()
  assert.equal(assertCloudInteractionEvidence(valid).terminalStatus, 'completed')
  assert.equal(assertCloudInteractionEvidence(valid).reconnect.runStatus, 'reconnecting')
  assert.throws(
    () => assertCloudInteractionEvidence({ ...valid, firstResponses: [] }),
    /one retained interaction/u,
  )
  assert.throws(
    () =>
      assertCloudInteractionEvidence({
        ...valid,
        reconnectedState: { runs: [{ id: 'run-1' }], interactions: [] },
      }),
    /pending/u,
  )
  assert.throws(
    () =>
      assertCloudInteractionEvidence({
        ...valid,
        reconnectedState: valid.initialState,
      }),
    /reconnecting/u,
  )
  assert.throws(
    () =>
      assertCloudInteractionEvidence({
        ...valid,
        reconnectedState: { ...valid.reconnectedState, sequence: 23 },
      }),
    /preceded the observed reconnecting state/u,
  )
})

test('cloud proof rejects duplicate or unacknowledged response and missing continuation', () => {
  const valid = proof()
  assert.throws(
    () =>
      assertCloudInteractionEvidence({
        ...valid,
        freshResponses: [...valid.freshResponses, valid.freshResponses[1]],
      }),
    /one response acknowledgement/u,
  )
  assert.throws(
    () =>
      assertCloudInteractionEvidence({
        ...valid,
        responseAck: { ...valid.responseAck, outcome: 'unknown' },
      }),
    /not accepted/u,
  )
  assert.throws(
    () =>
      assertCloudInteractionEvidence({
        ...valid,
        terminalState: { runs: [{ id: 'run-1', status: 'waiting' }] },
      }),
    /did not continue/u,
  )
})

test('failed cloud question retains bounded state and provider status without prompt or credential text', () => {
  const secret = 'test-secret-must-not-appear'
  const responses = [
    {
      type: 'state',
      revision: 17,
      sequence: 18,
      state: {
        runs: [
          {
            id: 'run-1',
            status: 'failed',
            complete: true,
            error: secret,
          },
        ],
        interactions: [
          { runId: 'run-1', interactionId: request.id, kind: 'question', prompt: secret },
        ],
      },
    },
    ...Array.from({ length: 30 }, (_, index) => ({
      type: 'event',
      sequence: index + 1,
      event: {
        kind: index === 29 ? 'run.finished' : 'run.part.updated',
        payload: { runId: 'run-1', text: secret, value: { text: secret } },
      },
    })),
  ]
  const braid = cloudInteractionFailureSnapshot(responses, 'run-1', true)
  assert.equal(braid.questionRequested, true)
  assert.equal(braid.responseCount, 31)
  assert.equal(braid.runEventCount, 30)
  assert.equal(braid.lastEvents.length, 24)
  assert.equal(braid.eventCounts['run.finished'], 1)
  assert.equal(braid.latestState.status, 'failed')
  assert.deepEqual(braid.latestState.interactions, [{ kind: 'question', status: 'pending' }])

  const provider = cloudProviderFailureProjection(
    {
      status: 'failed',
      failureReason: { code: 'runner_failed', message: `provider rejected ${secret}` },
      raw: { token: secret },
    },
    Array.from({ length: 10 }, (_, index) => ({
      executionId: `execution-${index}`,
      status: 'failed',
      eventCount: index + 1,
      output: secret,
    })),
  )
  assert.equal(provider.sessionStatus, 'failed')
  assert.equal(provider.failureCode, 'runner_failed')
  assert.equal(provider.executionCount, 10)
  assert.equal(provider.executions.length, 8)
  assert.equal(Object.hasOwn(provider, 'failureMessage'), false)
  assert.doesNotMatch(JSON.stringify({ braid, provider }), /test-secret-must-not-appear/u)
})

test('cloud failure classifies recovery and provider event types without retaining unknown text', () => {
  const secret = 'test-secret-must-not-appear'
  const recovery = cloudInteractionFailureSnapshot(
    [
      {
        type: 'event',
        event: {
          kind: 'history.missing',
          payload: { range: { runId: 'run-1', fromSequence: 3, toSequence: 4 } },
        },
      },
      {
        type: 'event',
        sequence: 22,
        event: {
          kind: 'run.unknown',
          payload: { runId: 'run-1', detail: 'RUNTIME_RECONCILIATION_ERROR' },
        },
      },
      {
        type: 'state',
        state: {
          lastError: secret,
          runs: [
            { id: 'run-1', status: 'unknown', lastProviderSequence: 2, lastCursor: 'cursor-2' },
          ],
        },
      },
    ],
    'run-1',
    true,
  )
  assert.equal(recovery.historyGapCount, 1)
  assert.equal(recovery.unknownDetailCategory, 'reconnect-error')
  assert.equal(recovery.latestState.lastProviderSequence, 2)
  assert.equal(recovery.latestState.cursorPresent, true)
  assert.equal(cloudRecoveryDetailCategory(secret), 'unclassified')

  const eventTypes = cloudProviderEventTypeProjection([
    { type: 'status', data: { type: 'interaction', detail: secret } },
    { type: secret, data: { event: { type: secret } } },
  ])
  assert.deepEqual(eventTypes.types, { status: 1, other: 1 })
  assert.deepEqual(eventTypes.nestedTypes, { interaction: 1, other: 1 })
  assert.doesNotMatch(JSON.stringify({ recovery, eventTypes }), /test-secret-must-not-appear/u)
})

test('provider event diagnostic replays one exact execution through the public session API', async () => {
  let options
  const session = {
    async *events(input) {
      options = input
      yield { type: 'status', data: { type: 'interaction', prompt: 'not retained' } }
      yield { type: 'done', data: {} }
    },
  }
  const snapshot = await cloudProviderEventTypeSnapshot(session, 'run-1')
  assert.equal(options.since, '0')
  assert.equal(options.executionId, 'run-1')
  assert.equal(snapshot.observed, true)
  assert.equal(snapshot.eventCount, 2)
  assert.deepEqual(snapshot.types, { status: 1, done: 1 })
  assert.deepEqual(snapshot.nestedTypes, { interaction: 1 })
  assert.doesNotMatch(JSON.stringify(snapshot), /not retained/u)
})

test('failure diagnostic refreshes the live Braid run state with a bounded read', async () => {
  let requested
  const session = {
    closed: false,
    send(request) {
      requested = request
    },
    async waitFor(label, predicate, timeoutMs) {
      assert.equal(label, 'cloud interaction failure state')
      assert.equal(timeoutMs, 5_000)
      assert.equal(predicate({ type: 'state', requestId: requested.requestId }), true)
      return { type: 'state', requestId: requested.requestId }
    },
  }
  assert.deepEqual(await refreshBraidFailureState(session), { attempted: true, received: true })
  assert.equal(requested.command, 'get_state')
  assert.deepEqual(requested.params, { projection: 'full' })
  assert.deepEqual(await refreshBraidFailureState({ closed: true }), {
    attempted: false,
    received: false,
  })
  assert.deepEqual(
    await refreshBraidFailureState({
      closed: false,
      send() {
        throw Object.assign(new Error('provider secret'), { code: 'RPC_INPUT_CLOSED' })
      },
    }),
    { attempted: true, received: false, reasonCode: 'RPC_INPUT_CLOSED' },
  )
})
