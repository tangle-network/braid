import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { AppError, BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { buildAppView } from '../src/app/view-model.js'
import { createPortableContextPlan } from '../src/domain/receipts.js'
import type { RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import type { BraidState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { runtimeContractEnvelopes } from '../src/testing/runtime-contract-fixtures.js'

const REPLAY_CAPABILITIES = {
  ...DEFAULT_RUN_CAPABILITIES,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, messages: true },
  controls: { cancel: true, steer: true, queue: true, status: true, recreate: true },
  events: { stableIdentity: true, sequence: true, cursor: true },
} as const

function finalEvent(text: string): RuntimeStreamEvent {
  return {
    type: 'final',
    status: 'completed',
    reason: 'complete',
    text,
    task: { id: 'task-test', intent: 'test' },
    timestamp: '2026-08-01T00:00:00.000Z',
  }
}

function failedAsyncIterable<T>(error: unknown): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: async () => Promise.reject(error),
      }
    },
  }
}

function emptyAsyncIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: async () => ({ done: true, value: undefined }),
      }
    },
  }
}

function appFor(execution: ExecutionPort, journal?: MemoryJournal): BraidApplication {
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
    ...(journal === undefined ? {} : { journal }),
  })
  app.initialize('/workspace')
  return app
}

function finalExecution(text = 'done', capabilities = DEFAULT_RUN_CAPABILITIES): ExecutionPort {
  return {
    capabilities: () => capabilities,
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield finalEvent(text)
    },
  }
}

test('admission receipt binds portable context and is deeply immutable', async () => {
  const plan = createPortableContextPlan({
    sourceRunId: 'run-source',
    sourceBoundary: 'cursor-source',
    destinationRunner: 'pi',
    messages: [
      {
        id: 'message-source',
        role: 'user',
        parts: [{ id: 'part-source', type: 'text', text: 'prior' }],
      },
    ],
    transformedPartIds: ['part-source'],
  })
  const app = appFor(finalExecution())
  const receipt = app.send({
    operationId: 'op-context',
    text: 'next',
    contextPlan: plan,
    contextTransfer: {
      planDigest: plan.digest,
      sourceRunId: 'run-source',
      destinationRunId: 'run-000001',
      acceptedAt: '2026-08-01T00:00:00.000Z',
    },
  })
  await receipt.completion

  assert.equal(receipt.admission.requested.contextPlanDigest, plan.digest)
  assert.equal(receipt.admission.contextTransfer?.destinationRunId, receipt.runId)
  assert.equal(Object.isFrozen(receipt.admission), true)
  assert.equal(Object.isFrozen(receipt.admission.requested), true)
  assert.equal(Object.isFrozen(receipt.admission.capabilities), true)
  assert.equal(Object.isFrozen(plan.messages), true)
})

test('contract fixtures preserve parts, tools, reasoning, artifacts, proposals, warnings, usage, cost, and interactions', async () => {
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    async *streamTurn(): AsyncIterable<RuntimeEventEnvelope> {
      yield* runtimeContractEnvelopes('run-000001')
    },
  }
  const app = appFor(execution)
  const state = await app.send({ operationId: 'op-contract', text: 'inspect' }).completion
  const assistant = state.messages.find((message) => message.role === 'assistant')
  const run = state.runs[0]

  assert.ok(assistant)
  assert.ok(run)
  assert.deepEqual(
    assistant.parts.map((part) => part.kind),
    ['text', 'reasoning', 'tool-result', 'artifact', 'proposal', 'warning'],
  )
  assert.deepEqual(assistant.parts[2]?.input, { path: 'README.md' })
  assert.equal(assistant.parts[1]?.status, 'complete')
  assert.equal(assistant.parts[2]?.status, 'complete')
  assert.equal(run.inputTokens, 3)
  assert.equal(run.outputTokens, 4)
  assert.equal(run.costUsd, 0.01)
  assert.equal(run.interactions[0]?.request.id, 'interaction-1')
  assert.equal(run.eventDetails.length, 0)
  assert.equal(new Set(app.events().flatMap((envelope) => envelope.event.kind)).size > 1, true)
})

