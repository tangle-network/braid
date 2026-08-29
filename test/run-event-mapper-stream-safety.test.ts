import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { buildBraidViewModel } from '../src/adapters/tui/ui-view-model.js'
import { BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { createInteractionRequest } from '../src/app/interaction-request.js'
import { MemoryJournal } from '../src/app/journal.js'
import { providerEventFor } from '../src/app/run-event-mapper.js'
import {
  ApplicationStreamSanitizer,
  MAX_ACTIVE_RUNTIME_STREAMS,
} from '../src/app/run-stream-sanitizer.js'
import { replayEvents } from '../src/domain/reducer.js'
import { redactSensitiveText } from '../src/domain/secret-sanitizer.js'
import { initialState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { DEFAULT_RUN_CAPABILITIES } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'

const CONTROL_CANARY = 'STREAM_CONTROL_CANARY'
const BEARER_CANARY = 'STREAM_BEARER_CANARY'
const ASSIGNMENT_CANARY = 'STREAM_ASSIGNMENT_CANARY'
const URL_CANARY = 'STREAM_URL_CANARY'

const REPLAY_CAPABILITIES = {
  ...DEFAULT_RUN_CAPABILITIES,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, messages: true },
  controls: { cancel: true, steer: true, queue: true, status: true, recreate: true },
  events: { stableIdentity: true, sequence: true, cursor: true },
} as const

function provider(sequence: number) {
  return {
    eventId: `stream-event-${sequence}`,
    providerSequence: sequence,
    receivedAt: '2026-08-28T00:00:00.000Z',
  }
}

function mappedText(
  sanitizer: ApplicationStreamSanitizer,
  runId: string,
  sequence: number,
  text: string,
): string {
  const event = providerEventFor(runId, { type: 'text_delta', text }, provider(sequence), sanitizer)
  assert.equal(event.kind, 'run.text.delta')
  return event.text
}

function streamAtBoundary(value: string, boundary: number): string {
  const sanitizer = new ApplicationStreamSanitizer()
  const runId = `boundary-${boundary}`
  const first = mappedText(sanitizer, runId, 1, value.slice(0, boundary))
  const second = mappedText(sanitizer, runId, 2, value.slice(boundary))
  return `${first}${second}${sanitizer.finish(runId, 'text')}`
}

test('provider interaction identities map to stable local ids without changing response bindings', () => {
  const runId = 'run-provider-interaction'
  const providerInteractionId = `${runId}:interaction:opaque-provider-id`
  const request = createInteractionRequest({
    id: providerInteractionId,
    kind: 'permission',
    title: 'Permission: shell',
    answerSpec: {
      fields: [
        {
          name: 'grant',
          label: 'Decision',
          required: true,
          type: 'select',
          options: [
            { value: 'allow_once', label: 'Allow once' },
            { value: 'deny', label: 'Deny' },
          ],
        },
      ],
    },
    binding: {
      runId,
      provider: 'cli-bridge',
      environmentId: 'environment-provider-interaction',
      sessionId: 'session-provider-interaction',
      executionId: runId,
      interactionId: providerInteractionId,
    },
  })
  const first = providerEventFor(runId, { type: 'interaction', request }, provider(1))
  const replay = providerEventFor(runId, { type: 'interaction', request }, provider(2))
  const cancelled = providerEventFor(
    runId,
    { type: 'interaction.cancel', id: providerInteractionId },
    provider(3),
  )

  assert.equal(first.kind, 'run.interaction')
  assert.equal(replay.kind, 'run.interaction')
  assert.equal(cancelled.kind, 'run.interaction.cancelled')
  assert.match(first.request.id, /^interaction-/u)
  assert.equal(first.request.binding.interactionId, first.request.id)
  assert.equal(first.responseBinding.interactionId, providerInteractionId)
  assert.equal(replay.request.id, first.request.id)
  assert.equal(cancelled.interactionId, first.request.id)
})

test('incremental mapper redaction matches complete redaction at every credential boundary', () => {
  const values = [
    `prefix Bearer ${BEARER_CANARY} suffix`,
    `prefix token=${ASSIGNMENT_CANARY} suffix`,
    `prefix API___key: ${ASSIGNMENT_CANARY} suffix`,
    `prefix client   secret=${ASSIGNMENT_CANARY} suffix`,
    `prefix https://provider.example/callback?token=${URL_CANARY} suffix`,
    `prefix sk-${'c'.repeat(20)} suffix`,
    `prefix github_pat_${'g'.repeat(20)} suffix`,
    `prefix ghp_${'h'.repeat(20)} suffix`,
    `prefix AKIA${'A'.repeat(16)} suffix`,
    `prefix AIza${'Z'.repeat(30)} suffix`,
    `prefix xoxb-${'x'.repeat(20)} suffix`,
  ]
  for (const value of values) {
    const expected = redactSensitiveText(value)
    for (let boundary = 0; boundary <= value.length; boundary += 1) {
      assert.equal(
        streamAtBoundary(value, boundary),
        expected,
        `${value.slice(0, 32)} at ${boundary}`,
      )
    }
  }
})

test('incremental controls remain suppressed across OSC and CSI boundaries, including overflow', () => {
  const sanitizer = new ApplicationStreamSanitizer()
  const runId = 'control-boundary'
  let output = mappedText(sanitizer, runId, 1, `before\u001b]52;c;${CONTROL_CANARY}`)
  output += mappedText(sanitizer, runId, 2, `\u0007after\u001b[31mvisible`)
  output += mappedText(
    sanitizer,
    runId,
    3,
    `\u001bP${'x'.repeat(5_000)}${CONTROL_CANARY}still-hidden`,
  )
  output += mappedText(sanitizer, runId, 4, 'after-overflow')
  output += sanitizer.finish(runId, 'text')
  assert.equal(output.includes(CONTROL_CANARY), false)
  assert.equal(output, 'beforeaftervisible')
})

test('stream finalization preserves pending safe text and resets the run', () => {
  const sanitizer = new ApplicationStreamSanitizer()
  const runId = 'finalize-stream'
  assert.equal(mappedText(sanitizer, runId, 1, 'safe Bearer '), 'safe ')
  assert.equal(mappedText(sanitizer, runId, 2, `${BEARER_CANARY} tail`), '[redacted bearer] tail')
  assert.equal(sanitizer.activeStreamCount, 1)
  assert.equal(sanitizer.finish(runId, 'text'), '')
  sanitizer.reset(runId)
  assert.equal(sanitizer.activeStreamCount, 0)
  assert.equal(mappedText(sanitizer, runId, 1, 'new stream'), 'new stream')
})

test('interleaved streams and application instances never share sanitizer state', () => {
  const first = new ApplicationStreamSanitizer()
  const second = new ApplicationStreamSanitizer()
  const runId = 'same-run-id'
  const firstPrefix = mappedText(first, runId, 1, 'token=')
  const secondBody = mappedText(second, runId, 1, ASSIGNMENT_CANARY)
  const firstBody = mappedText(first, runId, 2, `${ASSIGNMENT_CANARY} tail`)
  assert.equal(firstPrefix, '[redacted secret]')
  assert.equal(secondBody, ASSIGNMENT_CANARY)
  assert.equal(firstBody, ' tail')

  const interleaved = new ApplicationStreamSanitizer()
  const runA = mappedText(interleaved, 'run-a', 1, 'Bearer ')
  const runB = mappedText(interleaved, 'run-b', 1, 'safe output')
  const runATail = mappedText(interleaved, 'run-a', 2, `${BEARER_CANARY} done`)
  assert.equal(`${runA}${runATail}${interleaved.finish('run-a', 'text')}`, '[redacted bearer] done')
  assert.equal(`${runB}${interleaved.finish('run-b', 'text')}`, 'safe output')
})

test('Unicode surrogate pairs survive a chunk boundary without malformed output', () => {
  const sanitizer = new ApplicationStreamSanitizer()
  const runId = 'unicode-boundary'
  const emoji = '👩🏽‍💻'
  const units = [...emoji]
  const first = mappedText(sanitizer, runId, 1, units[0] ?? '')
  const second = mappedText(sanitizer, runId, 2, `${units.slice(1).join('')} after`)
  const output = `${first}${second}${sanitizer.finish(runId, 'text')}`
  assert.equal(output, `${emoji} after`)
  assert.equal([...output].length, [...`${emoji} after`].length)
})

test('long safe streams stay complete while orphaned stream state remains bounded', () => {
  const sanitizer = new ApplicationStreamSanitizer()
  const safe = 'safe output '.repeat(20_000)
  let output = ''
  for (let offset = 0; offset < safe.length; offset += 127) {
    output += mappedText(sanitizer, 'long-safe', offset + 1, safe.slice(offset, offset + 127))
  }
  output += sanitizer.finish('long-safe', 'text')
  assert.equal(output, safe)

  for (let index = 0; index < MAX_ACTIVE_RUNTIME_STREAMS; index += 1)
    mappedText(sanitizer, `orphan-${index}`, 1, 'orphan')
  assert.equal(sanitizer.activeStreamCount, MAX_ACTIVE_RUNTIME_STREAMS)
  assert.equal(mappedText(sanitizer, 'orphan-overflow', 1, 'must not accumulate'), '')
})

test('application ingestion keeps split controls and credentials out of journal, replay, TUI, and headless state', async () => {
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield { type: 'text_delta', text: `A\u001b` }
      yield { type: 'text_delta', text: `]52;c;${CONTROL_CANARY}\u0007B token=` }
      yield { type: 'text_delta', text: `${ASSIGNMENT_CANARY} after` }
      yield {
        type: 'final',
        status: 'completed',
        reason: 'stream safety test',
        text: '',
        metadata: { tokenUsage: { input: 1, output: 1 } },
        task: { id: 'stream-safety-task', intent: 'stream safety test' },
        timestamp: '2026-08-28T00:00:00.000Z',
      }
    },
  }
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-stream-safety', text: 'hello' }).completion
  const view = buildBraidViewModel(state)
  const serialized = JSON.stringify({ state, view, events: app.events() })
  assert.equal(serialized.includes(CONTROL_CANARY), false)
  assert.equal(serialized.includes(ASSIGNMENT_CANARY), false)
  assert.equal(state.messages.at(-1)?.text, 'AB [redacted secret] after')
  assert.equal(buildBraidViewModel(state).messages.at(-1)?.text, 'AB [redacted secret] after')
  const replayed = replayEvents(initialState(DETERMINISTIC_PROFILE), app.events())
  assert.equal(JSON.stringify(replayed).includes(CONTROL_CANARY), false)
  assert.equal(JSON.stringify(replayed).includes(ASSIGNMENT_CANARY), false)
  assert.equal(replayed.messages.at(-1)?.text, 'AB [redacted secret] after')
})

