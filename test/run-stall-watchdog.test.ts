import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import {
  DEFAULT_STREAM_IDLE_MS,
  STALLED,
  pumpWithIdleBound,
  withinDeadline,
} from '../src/app/run-stall.js'
import type { BraidEventEnvelope } from '../src/domain/events.js'
import type { RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecutionPort,
  type ProviderRunSnapshot,
} from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'

const IDLE_MS = 40
const CAPABILITIES = {
  ...DEFAULT_RUN_CAPABILITIES,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, messages: true },
  controls: { cancel: true, steer: false, queue: true, status: true, recreate: false },
  events: { stableIdentity: true, sequence: true, cursor: true },
} as const

const NEVER = new Promise<never>(() => undefined)

function text(runId: string, sequence: number, value: string): RuntimeEventEnvelope {
  return {
    runId,
    eventId: `${runId}:event-${sequence}`,
    sequence,
    cursor: `cursor-${sequence}`,
    receivedAt: '2026-08-01T00:00:00.000Z',
    event: { type: 'text_delta', text: value },
  }
}

function final(runId: string, sequence: number, value: string): RuntimeEventEnvelope {
  const event: RuntimeStreamEvent = {
    type: 'final',
    status: 'completed',
    reason: 'complete',
    text: value,
    task: { id: 'task-stall', intent: 'test' },
    timestamp: '2026-08-01T00:00:00.000Z',
  }
  return {
    runId,
    eventId: `${runId}:event-${sequence}`,
    sequence,
    cursor: `cursor-${sequence}`,
    receivedAt: '2026-08-01T00:00:00.000Z',
    event,
  }
}

async function* from(
  items: readonly RuntimeEventEnvelope[],
  then?: 'hang',
): AsyncGenerator<RuntimeEventEnvelope> {
  for (const item of items) yield item
  if (then === 'hang') await NEVER
}

interface Probe {
  readonly after: Array<string | undefined>
  readonly afterSequence: Array<number | undefined>
  statusCalls: number
}

function harness(options: {
  readonly stream: (runId: string) => AsyncIterable<RuntimeEventEnvelope>
  readonly reconnect?: (runId: string, attempt: number) => AsyncIterable<RuntimeEventEnvelope>
  readonly status?: (runId: string, call: number) => Promise<ProviderRunSnapshot | null>
  readonly journal?: MemoryJournal
  readonly detach?: () => void
}): { app: BraidApplication; probe: Probe } {
  const probe: Probe = { after: [], afterSequence: [], statusCalls: 0 }
  let attempts = 0
  const execution: ExecutionPort = {
    streamIdleMs: IDLE_MS,
    statusTimeoutMs: IDLE_MS,
    capabilities: () => CAPABILITIES,
    admit: () => ({ capabilities: CAPABILITIES, providerSessionId: 'session-stall' }),
    streamTurn: (input) => options.stream(input.runId),
    detachRun: async (input) => {
      options.detach?.()
      return { operationId: input.operationId, outcome: 'accepted' }
    },
    status: async (input) => {
      probe.statusCalls += 1
      if (options.status === undefined) return null
      return options.status(input.runId, probe.statusCalls)
    },
    reconnect: (input) => {
      probe.after.push(input.after)
      probe.afterSequence.push(input.afterSequence)
      attempts += 1
      return (options.reconnect ?? (() => from([])))(input.runId, attempts)
    },
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    ...(options.journal === undefined ? {} : { journal: options.journal }),
  })
  app.initialize('/workspace')
  return { app, probe }
}

const live = (runId: string): ProviderRunSnapshot => ({
  runId,
  sessionId: 'session-stall',
  status: 'streaming',
})

function kinds(app: BraidApplication, kind: string): BraidEventEnvelope[] {
  return app.events().filter((entry) => entry.event.kind === kind)
}

function timeouts(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length
}

test('idle bound sits below the 8 minute runtime observation limit', () => {
  assert.ok(DEFAULT_STREAM_IDLE_MS < 8 * 60_000)
  assert.ok(DEFAULT_STREAM_IDLE_MS + 15_000 < 120_000)
})

test('withinDeadline and the pump leave no timer behind', async () => {
  const before = timeouts()
  assert.equal(await withinDeadline(Promise.resolve(1), 1_000), 1)
  assert.equal(await withinDeadline(NEVER, 5), STALLED)
  const seen: number[] = []
  const ended = await pumpWithIdleBound(
    (async function* () {
      yield 1
      yield 2
    })(),
    1_000,
    () => true,
    (item) => {
      seen.push(item)
      return 'continue'
    },
  )
  assert.equal(ended, 'ended')
  assert.deepEqual(seen, [1, 2])
  assert.equal(
    await pumpWithIdleBound(
      (async function* () {
        yield 1
        await NEVER
      })(),
      5,
      () => true,
      () => 'continue',
    ),
    'stalled',
  )
  assert.equal(
    await pumpWithIdleBound(
      (async function* () {
        yield 1
      })(),
      5,
      () => true,
      () => NEVER,
    ),
    'stalled',
  )
  assert.equal(timeouts(), before)
})