test('duplicate ingestion does not duplicate a part and a sequence gap waits for replay', async () => {
  let release: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      yield { type: 'text_delta', text: 'A' }
      await new Promise<void>((resolve) => {
        release = resolve
        if (input.signal.aborted) resolve()
        else input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
  const app = appFor(execution)
  const receipt = app.send({ operationId: 'op-gap', text: 'gap' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const first = app.events().find((envelope) => envelope.event.kind === 'run.text.delta')
  assert.ok(first?.event.kind === 'run.text.delta' && first.event.provider)

  const duplicate = app.ingestRuntimeEvent({
    runId: receipt.runId,
    eventId: first.event.provider.eventId,
    sequence: first.event.provider.providerSequence,
    receivedAt: '2026-08-01T00:00:00.000Z',
    event: { type: 'text_delta', text: 'A' },
  })
  assert.deepEqual(duplicate, { accepted: false, duplicate: true })

  const gap = app.ingestRuntimeEvent({
    runId: receipt.runId,
    eventId: 'provider-4',
    sequence: 4,
    receivedAt: '2026-08-01T00:00:00.000Z',
    event: { type: 'text_delta', text: 'D' },
  })
  assert.deepEqual(gap, { accepted: false, duplicate: false, sequenceGap: { from: 2, to: 3 } })
  for (const [sequence, text] of [
    [2, 'B'],
    [3, 'C'],
    [4, 'D'],
  ] as const) {
    const result = app.ingestRuntimeEvent({
      runId: receipt.runId,
      eventId: `provider-${sequence}`,
      sequence,
      receivedAt: '2026-08-01T00:00:00.000Z',
      event: { type: 'text_delta', text },
    })
    assert.equal(result.accepted, true)
  }
  assert.equal(app.state().messages[1]?.text, 'ABCD')
  assert.equal(app.state().runs[0]?.eventCount, 4)
  release?.()
  app.cancelActive()
  await receipt.completion
})

test('a disconnected live iterator reconnects and replays before declaring an unknown run', async () => {
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield { type: 'text_delta', text: 'before disconnect' }
      throw new Error('transport disconnected')
    },
    reconnect: (input) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEventEnvelope> {
        yield {
          runId: input.runId,
          eventId: 'replayed-terminal',
          sequence: 2,
          cursor: 'cursor-2',
          receivedAt: '2026-08-01T00:00:00.000Z',
          event: finalEvent('after replay'),
        }
      },
    }),
  }
  const app = appFor(execution)
  const state = await app.send({ operationId: 'op-disconnect', text: 'reconnect me' }).completion
  assert.equal(state.runs[0]?.status, 'completed')
  assert.equal(state.messages[1]?.text, 'after replay')
})

test('failed dispatch preserves its diagnostic when recovery finds no provider run', async () => {
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    streamTurn: () =>
      failedAsyncIterable(
        Object.assign(new Error('[{"unrecognized":"runControlRef"}]'), {
          code: 'SIDECAR_SCHEMA_REJECTED',
        }),
      ),
    reconnect: () => emptyAsyncIterable(),
    status: async () => null,
  }
  const app = appFor(execution)

  const state = await app.send({ operationId: 'op-failed-dispatch', text: 'start once' }).completion

  assert.equal(state.runs[0]?.status, 'unknown')
  assert.equal(state.lastError, 'SIDECAR_SCHEMA_REJECTED')
  const unknown = app
    .events()
    .filter((entry) => entry.event.kind === 'run.unknown')
    .at(-1)?.event
  if (unknown?.kind !== 'run.unknown') throw new Error('Missing run.unknown event')
  assert.equal(unknown.detail, 'SIDECAR_SCHEMA_REJECTED')
})

