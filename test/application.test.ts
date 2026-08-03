import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { AppError, BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { FileJournal } from '../src/app/journal.js'
import { buildAppView } from '../src/app/view-model.js'
import { FixedClock } from '../src/ports/clock.js'
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
      'run.text.delta',
      'run.text.delta',
      'run.text.delta',
      'run.text.delta',
      'run.finished',
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
  assert.equal(app.events().length, finalEventCount)
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
  const blocked = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  blocked.initialize('/workspace')
  const blockedState = await blocked.send({ operationId: 'op-blocked', text: 'wait' }).completion
  assert.equal(buildAppView(blockedState).status, 'blocked')

  const unconfigured = buildAppView(createBraidApplication().state())
  assert.equal(unconfigured.connection, 'not connected')
  assert.equal(unconfigured.model, 'automatic')
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
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-redaction', text: 'trigger provider error' }).completion
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

test('cancel uses the durable operation ledger and replays after terminal completion', async () => {
  const app = createBraidApplication({ fixture: 'deterministic', chunkDelayMs: 25 })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-cancel-ledger', text: 'cancel this turn' })
  const first = app.cancel({ operationId: 'cancel-stable', runId: send.runId })
  const firstState = await first.completion
  assert.equal(firstState.runs[0]?.status, 'aborted')
  assert.equal(
    app.events().some((entry) => entry.event.kind === 'run.cancel.requested'),
    true,
  )
  const replay = app.cancel({ operationId: 'cancel-stable', runId: send.runId })
  assert.equal(replay.replayed, true)
  assert.deepEqual(await replay.completion, firstState)
  assert.throws(
    () => app.cancel({ operationId: 'cancel-stable', runId: 'another-run' }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_CONFLICT',
  )
})

test('cancel wait resolves unknown when the provider ignores abort', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>(() => {})
      yield { type: 'text_delta', text: 'never emitted' }
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'send-ignores-abort', text: 'wait for unknown' })
  const cancel = app.cancel({ operationId: 'cancel-ignores-abort', runId: send.runId })
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
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
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

test('durable journal prevents redispatch after restart and replays shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-journal-'))
  const journalPath = join(root, 'events.jsonl')
  let streamStarts = 0
  let releaseStream: (() => void) | undefined
  try {
    const execution: ExecutionPort = {
      capabilities: { cancel: true },
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
        streamStarts += 1
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
    const first = new BraidApplication({
      profile: DETERMINISTIC_PROFILE,
      execution,
      clock: new FixedClock(),
      ids: new SequenceIds(),
      journal: new FileJournal(journalPath, new FixedClock()),
      cancelTimeoutMs: 100,
    })
    first.initialize('/workspace')
    const send = first.send({ operationId: 'op-durable-send', text: 'restart me' })

    const restarted = new BraidApplication({
      profile: DETERMINISTIC_PROFILE,
      execution,
      clock: new FixedClock(),
      ids: new SequenceIds(),
      journal: new FileJournal(journalPath, new FixedClock()),
      cancelTimeoutMs: 100,
    })
    const replay = restarted.send({ operationId: 'op-durable-send', text: 'restart me' })
    assert.equal(replay.replayed, true)
    assert.equal(streamStarts, 1)
    assert.equal(restarted.state().runs[0]?.status, 'unknown')
    assert.equal(
      restarted.events().filter((entry) => entry.event.kind === 'run.requested').length,
      1,
    )

    const shutdown = restarted.shutdown({ operationId: 'op-durable-shutdown' })
    assert.equal(shutdown.replayed, false)
    await shutdown.completion
    const shutdownReplay = restarted.shutdown({ operationId: 'op-durable-shutdown' })
    assert.equal(shutdownReplay.replayed, true)
    assert.equal(
      restarted.events().filter((entry) => entry.event.kind === 'application.shutdown.requested')
        .length,
      1,
    )

    const cancel = first.cancel({ operationId: 'op-durable-cancel', runId: send.runId })
    await cancel.completion
    releaseStream?.()
    await send.completion
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-large', text: 'large output' }).completion
  const assistant = createApplicationUiController(app).view().messages.at(-1)
  assert.ok(assistant)
  assert.ok((assistant?.parts[0]?.text.length ?? Infinity) <= MAX_RENDERED_TEXT_CHARS)
  assert.equal(assistant?.parts[0]?.text.includes('\u001b'), false)
})

test('restart reconciles an in-flight cancellation to honest unknown and replays it', async () => {
  const profile = DETERMINISTIC_PROFILE
  const replay = [
    {
      sequence: 1,
      revision: 1,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: { kind: 'workspace.opened' as const, workspace: '/workspace' },
    },
    {
      sequence: 2,
      revision: 2,
      occurredAt: '2026-08-01T00:00:00.000Z',
      event: {
        kind: 'run.requested' as const,
        operationId: 'send-restart',
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
        kind: 'run.cancel.requested' as const,
        operationId: 'cancel-restart',
        runId: 'run-restart',
        reason: 'user requested cancellation',
      },
    },
  ]
  const app = new BraidApplication({
    profile,
    execution: { streamTurn: async function* () {} },
    clock: new FixedClock(),
    ids: new SequenceIds(),
    replay,
  })

  assert.equal(app.state().runs[0]?.status, 'unknown')
  assert.equal(app.state().messages[1]?.status, 'incomplete')
  const finalEvent = app.events().at(-1)?.event
  assert.equal(finalEvent?.kind, 'run.finished')
  if (finalEvent?.kind !== 'run.finished') assert.fail('missing restart reconciliation event')
  assert.equal(finalEvent.status, 'unknown')
  const replayed = app.cancel({
    operationId: 'cancel-restart',
    runId: 'run-restart',
    reason: 'user requested cancellation',
  })
  assert.equal(replayed.replayed, true)
  assert.equal((await replayed.completion).runs[0]?.status, 'unknown')
})
