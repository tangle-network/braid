import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReplayPort } from '../src/app/application-ports.js'
import { recoverPendingFinal } from '../src/app/run-final-recovery.js'

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// A terminal-by-status run with an exact control reference, as Braid leaves it before its final.
function stubContext(reconnect: () => AsyncGenerator<unknown>) {
  const run = {
    id: 'run-pending-final',
    status: 'failed',
    controlRef: { runId: 'run-pending-final', environmentId: 'sandbox-1' },
    capabilities: { streaming: { replay: true }, events: { cursor: true } },
    lastCursor: 'event-3',
    lastProviderSequence: 3,
    receipt: { requested: {} },
  }
  const ingested: unknown[] = []
  const context = {
    currentState: () => ({ runs: [run], workspace: null }),
    findRun: () => run,
    execution: { reconnect },
    ingestRuntimeEvent: async (envelope: unknown) => {
      ingested.push(envelope)
      return { accepted: true, duplicate: false }
    },
  } as unknown as ReplayPort
  return { context, ingested }
}

const finalEnvelope = {
  runId: 'run-pending-final',
  eventId: 'run-pending-final:final',
  sequence: 4,
  receivedAt: '2026-09-23T00:00:00.000Z',
  event: { type: 'final', status: 'failed', text: '', reason: 'failed' },
}

test('pending final recovery proceeds at its deadline when the provider ignores the abort', async () => {
  const { context, ingested } = stubContext(async function* () {
    // A stalled result endpoint that never settles and never observes the signal.
    await new Promise(() => {})
    yield finalEnvelope
  })
  const started = Date.now()
  await recoverPendingFinal(context, 'run-pending-final', 20)
  assert.ok(Date.now() - started < 1_000)
  assert.deepEqual(ingested, [])
})

test('a final that settles after the recovery deadline commits nothing', async () => {
  const { context, ingested } = stubContext(async function* () {
    await pause(60)
    yield finalEnvelope
  })
  await recoverPendingFinal(context, 'run-pending-final', 20)
  await pause(120)
  assert.deepEqual(ingested, [])
})

test('a final that settles within the recovery deadline is ingested once', async () => {
  const { context, ingested } = stubContext(async function* () {
    yield finalEnvelope
  })
  await recoverPendingFinal(context, 'run-pending-final', 1_000)
  assert.deepEqual(ingested, [finalEnvelope])
})