test('failed dispatch preserves its typed diagnostic when exact status is unavailable', async () => {
  const execution: ExecutionPort = {
    capabilities: () => ({
      ...REPLAY_CAPABILITIES,
      controls: { ...REPLAY_CAPABILITIES.controls, status: false },
    }),
    streamTurn: () =>
      failedAsyncIterable(
        Object.assign(new Error('permanent cloud provisioning rejection'), {
          code: 'CLOUD_PROVISION_REJECTED',
        }),
      ),
    reconnect: () => emptyAsyncIterable(),
  }
  const app = appFor(execution)

  const state = await app.send({ operationId: 'op-no-status', text: 'start once' }).completion

  assert.equal(state.runs[0]?.status, 'unknown')
  assert.equal(state.lastError, 'CLOUD_PROVISION_REJECTED')
})

test('explicit cancellation is acknowledged and reaches cancelled, while legacy abort remains distinct', async () => {
  let release: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>((resolve) => {
        release = resolve
        input.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
    cancelRun: async (input) => {
      release?.()
      return { operationId: input.operationId, outcome: 'accepted' }
    },
  }
  const app = appFor(execution)
  const send = app.send({ operationId: 'op-cancel-explicit', text: 'stop' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const control = await app.cancelRun({ operationId: 'op-cancel', runId: send.runId })
  const state = await control.completion
  assert.equal(control.acknowledgement.outcome, 'accepted')
  assert.equal(state.runs[0]?.status, 'cancelled')
})

test('queued input is durable and drains after the active run terminates', async () => {
  let call = 0
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      call += 1
      if (call === 1) {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        return
      }
      yield finalEvent('queued result')
    },
  }
  const app = appFor(execution)
  const first = app.send({ operationId: 'op-queue-first', text: 'first' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const queued = app.queueInput({ operationId: 'op-queue-next', runId: first.runId, text: 'next' })
  const queuedAgain = app.queueInput({
    operationId: 'op-queue-last',
    runId: first.runId,
    text: 'last',
  })
  assert.equal(queued.position, 1)
  assert.equal(queuedAgain.position, 2)
  app.cancelActive()
  await first.completion
  await app.waitForIdle()
  assert.equal(app.state().queuedInputs.length, 0)
  assert.equal(app.state().runs[1]?.status, 'completed')
})

test('journal restart replays the committed run exactly once', async () => {
  const journal = new MemoryJournal(new FixedClock())
  const first = appFor(finalExecution('restart'), journal)
  const firstState = await first.send({ operationId: 'op-restart', text: 'persist' }).completion
  const second = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution: finalExecution('unused'),
    clock: new FixedClock(),
    ids: new SequenceIds(),
    journal,
  })
  const secondState = second.state()
  assert.deepEqual(secondState, firstState)
  assert.equal(second.events().length, first.events().length)
  assert.equal(secondState.messages.filter((message) => message.role === 'assistant').length, 1)
})

test('status reconciliation never regresses a committed terminal run from a stale provider snapshot', async () => {
  let polls = 0
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield finalEvent('terminal')
    },
    status: async (input) => {
      polls += 1
      if (polls === 1) return { runId: input.runId, status: 'running' }
      throw new Error('stale status transport')
    },
  }
  const app = appFor(execution)
  const receipt = app.send({ operationId: 'op-stale-status', text: 'reconcile' })
  await receipt.completion
  await app.reconcileRun({ operationId: 'op-reconcile', runId: receipt.runId })
  await app.reconcileRun({ operationId: 'op-reconcile-error', runId: receipt.runId })
  assert.equal(app.state().runs[0]?.status, 'completed')
})

test('native continuation requires and records a matching provider boundary proof', async () => {
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    admit: () => ({ capabilities: REPLAY_CAPABILITIES, providerSessionId: 'session-native' }),
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield finalEvent('native')
    },
    nativeBoundary: async (input) => ({
      boundary: 'boundary-native',
      digest: `${input.sessionId}:proof`,
    }),
  }
  const app = appFor(execution)
  const first = await app.send({ operationId: 'op-native-first', text: 'first' }).completion
  assert.equal(first.runs[0]?.providerSessionId, 'session-native')
  assert.throws(
    () =>
      app.send({
        operationId: 'op-native-forged',
        text: 'forged',
        sessionId: 'session-other',
        nativeContextBoundaryProof: {
          runId: first.runs[0]?.id ?? '',
          providerSessionId: 'session-other',
          boundary: 'boundary-native',
          digest: 'forged-proof',
        },
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'NATIVE_CONTINUATION_UNVERIFIED',
  )
  const continued = await app.continueNative({
    operationId: 'op-native-next',
    runId: first.runs[0]?.id,
    text: 'continue',
  })
  const state = await continued.completion
  assert.equal(continued.admission.nativeContextBoundaryProof?.boundary, 'boundary-native')
  assert.equal(state.runs.length, 2)
  assert.equal(state.runs[1]?.status, 'completed')
})

