import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import {
  IncrementalSanitizer,
  MAX_SANITIZER_CONTROL_BYTES,
  MAX_SANITIZER_PENDING_BYTES,
  redactSensitiveText,
} from '../src/domain/incremental-sanitizer.js'
import { BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { FixedClock } from '../src/ports/clock.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'

const CONTROL_CANARY = 'CONTROL-STREAM-CANARY'
const BEARER_CANARY = 'BEARER-STREAM-CANARY'
const URL_CANARY = 'URL-STREAM-CANARY'
const CONTROL_BODY = `${CONTROL_CANARY}-漢😀`

const CONTROL_CASES = [
  `\u001b]52;c;${CONTROL_BODY}\u0007`,
  `\u001b]52;c;${CONTROL_BODY}\u001b\\`,
  `\u009d52;c;${CONTROL_BODY}\u009c`,
  `\u001bP1;2+q${CONTROL_BODY}\u001b\\`,
  `\u00901;2+q${CONTROL_BODY}\u009c`,
  `\u001bX${CONTROL_BODY}\u001b\\`,
  `\u0098${CONTROL_BODY}\u009c`,
  `\u001b^${CONTROL_BODY}\u001b\\`,
  `\u009e${CONTROL_BODY}\u009c`,
  `\u001b_${CONTROL_BODY}\u001b\\`,
  `\u009f${CONTROL_BODY}\u009c`,
  `\u001b[31m`,
  `\u009b31m`,
] as const

function splitAtCodePoint(value: string, index: number): [string, string] {
  const codePoints = Array.from(value)
  return [codePoints.slice(0, index).join(''), codePoints.slice(index).join('')]
}

function sanitizeInTwoParts(value: string, index: number): string {
  const sanitizer = new IncrementalSanitizer()
  const [first, second] = splitAtCodePoint(value, index)
  return `${sanitizer.push(first)}${sanitizer.push(second)}${sanitizer.finish()}`
}

function emittedInTwoParts(value: string, index: number): string[] {
  const sanitizer = new IncrementalSanitizer()
  const [first, second] = splitAtCodePoint(value, index)
  return [sanitizer.push(first), sanitizer.push(second), sanitizer.finish()]
}

test('every ESC and C1 control family stays suppressed at every chunk boundary', () => {
  for (const control of CONTROL_CASES) {
    const value = `A${control}B`
    const expected = redactSensitiveText(value)
    for (let index = 0; index <= Array.from(value).length; index += 1) {
      const actual = sanitizeInTwoParts(value, index)
      assert.equal(actual, expected, `boundary ${index} for ${JSON.stringify(control)}`)
      assert.equal(actual.includes(CONTROL_CANARY), false)
    }
  }
})

test('the concrete split OSC probe never persists the OSC body', () => {
  const sanitizer = new IncrementalSanitizer()
  assert.equal(sanitizer.push('A\u001b'), 'A')
  assert.equal(sanitizer.push(`]52;c;${CONTROL_CANARY}\u0007B`), 'B')
  assert.equal(sanitizer.finish(), '')
})

test('bearer values and sensitive URLs stay private at every chunk boundary', () => {
  const values = [
    `prefix Bearer ${BEARER_CANARY} suffix`,
    `prefix bearer\t${BEARER_CANARY}, suffix`,
    `prefix https://provider.example/callback?access_token=${URL_CANARY} suffix`,
    `prefix https://user:${URL_CANARY}@provider.example/path suffix`,
    `prefix https://provider.example/path#token=${URL_CANARY} suffix`,
    'prefix https://provider.example/docs suffix',
  ]

  for (const value of values) {
    const expected = redactSensitiveText(value)
    for (let index = 0; index <= Array.from(value).length; index += 1) {
      const pieces = emittedInTwoParts(value, index)
      assert.equal(pieces.join(''), expected, `boundary ${index} for ${value}`)
      assert.equal(
        pieces.some((piece) => piece.includes(BEARER_CANARY)),
        false,
      )
      assert.equal(
        pieces.some((piece) => piece.includes(URL_CANARY)),
        false,
      )
    }
  }
})

test('invalid ESC preserves adjacent Unicode while actual controls still disappear', () => {
  const value = '\u001b😀\u0007valid\u202e text'
  assert.equal(redactSensitiveText(value), '😀valid text')

  const sanitizer = new IncrementalSanitizer()
  assert.equal(sanitizer.push('\u001b'), '')
  assert.equal(sanitizer.push('😀\u0007valid'), '😀valid')
  assert.equal(sanitizer.finish(), '')
})

test('a surrogate pair split across stream chunks remains one Unicode code point', () => {
  const sanitizer = new IncrementalSanitizer()
  assert.equal(sanitizer.push('\u001b'), '')
  assert.equal(sanitizer.push('\ud83d'), '')
  assert.equal(sanitizer.push('\ude00'), '😀')
  assert.equal(sanitizer.finish(), '')
})

test('EOF, cancellation, and reset discard incomplete state without carrying it forward', () => {
  const sanitizer = new IncrementalSanitizer()
  assert.equal(sanitizer.push('\u001bPunfinished'), '')
  assert.equal(sanitizer.finish(), '')
  assert.equal(sanitizer.push(']now ordinary text'), ']now ordinary text')

  sanitizer.reset()
  assert.equal(sanitizer.push(`Bearer ${BEARER_CANARY}`), '')
  assert.equal(sanitizer.flush(), '[redacted bearer]')
  assert.equal(sanitizer.push('after reset'), 'after reset')
})

test('oversized controls and redaction candidates fail closed within bounded pending state', () => {
  const control = new IncrementalSanitizer()
  assert.equal(
    control.push(`\u001bP${'x'.repeat(MAX_SANITIZER_CONTROL_BYTES)}${CONTROL_CANARY}`),
    '',
  )
  assert.equal(control.failedClosed, true)
  assert.equal(control.push('after control'), '')
  assert.equal(control.finish(), '')

  const bearer = new IncrementalSanitizer()
  const bearerOutput = `${bearer.push(`Bearer ${'x'.repeat(MAX_SANITIZER_PENDING_BYTES)}${BEARER_CANARY}`)}${bearer.finish()}`
  assert.equal(bearerOutput.includes(BEARER_CANARY), false)

  const url = new IncrementalSanitizer()
  const urlOutput = `${url.push(`https://provider.example/${'x'.repeat(MAX_SANITIZER_PENDING_BYTES)}${URL_CANARY}`)}${url.finish()}`
  assert.equal(urlOutput.includes(URL_CANARY), false)
})

function finalEvent(text: string): RuntimeStreamEvent {
  return {
    type: 'final',
    status: 'completed',
    reason: 'completed',
    text,
    metadata: { tokenUsage: { input: 1, output: 1 } },
    task: { id: 'task-stream-safety', intent: 'stream safety' },
    timestamp: '2026-08-03T00:00:00.000Z',
  }
}

function appFor(
  execution: ExecutionPort,
  journal = new MemoryJournal(new FixedClock()),
): BraidApplication {
  return new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
}

test('provider stream text is sanitized before events, state, subscribers, and replay', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield { type: 'text_delta', text: `A\u001b` }
      yield { type: 'text_delta', text: `]52;c;${CONTROL_CANARY}\u0007B Bearer ` }
      yield {
        type: 'text_delta',
        text: `${BEARER_CANARY} https://provider.example/callback?token=`,
      }
      yield { type: 'text_delta', text: `${URL_CANARY} after` }
      yield finalEvent(
        `A\u001b]52;c;${CONTROL_CANARY}\u0007B Bearer ${BEARER_CANARY} https://provider.example/callback?token=${URL_CANARY} after`,
      )
    },
  }
  const app = appFor(execution, journal)
  const observed: unknown[] = []
  app.subscribe((state, envelope) => observed.push({ state, envelope }))
  app.initialize('/workspace')
  await app.send({ operationId: 'op-stream-safety', text: 'hello' }).completion

  const serialized = JSON.stringify({ state: app.state(), events: app.events(), observed })
  assert.equal(serialized.includes(CONTROL_CANARY), false)
  assert.equal(serialized.includes(BEARER_CANARY), false)
  assert.equal(serialized.includes(URL_CANARY), false)

  const replayed = appFor(execution, journal)
  const replayedSerialized = JSON.stringify({ state: replayed.state(), events: replayed.events() })
  assert.equal(replayedSerialized.includes(CONTROL_CANARY), false)
  assert.equal(replayedSerialized.includes(BEARER_CANARY), false)
  assert.equal(replayedSerialized.includes(URL_CANARY), false)
})

