import assert from 'node:assert/strict'
import test from 'node:test'
import {
  interactionRequestDigest,
  validateInteractionResponse,
} from '@tangle-network/agent-interface'
import {
  assertCloudInteractionEvidence,
  cloudQuestionResponse,
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
    runs: [{ id: 'run-1', status: 'waiting', interactions: [{ status: 'pending', request }] }],
  }
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
    reconnectedState: structuredClone(pending),
    terminalState: {
      runs: [{ id: 'run-1', status: 'completed' }],
      messages: [{ runId: 'run-1', role: 'assistant', text: 'AFTER_ANSWER' }],
    },
    runId: 'run-1',
    interactionId: request.id,
    operationId: 'operation-response-1',
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

test('cloud answer uses the full retained request, not the projected event summary', () => {
  const evidence = proof()
  const projected = evidence.firstResponses[0].event.payload.interaction
  assert.equal(
    validateInteractionResponse(projected, cloudQuestionResponse(request, 'AFTER_ANSWER')).ok,
    false,
  )
  assert.deepEqual(
    retainedCloudQuestionRequest(evidence.reconnectedState, 'run-1', request.id),
    request,
  )
  assert.throws(
    () =>
      retainedCloudQuestionRequest(
        { runs: [{ id: 'run-1', interactions: [{ status: 'pending', request: projected }] }] },
        'run-1',
        request.id,
      ),
    /belongs to another run/u,
  )
})

test('cloud proof requires one pending question before and after reconnect', () => {
  const valid = proof()
  assert.equal(assertCloudInteractionEvidence(valid).terminalStatus, 'completed')
  assert.throws(
    () => assertCloudInteractionEvidence({ ...valid, firstResponses: [] }),
    /one retained interaction/u,
  )
  assert.throws(
    () =>
      assertCloudInteractionEvidence({
        ...valid,
        reconnectedState: { runs: [{ id: 'run-1', interactions: [] }] },
      }),
    /pending/u,
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