test('metadata-only profile changes cannot reuse an admitted provider session', async () => {
  const firstProfile = defineAgentProfile({
    name: 'metadata-bound-profile',
    harness: 'pi',
    model: { default: 'openai/gpt-5.6-luna', metadata: { route: 'primary' } },
  })
  const secondProfile = defineAgentProfile({
    name: 'metadata-bound-profile',
    harness: 'pi',
    model: { default: 'openai/gpt-5.6-luna', metadata: { route: 'fallback' } },
  })
  const dispatchedSessions: Array<string | undefined> = []
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    admit: () => ({ capabilities: REPLAY_CAPABILITIES, providerSessionId: 'session-bound' }),
    async *streamTurn(input): AsyncIterable<RuntimeStreamEvent> {
      dispatchedSessions.push(input.sessionId)
      yield finalEvent('metadata binding')
    },
  }
  const app = new BraidApplication({
    profile: firstProfile,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  const first = app.send({ operationId: 'op-metadata-first', text: 'first' })
  await first.completion

  app.runtimeSelection.setProfile(secondProfile)
  const second = app.send({ operationId: 'op-metadata-second', text: 'second' })
  await second.completion

  assert.deepEqual(first.admission.requested.profile, second.admission.requested.profile)
  assert.notEqual(first.admission.profileDigest, second.admission.profileDigest)
  assert.deepEqual(dispatchedSessions, [undefined, undefined])
})

test('detach stops the iterator and reconnect resumes the same run', async () => {
  let release: (() => void) | undefined
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
    detachRun: async (input) => {
      release?.()
      return { operationId: input.operationId, outcome: 'accepted' }
    },
    reconnect: (input) => ({
      async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEventEnvelope> {
        yield {
          runId: input.runId,
          eventId: 'replayed-final',
          sequence: 1,
          cursor: 'cursor-final',
          receivedAt: '2026-08-01T00:00:00.000Z',
          event: finalEvent('reconnected'),
        }
      },
    }),
  }
  const app = appFor(execution)
  const send = app.send({ operationId: 'op-detach', text: 'background' })
  const detached = await app.detachRun({ operationId: 'op-detach-control', runId: send.runId })
  assert.equal((await detached.completion).runs[0]?.status, 'detached')
  const reconnected = await app.reconnectRun({ operationId: 'op-reconnect', runId: send.runId })
  assert.equal(reconnected.runs[0]?.status, 'completed')
  assert.equal(reconnected.messages[1]?.text, 'reconnected')
})

