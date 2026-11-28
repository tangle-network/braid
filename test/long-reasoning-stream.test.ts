import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createDurableBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import type { BraidRuntimeEvent, RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import { SequenceIds } from '../src/ports/ids.js'

// A model that reasons for minutes streams tens of thousands of events: per few characters one
// part update that carries the whole reasoning so far, and one thinking marker.
const DELTAS = Number(process.env.REASONING_DELTAS ?? 12_000)
const PIECE_LENGTH = 4
// One durable write can stall a slow disk for about a second; a backlog held the loop for minutes.
const RESPONSIVE_MS = 3_000

function piece(index: number): string {
  return `${String(index % 1000).padStart(PIECE_LENGTH - 1, '0')} `
}

/** The sandbox provider's stream: sequenced envelopes that arrive faster than Braid commits them. */
async function* longReasoning(runId: string): AsyncIterable<RuntimeEventEnvelope> {
  const receivedAt = '2026-11-28T00:00:00.000Z'
  let sequence = 0
  let accumulated = ''
  const envelope = (event: BraidRuntimeEvent): RuntimeEventEnvelope => {
    sequence += 1
    return { runId, eventId: `provider-event-${sequence}`, sequence, receivedAt, event }
  }
  for (let index = 0; index < DELTAS; index += 1) {
    accumulated += piece(index)
    yield envelope({ type: 'model-processing', phase: 'thinking' } as unknown as BraidRuntimeEvent)
    yield envelope({
      type: 'message.part.updated',
      part: {
        id: 'part-reasoning-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'reasoning',
        text: accumulated,
      },
      delta: piece(index),
    })
  }
  yield envelope({
    type: 'final',
    status: 'completed',
    reason: 'completed',
    text: 'the answer',
    metadata: { tokenUsage: { input: 1, output: 1 } },
    task: { id: runId, intent: 'think hard' },
    timestamp: receivedAt,
  } as BraidRuntimeEvent)
}

function reasoningText(state: {
  readonly messages: readonly {
    readonly parts: readonly { readonly kind: string; readonly text?: string }[]
  }[]
}): string {
  return (
    state.messages.flatMap((message) => message.parts).find((part) => part.kind === 'reasoning')
      ?.text ?? ''
  )
}

test('a long reasoning stream leaves the terminal responsive and loses no text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-long-reasoning-'))
  const options = {
    path: join(root, 'braid.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    profile: DETERMINISTIC_PROFILE,
    ids: new SequenceIds(),
    execution: { streamTurn: (input: { readonly runId: string }) => longReasoning(input.runId) },
  }
  const first = await createDurableBraidApplication(options)
  const { app } = first
  app.initialize(root)
  await app.whenDurable()

  let worstLagMs = 0
  let tick = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    worstLagMs = Math.max(worstLagMs, now - tick - 25)
    tick = now
  }, 25)

  const run = app.send({ operationId: 'op-long-reasoning', text: 'think hard' })
  await run.admissionReady
  while ((app.state().runs.find((item) => item.id === run.runId)?.lastProviderSequence ?? 0) < 1)
    await new Promise((resolve) => setTimeout(resolve, 1))

  // The terminal creates a second conversation and focuses the first run while the stream is live.
  const requestedAt = performance.now()
  const second = await app.conversations.lifecycle.create({
    operationId: 'op-long-reasoning-b',
    title: 'Second conversation',
  })
  app.focusRun({ operationId: 'op-long-reasoning-focus', runId: run.runId })
  await app.whenDurable()
  const interactionMs = performance.now() - requestedAt
  await run.completion
  clearInterval(timer)

  console.log(
    JSON.stringify({
      deltas: DELTAS,
      secondConversationMs: Math.round(interactionMs),
      worstLoopStallMs: Math.round(worstLagMs),
    }),
  )
  assert.ok(worstLagMs < RESPONSIVE_MS, `the event loop stalled ${Math.round(worstLagMs)} ms`)
  assert.ok(
    interactionMs < RESPONSIVE_MS,
    `the second conversation took ${Math.round(interactionMs)} ms`,
  )

  const expected = Array.from({ length: DELTAS }, (_, index) => piece(index)).join('')
  const state = app.state()
  const finished = state.runs.find((item) => item.id === run.runId)
  assert.equal(finished?.status, 'completed')
  assert.equal(finished?.lastProviderSequence, DELTAS * 2 + 1)
  assert.equal(finished?.missingSequence, undefined)
  assert.deepEqual(state.missingHistory, [])
  assert.equal(reasoningText(state), expected)
  assert.ok(state.conversations.some((conversation) => conversation.id === second.id))

  const ids = app.events().map((envelope) => envelope.eventId)
  assert.equal(new Set(ids).size, ids.length, 'event ids stay unique')
  await app.close()

  // Resume: the journal alone rebuilds the same transcript and the provider cursor.
  const reopened = await createDurableBraidApplication(options)
  const resumed = reopened.app.state()
  assert.equal(reasoningText(resumed), expected)
  assert.equal(
    resumed.runs.find((item) => item.id === run.runId)?.lastProviderSequence,
    DELTAS * 2 + 1,
  )
  await reopened.app.close()
})