test('disconnect replay continues the same sanitizer state before terminal finalization', async () => {
  let attempts = 0
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      attempts += 1
      yield { type: 'text_delta', text: 'prefix Bearer ' }
      throw new Error('transport disconnected')
    },
    reconnect: (input) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<{
        readonly runId: string
        readonly eventId: string
        readonly sequence: number
        readonly receivedAt: string
        readonly event: RuntimeStreamEvent
      }> {
        yield {
          runId: input.runId,
          eventId: 'replayed-body',
          sequence: 2,
          receivedAt: '2026-08-28T00:00:00.000Z',
          event: { type: 'text_delta', text: `${BEARER_CANARY} suffix` },
        }
        yield {
          runId: input.runId,
          eventId: 'replayed-final',
          sequence: 3,
          receivedAt: '2026-08-28T00:00:00.000Z',
          event: {
            type: 'final',
            status: 'completed',
            reason: 'replayed',
            text: '',
            metadata: { tokenUsage: { input: 1, output: 1 } },
            task: { id: 'replayed-task', intent: 'replayed' },
            timestamp: '2026-08-28T00:00:00.000Z',
          },
        }
      },
    }),
  }
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-stream-replay', text: 'hello' }).completion
  assert.equal(attempts, 1)
  assert.equal(state.messages.at(-1)?.text, `prefix [redacted bearer] suffix`)
  assert.equal(JSON.stringify(app.events()).includes(BEARER_CANARY), false)
})

