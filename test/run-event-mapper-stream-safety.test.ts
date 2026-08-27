import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { providerEventFor } from '../src/app/run-event-mapper.js'
import {
  MAX_ACTIVE_RUNTIME_STREAMS,
  MAX_RUNTIME_STREAM_TEXT_BYTES,
  RuntimeStreamBudget,
} from '../src/app/run-event-mapper-stream-budget.js'
import { redactSensitiveText } from '../src/domain/secret-sanitizer.js'
import { MAX_TERMINAL_CONTROL_BYTES } from '../src/domain/terminal-sanitizer.js'
import { FixedClock } from '../src/ports/clock.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'

const CONTROL_CANARY = 'SPLIT-CONTROL-CANARY'
const BEARER_CANARY = 'SPLIT-BEARER-CANARY'
const ASSIGNMENT_CANARY = 'SPLIT-ASSIGNMENT-CANARY'
const URL_CANARY = 'SPLIT-URL-CANARY'
const BARE_CREDENTIAL = `sk-${'c'.repeat(20)}`

let runNumber = 0

function runId(): string {
  runNumber += 1
  return `stream-safety-${runNumber}`
}

function provider(sequence: number) {
  return {
    eventId: `stream-event-${sequence}`,
    providerSequence: sequence,
    receivedAt: '2026-08-09T00:00:00.000Z',
  }
}

function mapText(id: string, sequence: number, text: string): string {
  const event = providerEventFor(id, { type: 'text_delta', text }, provider(sequence))
  assert.equal(event.kind, 'run.text.delta')
  return event.text
}

function finalEvent(text?: string): Extract<RuntimeStreamEvent, { type: 'final' }> {
  return {
    type: 'final',
    status: 'completed',
    reason: 'stream safety test complete',
    ...(text === undefined ? {} : { text }),
    metadata: { tokenUsage: { input: 1, output: 1 } },
    task: { id: 'stream-safety-task', intent: 'stream safety test' },
    timestamp: '2026-08-09T00:00:00.000Z',
  }
}

function finish(id: string, sequence: number, text?: string): string {
  const event = providerEventFor(id, finalEvent(text), provider(sequence))
  assert.equal(event.kind, 'run.finished')
  return event.finalText
}

function streamAtBoundary(value: string, boundary: number): string {
  const id = runId()
  const deltas = mapText(id, 1, value.slice(0, boundary)) + mapText(id, 2, value.slice(boundary))
  const completed = finish(id, 3)
  return completed || deltas
}

test('split CSI, OSC, and bidi controls stay suppressed at every event boundary', () => {
  const cases = [
    { value: 'before\u001b[31mafter', forbidden: '\u001b' },
    { value: 'before\u009b31mafter', forbidden: '\u009b' },
    {
      value: `before\u001b]52;c;${CONTROL_CANARY}\u0007after`,
      forbidden: CONTROL_CANARY,
    },
    {
      value: `before\u001b]52;c;${CONTROL_CANARY}\u001b\\after`,
      forbidden: CONTROL_CANARY,
    },
    {
      value: `before\u009d52;c;${CONTROL_CANARY}\u009cafter`,
      forbidden: CONTROL_CANARY,
    },
    { value: 'before\u202eafter', forbidden: '\u202e' },
  ]

  for (const { value, forbidden } of cases) {
    const expected = redactSensitiveText(value)
    for (let boundary = 0; boundary <= value.length; boundary += 1) {
      const actual = streamAtBoundary(value, boundary)
      assert.equal(actual, expected, `${JSON.stringify(value)} at ${boundary}`)
      assert.equal(actual.includes(forbidden), false)
    }
  }
})

test('split bearer, assignment, URL, and bare credential tokens never cross the mapper', () => {
  const values = [
    `prefix Bearer ${BEARER_CANARY} suffix`,
    `prefix token=${ASSIGNMENT_CANARY} suffix`,
    `prefix https://provider.example/callback?token=${URL_CANARY} suffix`,
    `prefix ${BARE_CREDENTIAL} suffix`,
  ]

  for (const value of values) {
    const expected = redactSensitiveText(value)
    for (let boundary = 0; boundary <= value.length; boundary += 1) {
      const actual = streamAtBoundary(value, boundary)
      assert.equal(actual, expected, `${value.slice(0, 24)} at ${boundary}`)
      assert.equal(actual.includes(BEARER_CANARY), false)
      assert.equal(actual.includes(ASSIGNMENT_CANARY), false)
      assert.equal(actual.includes(URL_CANARY), false)
      assert.equal(actual.includes(BARE_CREDENTIAL), false)
    }
  }
})

test('an oversized unterminated terminal control remains hidden instead of reopening output', () => {
  const budget = new RuntimeStreamBudget()
  const id = 'stream-control-overflow'
  budget.push(id, 1, `A\u001b]`)
  budget.push(id, 2, `52;c;${'x'.repeat(MAX_TERMINAL_CONTROL_BYTES + 128)}${CONTROL_CANARY}`)
  budget.push(id, 3, 'visible-after-overflow')
  const output = budget.finish(id).accumulatedText

  assert.equal(output, 'A')
  assert.equal(output.includes(CONTROL_CANARY), false)
})

test('runtime stream text is bounded across arbitrarily many chunks', () => {
  const budget = new RuntimeStreamBudget()
  const id = 'stream-output-overflow'
  const chunk = 'x'.repeat(4096)
  let output = ''
  for (let sequence = 1; sequence <= 256; sequence += 1) output += budget.push(id, sequence, chunk)
  const completed = budget.finish(id)
  output = completed.accumulatedText

  assert.ok(Buffer.byteLength(output, 'utf8') <= MAX_RUNTIME_STREAM_TEXT_BYTES)
  assert.equal(output.length > 0, true)
})

test('the active stream registry refuses unbounded orphaned runs', () => {
  const budget = new RuntimeStreamBudget()
  const chunk = 'orphaned stream '
  for (let index = 0; index < MAX_ACTIVE_RUNTIME_STREAMS; index += 1)
    assert.equal(budget.push(`orphan-${index}`, 1, chunk), chunk)
  assert.equal(budget.push('orphan-overflow', 1, 'must not accumulate'), '')
  for (let index = 0; index < MAX_ACTIVE_RUNTIME_STREAMS; index += 1)
    budget.discard(`orphan-${index}`)
})

test('the application path flushes pending stream text without journaling canaries', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield { type: 'text_delta', text: `A\u001b` }
      yield { type: 'text_delta', text: `]52;c;${CONTROL_CANARY}\u0007B Bearer ` }
      yield { type: 'text_delta', text: `${BEARER_CANARY} after` }
      yield finalEvent()
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
  const state = await app.send({ operationId: 'op-stream-safety-app', text: 'hello' }).completion
  const serialized = JSON.stringify({ state, events: app.events() })

  assert.equal(serialized.includes(CONTROL_CANARY), false)
  assert.equal(serialized.includes(BEARER_CANARY), false)
  assert.equal(state.messages.at(-1)?.text, 'AB [redacted bearer] after')
})
