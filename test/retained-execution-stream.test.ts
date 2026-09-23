import assert from 'node:assert/strict'
import test from 'node:test'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import type { RetainedExecutionPlan } from '../src/adapters/runtime/retained-execution-contract.js'
import type { RetainedExecutionState } from '../src/adapters/runtime/retained-execution-state.js'
import { streamRetainedExecution } from '../src/adapters/runtime/retained-execution-stream.js'

test('a stalled result read after a failed status stops at its deadline', async () => {
  const handle = {
    controlRef: { environmentId: 'sandbox-stalled' },
    async *events() {
      yield {
        eventId: 'status-failed',
        sequence: 1,
        receivedAt: '2026-09-23T00:00:00.000Z',
        event: { type: 'status', status: 'failed' },
      }
    },
    // The result endpoint never answers.
    result: () => new Promise(() => undefined),
  } as unknown as RetainedRunHandle
  const state = {
    replaceReader: () => undefined,
    clearReader: () => undefined,
  } as unknown as RetainedExecutionState
  const plan = { projectFinal: assert.fail } as unknown as RetainedExecutionPlan
  const stream = streamRetainedExecution({
    runId: 'run-stalled',
    handle,
    plan,
    state,
    signal: new AbortController().signal,
    includeObservation: false,
    afterSequence: 1,
    resultTimeoutMs: 20,
  })
  const first = await stream.next()
  assert.equal(first.done, false)
  await assert.rejects(stream.next(), (error: unknown) => {
    assert.equal((error as Error).name, 'TimeoutError')
    return true
  })
})

test('cancelling a run while its result is pending still delivers the exact final result', async () => {
  let settle: ((value: unknown) => void) | undefined
  const cleared: string[] = []
  const handle = {
    controlRef: { environmentId: 'sandbox-cancelled' },
    async *events() {
      yield {
        eventId: 'status-cancelled',
        sequence: 1,
        receivedAt: '2026-09-23T00:00:00.000Z',
        event: { type: 'status', status: 'cancelled' },
      }
    },
    result: () =>
      new Promise((resolve) => {
        settle = resolve
      }),
  } as unknown as RetainedRunHandle
  const state = {
    replaceReader: () => undefined,
    clearReader: (runId: string) => cleared.push(runId),
  } as unknown as RetainedExecutionState
  const plan = {
    projectFinal: ({
      runId,
      sequence,
      result,
    }: {
      runId: string
      sequence: number
      result: unknown
    }) => ({
      runId,
      eventId: `${runId}:final`,
      sequence,
      receivedAt: '2026-09-23T00:00:01.000Z',
      event: { type: 'final', status: 'cancelled', result },
    }),
  } as unknown as RetainedExecutionPlan
  const cancel = new AbortController()
  const stream = streamRetainedExecution({
    runId: 'run-cancelled',
    handle,
    plan,
    state,
    signal: cancel.signal,
    includeObservation: false,
    afterSequence: 1,
    resultTimeoutMs: 5_000,
  })
  assert.equal((await stream.next()).done, false)
  const pending = stream.next()
  cancel.abort(new DOMException('Retained run cancelled', 'AbortError'))
  await new Promise((resolve) => setTimeout(resolve, 10))
  settle?.({ status: 'cancelled' })
  const final = await pending
  assert.equal(final.value?.event.type, 'final')
  assert.deepEqual(await stream.next(), { done: true, value: undefined })
  assert.deepEqual(cleared, ['run-cancelled'])
})
