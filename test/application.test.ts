import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { AppError, BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { buildAppView } from '../src/app/view-model.js'
import { FixedClock } from '../src/ports/clock.js'
import type { JournalPort } from '../src/ports/effect-storage.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'

test('one send streams through runtime and reaches one terminal result', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')

  const receipt = app.send({ operationId: 'op-1', text: 'hello Braid' })
  const state = await receipt.completion

  assert.equal(state.activeRunId, null)
  assert.equal(state.runs.length, 1)
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[0]?.text, 'hello Braid')
  assert.equal(state.messages[1]?.text, 'Fixture response through pi: hello Braid')
  assert.deepEqual(
    app.events().map((envelope) => envelope.event.kind),
    [
      'workspace.opened',
      'draft.changed',
      'run.requested',
      'effect.upserted',
      'run.text.delta',
      'run.text.delta',
      'run.text.delta',
      'run.text.delta',
      'run.finished',
      'effect.upserted',
    ],
  )
})

test('an identical operation is replayed and conflicting input is rejected', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const first = app.send({ operationId: 'op-stable', text: 'same input' })
  await first.completion
  const eventCount = app.events().length

  const replay = app.send({ operationId: 'op-stable', text: 'same input' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.runId, first.runId)
  await replay.completion
  assert.equal(app.events().length, eventCount)

  await app.send({ operationId: 'op-second', text: 'later input' }).completion
  const currentRevision = app.state().revision
  const lateReplay = app.send({ operationId: 'op-stable', text: 'same input' })
  const replayedState = await lateReplay.completion
  assert.equal(replayedState.revision, currentRevision)
  assert.equal(replayedState.messages.length, 4)
  const finalEventCount = app.events().length

  assert.throws(
    () => app.send({ operationId: 'op-stable', text: 'changed input' }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )
  assert.equal(app.events().length, finalEventCount + 1)
  assert.equal(app.events().at(-1)?.event.kind, 'effect.upserted')
})

test('send rejects malformed operation identities and oversized input before journaling', () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const eventCount = app.events().length

  assert.throws(
    () => app.send({ operationId: 'token=do-not-store', text: 'hello' }),
    (error: unknown) => error instanceof AppError && error.code === 'INVALID_OPERATION_ID',
  )
  assert.throws(
    () => app.send({ operationId: 'op-too-large', text: 'x'.repeat(1024 * 1024 + 1) }),
    (error: unknown) => error instanceof AppError && error.code === 'MESSAGE_TOO_LARGE',
  )
  assert.equal(app.events().length, eventCount)
})

test('the deterministic stream preserves leading and consecutive newlines', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-lines', text: '\nA\n\nB' }).completion

  assert.equal(state.messages[1]?.text, 'Fixture response through pi: \nA\n\nB')
})

test('cancellation remains distinct from failure', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 25 })
  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-cancel', text: 'cancel this turn' })
  assert.equal(app.cancelActive(), true)
  const state = await receipt.completion

  assert.equal(state.runs[0]?.status, 'aborted')
  assert.match(state.lastError ?? '', /abort|cancel/iu)
  assert.equal(buildAppView(state).status, 'aborted')
})

test('blocked and unconfigured states remain explicit', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield {
        type: 'final',
        status: 'blocked',
        reason: 'approval required',
        text: 'waiting',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-blocked', intent: 'blocked test' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
  }
  const blockedJournal = new MemoryJournal(new FixedClock())
  const blocked = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: blockedJournal,
    effectStorage: blockedJournal,
  })
  blocked.initialize('/workspace')
  const blockedState = await blocked.send({ operationId: 'op-blocked', text: 'wait' }).completion
  assert.equal(buildAppView(blockedState).status, 'blocked')

  const unconfigured = buildAppView(createBraidApplication().state())
  assert.equal(unconfigured.connection, 'not connected')
  assert.equal(unconfigured.model, 'automatic')
})

test('a terminal journal failure never acknowledges the external run', async () => {
  const delegate = new MemoryJournal(new FixedClock())
  let terminalAttempts = 0
  const journal: JournalPort = {
    envelope: (state, event) => delegate.envelope(state, event),
    append: (envelope) => {
      if (envelope.event.kind === 'run.finished') {
        terminalAttempts += 1
        throw new Error('journal commit failed')
      }
      delegate.append(envelope)
    },
    all: () => delegate.all(),
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'externally completed',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-terminal-failure', intent: 'terminal failure' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: delegate,
  })

  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-terminal-journal-failure', text: 'hello' })
  const state = await receipt.completion

  assert.equal(terminalAttempts, 2)
  assert.equal(delegate.current('op-terminal-journal-failure')?.status, 'unknown')
  assert.equal(state.runs[0]?.status, 'streaming')
  assert.equal(state.activeRunId, state.runs[0]?.id)
})