test('restart keeps a replayable run reconnecting until replay proves its outcome', async () => {
  let markStreamStarted!: () => void
  const streamStarted = new Promise<void>((resolve) => {
    markStreamStarted = resolve
  })
  let releaseStream!: () => void
  const heldStream = new Promise<void>((resolve) => {
    releaseStream = resolve
  })
  const sourceJournal = new MemoryJournal(new FixedClock())
  const first = appFor(
    {
      capabilities: () => REPLAY_CAPABILITIES,
      admit: () => ({
        capabilities: REPLAY_CAPABILITIES,
        providerSessionId: 'session-restart-replay',
      }),
      async *streamTurn(input): AsyncIterable<RuntimeStreamEvent | RuntimeEventEnvelope> {
        yield {
          runId: input.runId,
          eventId: 'event-before-restart',
          sequence: 1,
          cursor: 'cursor-before-restart',
          receivedAt: '2026-08-01T00:00:00.000Z',
          event: { type: 'text_delta', text: 'before restart' },
        }
        markStreamStarted()
        await heldStream
      },
    },
    sourceJournal,
  )
  const send = first.send({ operationId: 'op-restart-replay', text: 'survive restart' })
  await send.admissionReady
  await streamStarted

  const restartedJournal = new MemoryJournal(new FixedClock())
  for (const envelope of sourceJournal.all()) restartedJournal.append(envelope)
  let statusCalls = 0
  let reconnectCalls = 0
  const restarted = appFor(
    {
      capabilities: () => REPLAY_CAPABILITIES,
      async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {},
      async status(input) {
        statusCalls += 1
        return {
          runId: input.runId,
          sessionId: 'session-restart-replay',
          status: 'unknown',
          detail: 'The retained execution has not produced an attributable status yet',
        }
      },
      reconnect: (input) => ({
        async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEventEnvelope> {
          reconnectCalls += 1
          yield {
            runId: input.runId,
            eventId: 'event-restart-replay-final',
            sequence: 2,
            cursor: 'cursor-restart-replay-final',
            receivedAt: '2026-08-01T00:00:00.000Z',
            event: finalEvent('survived restart replay'),
          }
        },
      }),
    },
    restartedJournal,
  )

  await restarted.whenDurable()
  assert.equal(statusCalls, 1)
  assert.equal(restarted.state().runs[0]?.status, 'reconnecting')
  assert.equal(
    restarted
      .events()
      .some((entry) => entry.event.kind === 'run.finished' && entry.event.status === 'unknown'),
    false,
  )
  assert.equal(
    restarted.events().some((entry) => entry.event.kind === 'run.unknown'),
    false,
  )

  const recovered = await restarted.reconnectRun({
    operationId: 'op-restart-replay-reconnect',
    runId: send.runId,
  })
  assert.equal(reconnectCalls, 1)
  assert.equal(recovered.runs[0]?.status, 'completed')
  assert.equal(recovered.messages[1]?.text, 'survived restart replay')

  releaseStream()
  await send.completion
  await first.close()
  await restarted.close()
})

test('reconnect leaves a proven terminal run immutable', async () => {
  let reconnectCalls = 0
  const execution: ExecutionPort = {
    capabilities: () => REPLAY_CAPABILITIES,
    async *streamTurn(): AsyncIterable<RuntimeStreamEvent> {
      yield finalEvent('completed')
    },
    reconnect: () => {
      reconnectCalls += 1
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<RuntimeEventEnvelope> {
          yield {
            runId: 'run-unused',
            eventId: 'event-unused',
            sequence: 1,
            receivedAt: '2026-08-01T00:00:00.000Z',
            event: finalEvent('unexpected'),
          }
        },
      }
    },
  }
  const app = appFor(execution)
  const send = app.send({ operationId: 'op-terminal', text: 'finish' })
  const terminal = await send.completion
  const before = terminal.runs.find((run) => run.id === send.runId)

  const reconnected = await app.reconnectRun({
    operationId: 'op-terminal-reconnect',
    runId: send.runId,
  })

  assert.deepEqual(
    reconnected.runs.find((run) => run.id === send.runId),
    before,
  )
  assert.equal(reconnectCalls, 0)
})

for (const count of [10_000, 100_000]) {
  test(`${count.toLocaleString()} message transcript stays bounded at the view boundary`, () => {
    const messages = Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`,
      role: 'assistant' as const,
      text: `message ${index}`,
      status: 'complete' as const,
      parts: [{ id: `part-${index}`, kind: 'text' as const, text: `message ${index}` }],
    }))
    const state: BraidState = {
      ...({} as BraidState),
      revision: count,
      sequence: count,
      schemaVersion: 2,
      workspace: '/workspace',
      conversationId: 'conv-1',
      branchId: 'branch-1',
      profile: DETERMINISTIC_PROFILE,
      draft: '',
      messages: messages as unknown as BraidState['messages'],
      runs: [],
      activeRunId: null,
      queuedInputs: [],
      lastError: null,
    }
    const view = buildAppView(state)
    assert.equal(view.messages.length, 200)
    assert.equal(view.hiddenMessageCount, count - 200)
    assert.equal(view.messages[0]?.id, `message-${count - 200}`)
  })
}
