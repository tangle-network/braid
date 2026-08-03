import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { AppError, BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { buildAppView } from '../src/app/view-model.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import { FixedClock } from '../src/ports/clock.js'
import type { JournalPort } from '../src/ports/effect-storage.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { MAX_RENDERED_TEXT_CHARS } from '../src/views/shared/sanitize.js'

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

test('provider errors and profile values are redacted before state and journal commit', async () => {
  let providerSawRawProfile = false
  const execution: ExecutionPort = {
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      providerSawRawProfile = JSON.stringify(input.profile).includes('CANARY-RAW-PROFILE')
      yield* []
      throw new Error(
        'request failed https://user:CANARY-URL@example.com/?token=CANARY-QUERY Bearer CANARY-BEARER',
      )
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: {
      ...DETERMINISTIC_PROFILE,
      metadata: {
        rawProfile: 'CANARY-RAW-PROFILE',
        mcpConfig: { command: 'CANARY-MCP-CONFIG' },
        attestationNonce: 'CANARY-ATTESTATION-NONCE',
        authorization: 'Bearer CANARY-PROFILE-BEARER',
      },
    },
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-redaction-profile', text: 'trigger provider error' }).completion
  assert.equal(providerSawRawProfile, true)
  const serialized = JSON.stringify({ state: app.state(), events: app.events() })
  assert.equal(serialized.includes('CANARY'), false)
  assert.match(serialized, /\[redacted(?: link| bearer)?\]/u)
  assert.equal(app.state().runs[0]?.status, 'failed')
  assert.equal(app.state().lastError?.includes('CANARY'), false)
  const controller = createApplicationUiController(app)
  const surfaces = JSON.stringify({
    state: controller.state(),
    view: controller.view(),
    events: controller.events(),
  })
  assert.equal(surfaces.includes('CANARY'), false)
  assert.equal(controller.view().statusText.includes('CANARY'), false)
})

test('cancel uses the operation ledger and replays after terminal completion', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 25 })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-cancel-ledger', text: 'cancel this turn' })
  const first = app.cancel({ operationId: 'op-cancel-stable', runId: send.runId })
  const firstState = await first.completion
  assert.equal(firstState.runs[0]?.status, 'aborted')
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'run.cancel.requested').length,
    1,
  )
  const replay = app.cancel({ operationId: 'op-cancel-stable', runId: send.runId })
  assert.equal(replay.replayed, true)
  assert.equal((await replay.completion).runs[0]?.status, 'aborted')
  assert.equal(
    app.events().filter((entry) => entry.event.kind === 'run.cancel.requested').length,
    1,
  )
  assert.throws(
    () => app.cancel({ operationId: 'op-cancel-stable', runId: 'run-another' }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )
})

test('cancel resolves unknown when the adapter cannot confirm the provider outcome', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>(() => {})
      yield { type: 'text_delta', text: 'never emitted' }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 100,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-send-ignores-abort', text: 'wait for unknown' })
  const cancel = app.cancel({ operationId: 'op-cancel-ignores-abort', runId: send.runId })
  const state = await app.waitForIdle()

  assert.equal(state.activeRunId, null)
  assert.equal(state.runs[0]?.status, 'unknown')
  assert.equal((await cancel.completion).runs[0]?.status, 'unknown')
  assert.match(state.lastError ?? '', /could not be confirmed/iu)
})