test('completion waits for the terminal event and effect projection to flush', async () => {
  const delegate = new MemoryJournal(new FixedClock())
  const flushes: string[] = []
  let terminalQueued = false
  let terminalEffectQueued = false
  const journal: JournalPort = {
    envelope: (state, event) => delegate.envelope(state, event),
    append: (envelope) => {
      delegate.append(envelope)
      if (envelope.event.kind === 'run.finished') terminalQueued = true
      if (
        envelope.event.kind === 'effect.upserted' &&
        envelope.event.effect.status === 'terminal'
      ) {
        terminalEffectQueued = true
      }
    },
    all: () => delegate.all(),
    flush: async () => {
      flushes.push(
        terminalEffectQueued ? 'terminal-effect' : terminalQueued ? 'terminal-event' : 'intent',
      )
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'complete',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-flush-order', intent: 'flush order' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: delegate,
  })

  app.initialize('/workspace')
  await app.send({ operationId: 'op-flush-order', text: 'hello' }).completion

  assert.deepEqual(flushes, ['intent', 'terminal-event', 'terminal-effect'])
})

test('an asynchronous terminal write failure leaves the external outcome unknown', async () => {
  const delegate = new MemoryJournal(new FixedClock())
  let terminalQueued = false
  const journal: JournalPort = {
    envelope: (state, event) => delegate.envelope(state, event),
    append: (envelope) => {
      delegate.append(envelope)
      if (envelope.event.kind === 'run.finished') terminalQueued = true
    },
    all: () => delegate.all(),
    flush: async () => {
      if (terminalQueued) throw new Error('delayed disk failure')
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'externally complete',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-async-terminal-failure', intent: 'async terminal failure' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: delegate,
  })

  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-async-terminal-failure', text: 'hello' })
  await assert.rejects(receipt.completion, /delayed disk failure/u)
  assert.equal(delegate.current('op-async-terminal-failure')?.status, 'unknown')
})

test('provider diagnostics and model metadata cannot persist credential material', async () => {
  const canary = 'never-persist-this-value'
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'failed',
          reason: 'failed',
          text: '',
          error: {
            kind: 'transport',
            message: `request failed at https://user:${canary}@provider.example/v1`,
          },
          metadata: {
            model: `model-token-${canary}`,
            tokenUsage: { input: Number.POSITIVE_INFINITY, output: -1 },
          },
          task: { id: 'task-redaction', intent: 'redaction' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })

  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-redaction', text: 'hello' }).completion
  const serialized = JSON.stringify({ state, events: app.events() })
  assert.equal(serialized.includes(canary), false)
  assert.equal(state.runs[0]?.error, 'RUNTIME_FINAL_ERROR')
  assert.equal(state.runs[0]?.model, undefined)
  assert.equal(state.runs[0]?.inputTokens, 0)
  assert.equal(state.runs[0]?.outputTokens, 0)
})

test('subscriber failures cannot alter a completed run', async () => {
  const app = createBraidApplication({ fixture: 'deterministic' })
  app.subscribe(() => {
    throw new Error('renderer failed')
  })
  app.initialize('/workspace')

  const state = await app.send({ operationId: 'op-subscriber', text: 'hello' }).completion

  assert.equal(state.runs[0]?.status, 'completed')
})

test('events after the first final result are ignored', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        yield {
          type: 'final',
          status: 'completed',
          reason: 'completed',
          text: 'first final',
          metadata: { tokenUsage: { input: 1, output: 1 } },
          task: { id: 'task-first-final', intent: 'first final' },
          timestamp: '2026-08-01T00:00:00.000Z',
        }
        yield {
          type: 'text_delta',
          text: 'must not append',
          task: { id: 'task-first-final', intent: 'first final' },
          timestamp: '2026-08-01T00:00:00.001Z',
        }
      },
    },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })

  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-first-final', text: 'hello' }).completion

  assert.equal(state.messages[1]?.text, 'first final')
  assert.equal(app.events().filter((entry) => entry.event.kind === 'run.text.delta').length, 0)
})
