import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { AppError, BraidApplication } from '../src/app/application.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { buildAppView } from '../src/app/view-model.js'
import { FixedClock } from '../src/ports/clock.js'
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