test('a final event without aggregate text flushes the last visible character', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield { type: 'text_delta', text: 'B' }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'completed without aggregate text',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'task-stream-no-final-text', intent: 'stream safety' },
        timestamp: '2026-08-03T00:00:00.000Z',
      }
    },
  }
  const app = appFor(execution)
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-stream-no-final-text', text: 'hello' }).completion

  assert.equal(state.messages.at(-1)?.text, 'B')
})

test('cancellation drops a pending secret instead of journaling it', async () => {
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve
  })
  const execution: ExecutionPort = {
    capabilities: { cancel: true },
    async *streamTurn({ signal }): AsyncIterable<RuntimeStreamEvent> {
      started?.()
      yield { type: 'text_delta', text: `Bearer ${BEARER_CANARY}` }
      await new Promise<void>((resolve) => {
        release = resolve
      })
      if (!signal.aborted) yield finalEvent('unexpected')
    },
    async cancelRun() {
      return { status: 'cancelled' as const }
    },
  }
  const app = appFor(execution)
  app.initialize('/workspace')
  const send = app.send({ operationId: 'op-cancel-stream-safety', text: 'cancel' })
  await startedPromise
  const cancel = app.cancel({ operationId: 'op-cancel-stream-safety-cancel', runId: send.runId })
  const state = await cancel.completion
  release?.()
  await send.completion

  const serialized = JSON.stringify({ state, events: app.events() })
  assert.equal(serialized.includes(BEARER_CANARY), false)
})
