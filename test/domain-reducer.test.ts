import assert from 'node:assert/strict'
import test from 'node:test'
import { STARTER_PROFILE } from '../src/app/composition.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import { createEventId, createReplayCursor, createWorkspaceId } from '../src/domain/ids.js'
import {
  DuplicateEventConflictError,
  reduceEvent,
  replayEvents,
  SequenceGapError,
} from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'

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