test('the bound is not armed before the first event', async () => {
  const { app } = harness({
    stream: async function* (runId) {
      await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 3))
      yield final(runId, 1, 'slow start')
    },
  })
  const state = await app.send({ operationId: 'op-slow-start', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(kinds(app, 'run.reconnecting').length, 0)
})

test('a stream that hangs after two events reconnects from its cursor and finishes once', async () => {
  const { app, probe } = harness({
    stream: (runId) => from([text(runId, 1, 'one '), text(runId, 2, 'two ')], 'hang'),
    status: async (runId) => live(runId),
    reconnect: (runId) => from([text(runId, 3, 'three '), final(runId, 4, 'one two three four')]),
  })
  const send = app.send({ operationId: 'op-hang', text: 'go' })
  const state = await send.completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.deepEqual(probe.after, ['cursor-2'])
  assert.equal(probe.statusCalls, 1)
  assert.equal(kinds(app, 'run.finished').length, 1)
  const reconnecting = kinds(app, 'run.reconnecting')
  assert.equal(reconnecting.length, 1)
  const detail = (reconnecting[0]?.event as { detail?: string }).detail
  assert.match(detail ?? '', /no provider events for \d+ seconds/)
  assert.equal(state.messages[1]?.text, 'one two three four')
  assert.equal(state.messages[1]?.complete, true)
})

