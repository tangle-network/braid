import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBraidViewModel } from '../src/adapters/tui/ui-view-model.js'
import { STARTER_PROFILE } from '../src/app/composition.js'
import type { BraidEvent, BraidEventEnvelope } from '../src/domain/events.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'

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
  const view = buildBraidViewModel(state)
  assert.equal(state.sequence, deltaCount + 4)
  assert.equal(state.messages[1]?.text.length, delta.length * deltaCount)
  assert.equal(state.messages[1]?.text, response)
  assert.equal(view.messages.length, 2)
  assert.equal(view.messages[1]?.text.length, response.length)
  assert.equal(view.messages[1]?.text, response)
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