test('duplicate provider events do not advance stream sanitizer state twice', async () => {
  let release: (() => void) | undefined
  const execution: ExecutionPort = {
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-stream-duplicate', text: 'hello' })
  await receipt.admissionReady
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runId = receipt.runId
  const envelope = {
    runId,
    eventId: 'duplicate-stream-event',
    sequence: 1,
    receivedAt: '2026-08-28T00:00:00.000Z',
    event: { type: 'text_delta' as const, text: 'token=' },
  }
  assert.deepEqual(app.ingestRuntimeEvent(envelope), { accepted: true, duplicate: false })
  assert.deepEqual(app.ingestRuntimeEvent(envelope), { accepted: false, duplicate: true })
  assert.equal(app.events().filter((entry) => entry.event.kind === 'run.text.delta').length, 1)
  release?.()
  app.cancelActive()
  await receipt.completion
})

test('cancellation finalization retains only sanitized pending text', async () => {
  const canary = 'CANCEL_PENDING_CANARY'
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      yield { type: 'text_delta', text: `safe https://example.test/path?token=${canary}` }
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve()
          return
        }
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
  const clock = new FixedClock()
  const journal = new MemoryJournal(clock)
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock,
    ids: new SequenceIds(),
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const receipt = app.send({ operationId: 'op-stream-cancel', text: 'hello' })
  await receipt.admissionReady
  for (let attempt = 0; attempt < 100 && !app.canCancel(); attempt += 1)
    await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(app.canCancel(), true)
  const cancellation = await app.cancelRun({
    operationId: 'op-stream-cancel-control',
    runId: receipt.runId,
    legacy: true,
    terminalStatus: 'aborted',
  })
  await cancellation.completion
  const state = await receipt.completion
  const serialized = JSON.stringify({ state, events: app.events() })
  assert.equal(serialized.includes(canary), false)
  assert.match(state.messages.at(-1)?.text ?? '', /^safe \[redacted link\]/u)
})