test('replayed duplicate events add no part, usage or terminal', async () => {
  const { app } = harness({
    stream: (runId) => from([text(runId, 1, 'a'), text(runId, 2, 'b')], 'hang'),
    status: async (runId) => live(runId),
    reconnect: (runId) =>
      from([
        text(runId, 1, 'a'),
        text(runId, 2, 'b'),
        text(runId, 3, 'c'),
        final(runId, 4, 'abc'),
        final(runId, 4, 'abc'),
      ]),
  })
  const state = await app.send({ operationId: 'op-dup', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(kinds(app, 'run.finished').length, 1)
  assert.equal(kinds(app, 'run.text.delta').length, 3)
  assert.equal(state.messages[1]?.text, 'abc')
})

test('a provider that already finished replays its final result', async () => {
  const { app, probe } = harness({
    stream: (runId) => from([text(runId, 1, 'x')], 'hang'),
    status: async (runId) => ({ runId, sessionId: 'session-stall', status: 'completed' }),
    reconnect: (runId) => from([final(runId, 2, 'x done')]),
  })
  const state = await app.send({ operationId: 'op-ended', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(state.messages[1]?.text, 'x done')
  assert.equal(probe.statusCalls, 1)
  assert.equal(kinds(app, 'run.finished').length, 1)
})

test('a stopped sandbox ends as unknown with a plain detail and no retry', async () => {
  const { app, probe } = harness({
    stream: (runId) => from([text(runId, 1, 'x')], 'hang'),
    status: async () => {
      throw new Error('sandbox stopped')
    },
  })
  const state = await app.send({ operationId: 'op-stopped', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'unknown')
  const unknown = kinds(app, 'run.unknown').at(-1)?.event as { detail: string }
  assert.equal(unknown.detail, 'provider stream lost; sandbox stopped')
  assert.equal(probe.after.length, 0)
  assert.equal(probe.statusCalls, 1)
  assert.equal(state.lastError, 'provider stream lost; sandbox stopped')
})

test('a status read that never answers counts as a lost provider', async () => {
  const { app, probe } = harness({
    stream: (runId) => from([text(runId, 1, 'x')], 'hang'),
    status: () => NEVER,
  })
  const state = await app.send({ operationId: 'op-status-hang', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'unknown')
  assert.match(
    (kinds(app, 'run.unknown').at(-1)?.event as { detail: string }).detail,
    /provider stream lost; the status read timed out/,
  )
  assert.equal(probe.after.length, 0)
})

test('a quiet but running provider keeps replaying and is never marked unknown', async () => {
  const { app, probe } = harness({
    stream: (runId) => from([text(runId, 1, 'start ')], 'hang'),
    status: async (runId) => live(runId),
    reconnect: (runId, attempt) =>
      attempt < 3
        ? from([], 'hang')
        : from([text(runId, 2, 'tool output '), final(runId, 3, 'start tool output')]),
  })
  const state = await app.send({ operationId: 'op-quiet', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(kinds(app, 'run.unknown').length, 0)
  assert.equal(probe.statusCalls, 3)
  assert.deepEqual(probe.after, ['cursor-1', 'cursor-1', 'cursor-1'])
  assert.equal(kinds(app, 'run.finished').length, 1)
})

test('a replay that stalls after the provider died ends as unknown', async () => {
  const { app } = harness({
    stream: (runId) => from([text(runId, 1, 'x')], 'hang'),
    status: async (runId, call) => {
      if (call === 1) return live(runId)
      throw new Error('sandbox deleted')
    },
    reconnect: () => from([], 'hang'),
  })
  const state = await app.send({ operationId: 'op-replay-lost', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'unknown')
  assert.equal(
    (kinds(app, 'run.unknown').at(-1)?.event as { detail: string }).detail,
    'provider stream lost; sandbox deleted',
  )
})

test('a terminal provider whose replay stalls twice finishes from its status read', async () => {
  const { app } = harness({
    stream: (runId) => from([text(runId, 1, 'x')], 'hang'),
    status: async (runId) => ({
      runId,
      sessionId: 'session-stall',
      status: 'completed',
      finalText: 'from status',
    }),
    reconnect: () => from([], 'hang'),
  })
  const state = await app.send({ operationId: 'op-terminal-stall', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(kinds(app, 'run.finished').length, 1)
})

test('cancel during a stall finishes the run and leaks no timer', async () => {
  const before = timeouts()
  const { app, probe } = harness({
    stream: (runId) => from([text(runId, 1, 'x')], 'hang'),
    status: async (runId) => live(runId),
  })
  const send = app.send({ operationId: 'op-cancel-stall', text: 'go' })
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS / 4))
  app.cancel({ operationId: 'op-cancel-stall-cancel', runId: send.runId })
  const state = await send.completion
  assert.ok(['cancelled', 'aborted', 'unknown'].includes(state.runs[0]?.status ?? ''))
  assert.equal(probe.after.length, 0)
  assert.equal(kinds(app, 'run.finished').length + kinds(app, 'run.unknown').length >= 1, true)
  await app.close()
  assert.equal(timeouts(), before)
})

test('detach during a stall does not reconnect', async () => {
  let release: (() => void) | undefined
  const { app, probe } = harness({
    stream: async function* (runId) {
      yield text(runId, 1, 'x')
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await NEVER
    },
    status: async (runId) => live(runId),
    detach: () => release?.(),
  })
  const send = app.send({ operationId: 'op-detach-stall', text: 'go' })
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS / 4))
  const detached = await app.detachRun({ operationId: 'op-detach-stall-control', runId: send.runId })
  await detached.completion
  await send.completion
  assert.equal(probe.after.length, 0)
  assert.equal(app.state().runs[0]?.status, 'detached')
})

test('an ingest slower than the deadline does not hold the turn open', async () => {
  const inner = new MemoryJournal(new FixedClock())
  let slowed = false
  const journal = Object.assign(Object.create(inner) as MemoryJournal, {
    asynchronous: true,
    append: async (envelope: BraidEventEnvelope) => {
      if (
        !slowed &&
        envelope.event.kind === 'run.text.delta' &&
        envelope.event.provider?.providerSequence === 2
      ) {
        slowed = true
        await new Promise((resolve) => setTimeout(resolve, IDLE_MS * 3))
      }
      return inner.append(envelope)
    },
  })
  const { app, probe } = harness({
    journal,
    stream: (runId) => from([text(runId, 1, 'a'), text(runId, 2, 'b')], 'hang'),
    status: async (runId) => live(runId),
    reconnect: (runId) => from([text(runId, 2, 'b'), final(runId, 3, 'ab')]),
  })
  const state = await app.send({ operationId: 'op-slow-ingest', text: 'go' }).completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(probe.statusCalls, 1)
  assert.equal(kinds(app, 'run.finished').length, 1)
  assert.equal(state.messages[1]?.text, 'ab')
})

test('after restart the saved cursor replays and the status never regresses', async () => {
  const sourceJournal = new MemoryJournal(new FixedClock())
  const first = harness({
    journal: sourceJournal,
    stream: (runId) => from([text(runId, 1, 'before '), text(runId, 2, 'restart ')], 'hang'),
    status: async () => {
      throw new Error('sandbox stopped')
    },
  })
  const send = first.app.send({ operationId: 'op-restart-stall', text: 'go' })
  await send.completion
  assert.equal(first.app.state().runs[0]?.status, 'unknown')

  const restartedJournal = new MemoryJournal(new FixedClock())
  for (const envelope of sourceJournal.all()) restartedJournal.append(envelope)
  const restarted = harness({
    journal: restartedJournal,
    stream: () => from([]),
    status: async (runId) => live(runId),
    reconnect: (runId) => from([text(runId, 2, 'restart '), final(runId, 3, 'before restart after')]),
  })
  const statuses: string[] = []
  restarted.app.subscribe(() => {
    const status = restarted.app.state().runs[0]?.status
    if (status !== undefined && statuses.at(-1) !== status) statuses.push(status)
  })
  const recovered = await restarted.app.reconnectRun({
    operationId: 'op-restart-stall-reconnect',
    runId: send.runId,
  })
  assert.equal(recovered.runs[0]?.status, 'completed')
  assert.deepEqual(restarted.probe.after, ['cursor-2'])
  assert.equal(
    statuses.indexOf('completed') >= 0 && statuses.slice(statuses.indexOf('completed')).length === 1,
    true,
  )
  assert.equal(kinds(restarted.app, 'run.finished').length, 1)
})
