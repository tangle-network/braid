import assert from 'node:assert/strict'
import test from 'node:test'
import { STARTER_PROFILE } from '../src/app/composition.js'
import { buildAppView } from '../src/app/view-model.js'
import type { BraidEvent, BraidEventEnvelope } from '../src/domain/events.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { parseInteractionRequest } from '../src/domain/interaction.js'
import { MAX_TEXT_BYTES } from '../src/domain/bounds.js'
import { interactionKey } from '../src/domain/interaction-state.js'
import { interactionRequestDigest } from '../src/domain/interaction.js'
import { canonicalDigest } from '../src/domain/canonical.js'

function envelopes(events: readonly BraidEvent[]): BraidEventEnvelope[] {
  return events.map((event, index) => ({
    sequence: index + 1,
    revision: index + 1,
    occurredAt: '2026-08-01T00:00:00.000Z',
    event,
  }))
}

test('10,000 streamed events replay without duplication or event loss', () => {
  const deltaCount = 10_000
  const delta = '0123456789abcdef0123456789abcdef'
  const response = delta.repeat(deltaCount)
  const events: BraidEvent[] = [
    { kind: 'workspace.opened', workspace: '/workspace' },
    { kind: 'draft.changed', text: 'large reply' },
    {
      kind: 'run.requested',
      operationId: 'op-large',
      runId: 'run-large',
      turnId: 'turn-large',
      userMessageId: 'message-user',
      assistantMessageId: 'message-assistant',
      text: 'large reply',
    },
    ...Array.from(
      { length: deltaCount },
      (): BraidEvent => ({ kind: 'run.text.delta', runId: 'run-large', text: delta }),
    ),
    {
      kind: 'run.finished',
      runId: 'run-large',
      status: 'completed',
      finalText: response,
      usage: { input: 2, output: deltaCount },
    },
  ]

  const state = replayEvents(initialState(STARTER_PROFILE), envelopes(events))
  const view = buildAppView(state)
  assert.equal(state.sequence, deltaCount + 4)
  assert.equal(state.messages[1]?.text.length, MAX_TEXT_BYTES)
  assert.equal(state.messages[1]?.text, response.slice(0, MAX_TEXT_BYTES))
  assert.equal(view.messages.length, 2)
  assert.equal(view.messages[1]?.text.length, 200_002)
  assert.equal(view.messages[1]?.text.startsWith('…\n'), true)
  assert.equal(
    view.messages[1]?.text.endsWith(response.slice(0, MAX_TEXT_BYTES).slice(-200_000)),
    true,
  )
})

test('replay rejects a sequence gap', () => {
  const state = initialState(STARTER_PROFILE)
  assert.throws(
    () =>
      replayEvents(state, [
        {
          sequence: 2,
          revision: 1,
          occurredAt: '2026-08-01T00:00:00.000Z',
          event: { kind: 'workspace.opened', workspace: '/workspace' },
        },
      ]),
    /does not follow/u,
  )
})

test('replay rejects secret interaction data in a persisted response event', () => {
  const parsed = parseInteractionRequest({
    id: 'secret-replay',
    kind: 'question',
    title: 'Credential',
    answerSpec: { fields: [{ type: 'secret', name: 'token', label: 'Token' }] },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) assert.fail('secret request should parse')
  const requestEvent: BraidEvent = {
    kind: 'interaction.requested',
    interaction: {
      key: interactionKey('run-secret-replay', 'secret-replay'),
      runId: 'run-secret-replay',
      interactionId: 'secret-replay',
      request: parsed.request,
      status: 'pending',
      arrivalSequence: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  }
  const state = replayEvents(initialState(STARTER_PROFILE), envelopes([requestEvent]))
  const malicious: BraidEvent = {
    kind: 'interaction.response.requested',
    key: interactionKey('run-secret-replay', 'secret-replay'),
    runId: 'run-secret-replay',
    interactionId: 'secret-replay',
    operationId: 'op-secret-replay',
    outcome: 'accepted',
    publicData: { token: 'CANARY-SECRET' },
    containsSecret: true,
  }
  assert.throws(
    () =>
      replayEvents(state, [
        {
          sequence: state.sequence + 1,
          revision: state.revision + 1,
          occurredAt: '2026-08-01T00:00:01.000Z',
          event: malicious,
        },
      ]),
    /Secret interaction responses cannot contain public data/u,
  )
})

test('replay rejects a resolution whose operation identity differs from its intent', () => {
  const parsed = parseInteractionRequest({
    id: 'resolution-identity',
    kind: 'question',
    title: 'Value',
    answerSpec: { fields: [{ type: 'text', name: 'value', label: 'Value' }] },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) assert.fail('request should parse')
  const key = interactionKey('run-resolution', 'resolution-identity')
  const requestEvent: BraidEvent = {
    kind: 'interaction.requested',
    interaction: {
      key,
      runId: 'run-resolution',
      interactionId: 'resolution-identity',
      request: parsed.request,
      requestDigest: interactionRequestDigest(parsed.request),
      status: 'pending',
      arrivalSequence: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  }
  const responseDigest = canonicalDigest({ outcome: 'accepted', data: { value: 'answer' } })
  const responseEvent: BraidEvent = {
    kind: 'interaction.response.requested',
    key,
    runId: 'run-resolution',
    interactionId: 'resolution-identity',
    operationId: 'operation-right',
    outcome: 'accepted',
    requestDigest: interactionRequestDigest(parsed.request),
    responseDigest,
    containsSecret: false,
  }
  const state = replayEvents(
    initialState(STARTER_PROFILE),
    envelopes([requestEvent, responseEvent]),
  )
  assert.throws(
    () =>
      replayEvents(state, [
        {
          sequence: state.sequence + 1,
          revision: state.revision + 1,
          occurredAt: '2026-08-01T00:00:01.000Z',
          event: {
            kind: 'interaction.resolved',
            key,
            status: 'resolved',
            resolution: {
              outcome: 'accepted',
              operationId: 'operation-wrong',
              responseDigest,
              containsSecret: false,
              resolvedAt: '2026-08-01T00:00:01.000Z',
            },
          },
        },
      ]),
    /operation does not match/u,
  )
})