test('provider acknowledgement, not local abort, settles cancellation', async () => {
  let providerCancellationCalls = 0
  let releaseStream: (() => void) | undefined
  let streamStarted!: () => void
  const streamReady = new Promise<void>((resolve) => {
    streamStarted = resolve
  })
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarted()
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider acknowledged the late result',
        text: 'late provider result',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-late', intent: 'late result' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
    async cancelRun(): Promise<{ readonly status: 'cancelled' }> {
      providerCancellationCalls += 1
      return { status: 'cancelled' }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
    cancelTimeoutMs: 5_000,
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-provider-cancel', text: 'provider cancellation' })
  await streamReady
  const startedAt = performance.now()
  const cancel = app.cancel({ operationId: 'op-provider-cancel-request', runId: send.runId })
  const state = await cancel.completion

  assert.equal(providerCancellationCalls, 1)
  assert.equal(state.runs[0]?.status, 'aborted')
  assert.equal(state.lastError, 'Cancellation acknowledged by the provider')
  assert.ok(performance.now() - startedAt < 1_000)

  releaseStream?.()
  await send.completion
})

test('a restarted application replays the journal instead of redispatching', async () => {
  let streamStarts = 0
  let streamStarted!: () => void
  let releaseStream: (() => void) | undefined
  const streamReady = new Promise<void>((resolve) => {
    streamStarted = resolve
  })
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      streamStarts += 1
      streamStarted()
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider acknowledged the restart test',
        text: 'should not be dispatched twice',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-restart', intent: 'restart test' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
    async cancelRun(): Promise<{ readonly status: 'cancelled' }> {
      return { status: 'cancelled' }
    },
  }
  const durable = new MemoryJournal(new FixedClock())
  const first = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: durable,
    effectStorage: durable,
    cancelTimeoutMs: 100,
  })
  first.initialize('/workspace')
  const send = first.send({ operationId: 'op-durable-send', text: 'restart me' })
  await streamReady

  const restarted = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: durable,
    effectStorage: durable,
    cancelTimeoutMs: 100,
  })
  assert.equal(restarted.state().runs[0]?.status, 'unknown')
  assert.throws(
    () => restarted.send({ operationId: 'op-durable-send', text: 'restart me' }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'OPERATION_REQUIRES_RECONCILIATION',
  )
  assert.equal(streamStarts, 1)
  assert.equal(restarted.events().filter((entry) => entry.event.kind === 'run.requested').length, 1)

  const shutdown = restarted.shutdown({ operationId: 'op-durable-shutdown' })
  assert.equal(shutdown.replayed, false)
  await shutdown.completion
  const shutdownReplay = restarted.shutdown({ operationId: 'op-durable-shutdown' })
  assert.equal(shutdownReplay.replayed, true)
  await shutdownReplay.completion
  assert.equal(
    restarted.events().filter((entry) => entry.event.kind === 'application.shutdown.requested')
      .length,
    1,
  )

  releaseStream?.()
  await send.completion
})

test('restart reconciles an in-flight cancellation to honest unknown and replays it', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const seeded: readonly BraidEventEnvelope[] = [
    {
      sequence: 1,
      revision: 1,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: { kind: 'workspace.opened', workspace: '/workspace' },
    },
    {
      sequence: 2,
      revision: 2,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: {
        kind: 'run.requested',
        operationId: 'op-send-restart',
        runId: 'run-restart',
        turnId: 'turn-restart',
        userMessageId: 'message-user',
        assistantMessageId: 'message-assistant',
        text: 'restart this turn',
      },
    },
    {
      sequence: 3,
      revision: 3,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: {
        kind: 'run.cancel.requested',
        operationId: 'op-cancel-restart',
        runId: 'run-restart',
        reason: 'user requested cancellation',
      },
    },
  ]
  for (const envelope of seeded) journal.append(envelope)

  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: { streamTurn: async function* () {} },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })

  assert.equal(app.state().runs[0]?.status, 'unknown')
  assert.equal(app.state().messages[1]?.status, 'incomplete')
  const finalEvent = app.events().at(-1)?.event
  assert.equal(finalEvent?.kind, 'run.finished')
  if (finalEvent?.kind !== 'run.finished') assert.fail('missing restart reconciliation event')
  assert.equal(finalEvent.status, 'unknown')
  const replayed = app.cancel({
    operationId: 'op-cancel-restart',
    runId: 'run-restart',
    reason: 'user requested cancellation',
  })
  assert.equal(replayed.replayed, true)
  assert.equal((await replayed.completion).runs[0]?.status, 'unknown')
})

test('assistant parts are bounded before the terminal renderer sees them', async () => {
  const oversized = 'x'.repeat(MAX_RENDERED_TEXT_CHARS + 1_024)
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield {
        type: 'final',
        status: 'completed',
        reason: 'provider returned the bounded fixture',
        text: oversized,
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-large', intent: 'large output' },
        timestamp: '2026-08-01T00:00:00.000Z',
      }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-large', text: 'large output' }).completion
  const assistant = createApplicationUiController(app).view().messages.at(-1)
  assert.ok(assistant)
  assert.ok(
    (assistant?.parts[0]?.text.length ?? Number.POSITIVE_INFINITY) <= MAX_RENDERED_TEXT_CHARS,
  )
  assert.equal(assistant?.parts[0]?.text.includes('\u001b'), false)
})
