import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { AppError, BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { FixedClock } from '../src/ports/clock.js'
import { SequenceIds } from '../src/ports/ids.js'

function finalEvent(text: string): RuntimeStreamEvent {
  return {
    type: 'final',
    status: 'completed',
    reason: 'done',
    text,
    metadata: { tokenUsage: { input: 1, output: 1 } },
    task: { id: 'task-cancellation', intent: 'cancellation fixture' },
    timestamp: '2026-08-01T00:00:00.000Z',
  }
}

function newApp(options: {
  readonly execution: import('../src/ports/execution.js').ExecutionPort
  readonly cancelTimeoutMs?: number
}): BraidApplication {
  return new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: options.execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal: new MemoryJournal(new FixedClock()),
    effectStorage: new MemoryJournal(new FixedClock()),
    ...(options.cancelTimeoutMs === undefined ? {} : { cancelTimeoutMs: options.cancelTimeoutMs }),
  })
}

test('a rejecting provider cancel reconciles to honest unknown without leaking the error', async () => {
  let releaseStream: (() => void) | undefined
  const execution: import('../src/ports/execution.js').ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      yield finalEvent('late provider result')
    },
    async cancelRun() {
      throw new Error('provider exploded token=CANARY-CANCEL-LEAK')
    },
  }
  const app = newApp({ execution, cancelTimeoutMs: 5_000 })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-cancel-crash-send', text: 'wait then crash' })
  const cancel = app.cancel({ operationId: 'op-cancel-crash', runId: send.runId })
  const state = await cancel.completion

  assert.equal(state.runs[0]?.status, 'unknown')
  assert.equal(state.lastError, 'PROVIDER_CANCEL_ERROR')
  const serialized = JSON.stringify({ state, events: app.events() })
  assert.equal(serialized.includes('CANARY-CANCEL-LEAK'), false)

  releaseStream?.()
  await send.completion
})

test('a second cancel of the same run under a different operation id is rejected', async () => {
  let releaseStream: (() => void) | undefined
  const execution: import('../src/ports/execution.js').ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>((resolve) => {
        releaseStream = resolve
      })
      yield finalEvent('late result')
    },
    async cancelRun() {
      return { status: 'cancelled' as const }
    },
  }
  const app = newApp({ execution, cancelTimeoutMs: 5_000 })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-double-send', text: 'cancel me once' })
  app.cancel({ operationId: 'op-double-cancel-a', runId: send.runId })

  assert.throws(
    () => app.cancel({ operationId: 'op-double-cancel-b', runId: send.runId }),
    (error: unknown) => error instanceof AppError && error.code === 'UNKNOWN_RUN',
  )
  await app
    .cancel({ operationId: 'op-double-cancel-a', runId: send.runId })
    .completion.catch(() => undefined)
  const cancelRequests = app
    .events()
    .filter((envelope) => envelope.event.kind === 'run.cancel.requested').length
  assert.equal(cancelRequests, 1)
  releaseStream?.()
  await send.completion
})

test('cancelling an already-completed run is rejected and appends no events', async () => {
  const execution: import('../src/ports/execution.js').ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield finalEvent('done')
    },
  }
  const app = newApp({ execution })
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-completed-send', text: 'finish' })
  await send.completion
  const eventsBefore = app.events().length

  assert.throws(
    () => app.cancel({ operationId: 'op-cancel-completed', runId: send.runId }),
    (error: unknown) => error instanceof AppError && error.code === 'UNKNOWN_RUN',
  )
  assert.equal(app.events().length, eventsBefore)
  assert.equal(app.state().runs[0]?.status, 'completed')
})
