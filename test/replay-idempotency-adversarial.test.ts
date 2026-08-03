import assert from 'node:assert/strict'
import test from 'node:test'
import { STARTER_PROFILE } from '../src/app/composition.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import { createEventId, createReplayCursor } from '../src/domain/ids.js'
import { reduceEvent, replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'

function envelope(
  event: BraidEvent,
  sequence: number,
  extra: Partial<JournalEventEnvelope> = {},
): JournalEventEnvelope {
  return {
    eventId: createEventId(`event-${sequence}`),
    sequence,
    revision: sequence,
    occurredAt: '2026-08-02T00:00:00.000Z',
    event,
    ...extra,
  }
}

function history(): readonly JournalEventEnvelope[] {
  return [
    envelope({ kind: 'workspace.opened', workspace: '/workspace' }, 1),
    envelope({ kind: 'draft.changed', text: 'hello' }, 2),
    envelope(
      {
        kind: 'run.requested',
        operationId: 'op-replay',
        runId: 'run-replay',
        turnId: 'turn-replay',
        userMessageId: 'message-user',
        assistantMessageId: 'message-assistant',
        text: 'hello',
      },
      3,
    ),
    envelope({ kind: 'run.text.delta', runId: 'run-replay', text: 'chunk' }, 4, {
      cursor: createReplayCursor('cursor-after-delta'),
    }),
    envelope(
      {
        kind: 'run.finished',
        runId: 'run-replay',
        status: 'completed',
        finalText: 'chunk',
        usage: { input: 1, output: 1 },
      },
      5,
    ),
  ]
}

test('an incremental replay cursor on a streamed delta matches batch replay exactly', () => {
  const events = history()
  const incremental = events.reduce(reduceEvent, initialState(STARTER_PROFILE))
  const batched = replayEvents(initialState(STARTER_PROFILE), events)

  assert.equal(incremental.replayCursors.length, 1)
  assert.equal(incremental.replayCursors[0]?.cursor, 'cursor-after-delta')
  assert.equal(incremental.replayCursors[0]?.committedSequence, 4)
  assert.equal(incremental.runs[0]?.replayCursor, 'cursor-after-delta')
  assert.equal(incremental.projectionChecksum, batched.projectionChecksum)
  assert.deepEqual(incremental.replayCursors, batched.replayCursors)
  assert.equal(incremental.runs[0]?.replayCursor, batched.runs[0]?.replayCursor)
})

test('replaying an already-applied history a second time changes nothing', () => {
  const events = history()
  const once = replayEvents(initialState(STARTER_PROFILE), events)
  const twice = replayEvents(once, events)

  assert.equal(twice.revision, once.revision)
  assert.equal(twice.sequence, once.sequence)
  assert.equal(twice.projectionChecksum, once.projectionChecksum)
  assert.equal(twice.appliedEvents.length, once.appliedEvents.length)
  assert.equal(twice.runs.length, 1)
})

test('replay skips an envelope already present in the initial applied set without re-applying', () => {
  const events = history()
  const seeded = replayEvents(initialState(STARTER_PROFILE), [events[0] as JournalEventEnvelope])
  const appliedBefore = seeded.appliedEvents.length

  const grown = replayEvents(seeded, [
    events[0] as JournalEventEnvelope,
    events[1] as JournalEventEnvelope,
  ])

  assert.equal(grown.revision, seeded.revision + 1)
  assert.equal(grown.draft, 'hello')
  assert.equal(grown.appliedEvents.length, appliedBefore + 1)
  assert.equal(grown.workspaces.length, 1)
})
