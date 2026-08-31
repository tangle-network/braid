import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AgentInteractiveSessionRef,
  AgentInteractiveSessionStart,
  AgentProfile,
} from '@tangle-network/agent-interface'
import {
  AgentInteractiveSessionRefSchema,
  canonicalCandidateDigest,
} from '@tangle-network/agent-interface'
import type {
  AgentEnvironment,
  AgentEnvironmentCapabilities,
  AgentEnvironmentProvider,
} from '@tangle-network/agent-interface/environment-provider'
import type { RetainedInteractiveAdmission } from '@tangle-network/agent-runtime/kernel'
import { ModeRoutingExecutionPort } from '../src/adapters/runtime/mode-routing-execution.js'
import { NativeInteractiveRunBroker } from '../src/adapters/runtime/native-interactive-run-broker.js'
import {
  safeExecutionId,
  stableProviderId,
} from '../src/adapters/runtime/production-backend-common.js'
import type { PreparedTangleRetainedConnection } from '../src/adapters/runtime/production-tangle-sandbox-backend.js'
import {
  assertInteractiveProvider,
  interactiveEnvironment,
} from '../src/adapters/runtime/tangle-retained-interactive-contract.js'
import { TangleRetainedInteractiveExecutionPort } from '../src/adapters/runtime/tangle-retained-interactive-execution.js'
import type { RunAdmissionReceipt } from '../src/domain/receipts.js'
import type { RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import type { ExecuteTurnInput, ExecutionPort } from '../src/ports/execution.js'

const PROFILE: AgentProfile = {
  name: 'Braid interactive test',
  harness: 'pi',
  model: { default: 'test-model', provider: 'test-provider' },
}

test('the broker reports typed settlement outcomes', () => {
  const broker = new NativeInteractiveRunBroker()
  assert.equal(broker.settle('missing', { kind: 'detached' }), 'absent')

  const lease = broker.open('run/broker')
  assert.equal(broker.settle('run/broker', { kind: 'detached' }), 'settled')
  assert.equal(broker.settle('run/broker', { kind: 'detached' }), 'already-settled')
  lease.close()
})

test('mode routing is async when either branch is async and honors canonical interactive admissions', async () => {
  const calls: string[] = []
  const headless = routingPort('headless', 'sync', calls)
  const interactive = routingPort('interactive', 'async', calls)
  const router = new ModeRoutingExecutionPort({ headless, interactive })

  assert.equal(router.admissionMode, 'async')
  await collect(router.streamTurn(input('run/interactive', { mode: 'interactive' })))
  await router.status({
    runId: 'run/recovered',
    retainedAdmission: { phase: 'interactive_intent' },
  } as never)
  await router.cancelRun({
    runId: 'run/recovered-control',
    operationId: 'operation-recovered-control',
    retainedAdmission: { phase: 'interactive_started' },
  } as never)
  await collect(router.streamTurn(input('run/headless', { mode: 'headless' })))

  assert.deepEqual(calls, [
    'interactive:stream',
    'interactive:status',
    'interactive:cancel',
    'headless:stream',
  ])
  await assert.rejects(
    () =>
      collect(
        router.streamTurn(
          input('run/mismatch', {
            mode: 'headless',
            retainedAdmission: { phase: 'interactive_started' },
          }),
        ),
      ),
    /conflicts with an interactive retained admission/u,
  )
})

test('starts one native process, records Runtime identity, and emits replayable envelopes', async () => {
  const fixture = interactiveFixture()
  const broker = new NativeInteractiveRunBroker()
  const port = interactivePort(fixture, broker)
  const admissions: RetainedInteractiveAdmission[] = []
  const input = {
    ...executionInput('run/start', async (admission) => {
      admissions.push(admission)
    }),
    workspaceRoot: '/client-only/braid-workspace',
  }

  const admission = await port.admit(input)
  assert.equal(admission.providerSessionId, undefined)
  const iterator = port.streamTurn(input)[Symbol.asyncIterator]()
  const observed = await next(iterator)
  const handle = await broker.waitForHandle(input.runId)

  assert.equal(fixture.stats.dispatchCalls, 0)
  assert.equal(fixture.stats.processStarts, 1)
  assert.equal(fixture.resolveInputs.length, 1)
  assert.deepEqual(
    admissions.map((entry) => entry.phase),
    ['interactive_intent', 'interactive_environment', 'interactive_started'],
  )
  assert.equal(admission.capabilities?.streaming.replay, true)
  assert.equal(admission.capabilities?.events.cursor, true)
  assert.equal(observed.cursor, `${input.runId}:interactive:${handle.ref.incarnationId}:1`)
  assert.equal(observed.eventId, `${input.runId}:interactive:${handle.ref.incarnationId}:observed`)
  assert.equal(fixture.stats.startRequests[0]?.cwd, undefined)
  assert.equal(fixture.lastCreateMetadata?.providerSessionId, undefined)
  assert.equal(fixture.lastCreateMetadata?.surface, 'interactive-agent')

  await finish(iterator, broker, input.runId)
  const cancelled = await port.cancelRun({ operationId: 'cancel-after-finish', runId: input.runId })
  assert.equal(cancelled.outcome, 'unknown')
})

test('detach ends the foreground stream while preserving the native handle for reattachment', async () => {
  const fixture = interactiveFixture()
  const broker = new NativeInteractiveRunBroker()
  const port = interactivePort(fixture, broker)
  const input = executionInput('run/detach', async () => {})
  const iterator = port.streamTurn(input)[Symbol.asyncIterator]()
  await next(iterator)
  const handle = await broker.waitForHandle(input.runId)

  const detached = await port.detachRun({
    runId: input.runId,
    operationId: 'detach-1',
    providerSessionId: handle.ref.run.sessionId,
    controlRef: handle.ref.run,
  })
  assert.equal(detached.outcome, 'accepted')
  assert.equal((await iterator.next()).done, true)

  const status = await port.status({ runId: input.runId })
  assert.equal(status?.status, 'detached')
  const stopped = await port.cancelRun({ operationId: 'cancel-detached', runId: input.runId })
  assert.equal(stopped.outcome, 'accepted')
  const stoppedAgain = await port.cancelRun({
    operationId: 'cancel-detached-again',
    runId: input.runId,
  })
  assert.equal(stoppedAgain.outcome, 'unknown')
})

test('reattach reuses the Runtime ref, honors a replay cursor, and does not start a second process', async () => {
  const fixture = interactiveFixture()
  const broker = new NativeInteractiveRunBroker()
  const first = interactivePort(fixture, broker)
  const admissions: RetainedInteractiveAdmission[] = []
  const input = executionInput('run/reattach', async (admission) => {
    admissions.push(admission)
  })
  const firstIterator = first.streamTurn(input)[Symbol.asyncIterator]()
  const observed = await next(firstIterator)
  const handle = await broker.waitForHandle(input.runId)
  await first.detachRun({
    runId: input.runId,
    operationId: 'detach-before-reconnect',
    providerSessionId: handle.ref.run.sessionId,
    controlRef: handle.ref.run,
  })
  assert.equal((await firstIterator.next()).done, true)

  const started = admissions.find((entry) => entry.phase === 'interactive_started')
  assert.ok(started?.phase === 'interactive_started')
  const second = interactivePort(fixture, broker)
  const reconnectInput = {
    runId: input.runId,
    retainedAdmission: started,
    receipt: receiptFor(input),
    after: observed.cursor,
    signal: input.signal,
  } as Parameters<typeof second.reconnect>[0]
  const reconnectIterator = second.reconnect(reconnectInput)[Symbol.asyncIterator]()
  const finalPromise = reconnectIterator.next()
  const reattached = await broker.waitForHandle(input.runId)
  assert.equal(reattached.ref.run.sessionId, handle.ref.run.sessionId)
  assert.equal(fixture.stats.processStarts, 1)
  assert.equal(fixture.stats.startCalls, 1)

  const settlement = broker.settle(input.runId, { kind: 'exited', exitCode: 0 })
  assert.equal(settlement, 'settled')
  const final = await finalPromise
  assert.equal(final.done, false)
  assert.equal(final.value.sequence, 2)
  assert.equal(final.value.cursor, `${input.runId}:interactive:${handle.ref.incarnationId}:2`)
  assert.equal((await reconnectIterator.next()).done, true)
})

test('partial intent and environment admissions report replayable status without recovery', async () => {
  for (const phase of ['interactive_intent', 'interactive_environment'] as const) {
    const fixture = interactiveFixture()
    const broker = new NativeInteractiveRunBroker()
    const port = interactivePort(fixture, broker)
    const admissions: RetainedInteractiveAdmission[] = []
    const input = executionInput(`run/partial-${phase}`, async (admission) => {
      admissions.push(admission)
      if (admission.phase === phase) throw new Error(`simulated ${phase} loss`)
    })
    const iterator = port.streamTurn(input)[Symbol.asyncIterator]()
    await assert.rejects(
      () => iterator.next(),
      (error: unknown) => causedBy(error, `simulated ${phase} loss`),
    )
    const partial = admissions.find((admission) => admission.phase === phase)
    assert.ok(partial)
    await assert.rejects(
      () =>
        port.status({
          runId: input.runId,
          providerSessionId: 'wrong-native-session',
          retainedAdmission: partial,
          receipt: receiptFor(input),
        } as Parameters<typeof port.status>[0]),
      /conflicts with the saved admission/u,
    )
    const before = { ...fixture.stats }
    const status = await port.status({
      runId: input.runId,
      retainedAdmission: partial,
      receipt: receiptFor(input),
    } as Parameters<typeof port.status>[0])

    assert.equal(status?.status, 'unknown')
    assert.equal(status?.detail, `replayable:${phase}`)
    assert.deepEqual(fixture.stats, before)
  }
})

test('reconnect recovers a persisted interactive intent exactly once', async () => {
  const fixture = interactiveFixture()
  const broker = new NativeInteractiveRunBroker()
  const initial = interactivePort(fixture, broker)
  const admissions: RetainedInteractiveAdmission[] = []
  let failIntent = true
  const input = executionInput('run/recover-intent', async (admission) => {
    admissions.push(admission)
    if (failIntent && admission.phase === 'interactive_intent') {
      throw new Error('simulated intent loss')
    }
  })
  const initialIterator = initial.streamTurn(input)[Symbol.asyncIterator]()
  await assert.rejects(
    () => initialIterator.next(),
    (error: unknown) => causedBy(error, 'simulated intent loss'),
  )
  const intent = admissions.find((admission) => admission.phase === 'interactive_intent')
  assert.ok(intent?.phase === 'interactive_intent')
  assert.equal(fixture.stats.createCalls, 0)

  failIntent = false
  const recovered = interactivePort(fixture, broker)
  const reconnectIterator = recovered
    .reconnect({
      runId: input.runId,
      retainedAdmission: intent,
      receipt: receiptFor(input),
      onRetainedAdmission: input.onRetainedAdmission,
      workspaceRoot: '/client-only/restarted-braid-workspace',
      signal: input.signal,
    } as Parameters<typeof recovered.reconnect>[0])
    [Symbol.asyncIterator]()
  await next(reconnectIterator)
  const handle = await broker.waitForHandle(input.runId)
  assert.equal(handle.ref.run.sessionId, intent.sessionId)
  assert.equal(fixture.stats.createCalls, 1)
  assert.equal(fixture.stats.processStarts, 1)
  assert.equal(fixture.stats.startRequests[0]?.cwd, undefined)
  assert.equal(fixture.stats.dispatchCalls, 0)
  assert.equal(fixture.resolveInputs.at(-1)?.sessionId, undefined)
  await finish(reconnectIterator, broker, input.runId)
})

test('reconnect rejects a provider session mismatch before attaching', async () => {
  const fixture = interactiveFixture()
  const broker = new NativeInteractiveRunBroker()
  const first = interactivePort(fixture, broker)
  const admissions: RetainedInteractiveAdmission[] = []
  const input = executionInput('run/mismatch', async (admission) => {
    admissions.push(admission)
  })
  const iterator = first.streamTurn(input)[Symbol.asyncIterator]()
  await next(iterator)
  const handle = await broker.waitForHandle(input.runId)
  await first.detachRun({
    runId: input.runId,
    operationId: 'detach-mismatch',
    providerSessionId: handle.ref.run.sessionId,
    controlRef: handle.ref.run,
  })
  assert.equal((await iterator.next()).done, true)
  const started = admissions.find((entry) => entry.phase === 'interactive_started')
  assert.ok(started?.phase === 'interactive_started')

  const second = interactivePort(fixture, broker)
  const reconnect = second
    .reconnect({
      runId: input.runId,
      retainedAdmission: started,
      receipt: receiptFor(input),
      providerSessionId: 'wrong-native-session',
      signal: input.signal,
    } as Parameters<typeof second.reconnect>[0])
    [Symbol.asyncIterator]()
  await assert.rejects(() => reconnect.next(), /conflicts with the saved process reference/u)
  assert.equal(fixture.stats.processStarts, 1)
})

test('a second foreground execution cannot duplicate an active native process', async () => {
  const fixture = interactiveFixture()
  const broker = new NativeInteractiveRunBroker()
  const port = interactivePort(fixture, broker)
  const input = executionInput('run/no-duplicate', async () => {})
  const first = port.streamTurn(input)[Symbol.asyncIterator]()
  await next(first)
  const duplicate = port.streamTurn(input)[Symbol.asyncIterator]()
  await assert.rejects(() => duplicate.next(), /already has an active execution/u)
  assert.equal(fixture.stats.processStarts, 1)
  const handle = await broker.waitForHandle(input.runId)
  await port.detachRun({
    runId: input.runId,
    operationId: 'detach-no-duplicate',
    providerSessionId: handle.ref.run.sessionId,
    controlRef: handle.ref.run,
  })
  assert.equal((await first.next()).done, true)
})

test('cancellation between admission and start cannot create a native process', async () => {
  const fixture = interactiveFixture()
  const port = interactivePort(fixture, new NativeInteractiveRunBroker())
  const input = executionInput('run/cancel-before-start', async () => {})
  await port.admit(input)
  const iterator = port.streamTurn(input)[Symbol.asyncIterator]()
  const nextResult = iterator.next()
  const cancelled = await port.cancelRun({
    operationId: 'cancel-before-native-start',
    runId: input.runId,
  })

  assert.equal(cancelled.outcome, 'accepted')
  assert.deepEqual(await nextResult, { done: true, value: undefined })
  assert.equal(fixture.stats.processStarts, 0)
})

test('cancelling a persisted interactive intent after restart does not materialize it', async () => {
  const fixture = interactiveFixture()
  const first = interactivePort(fixture, new NativeInteractiveRunBroker())
  const admissions: RetainedInteractiveAdmission[] = []
  const input = executionInput('run/cancel-intent', async (admission) => {
    admissions.push(admission)
    if (admission.phase === 'interactive_intent') throw new Error('simulated intent loss')
  })
  const initial = first.streamTurn(input)[Symbol.asyncIterator]()
  await assert.rejects(
    () => initial.next(),
    (error: unknown) => causedBy(error, 'simulated intent loss'),
  )
  const intent = admissions.find((admission) => admission.phase === 'interactive_intent')
  assert.ok(intent?.phase === 'interactive_intent')

  const restarted = interactivePort(fixture, new NativeInteractiveRunBroker())
  const cancelled = await restarted.cancelRun({
    operationId: 'cancel-persisted-interactive-intent',
    runId: input.runId,
    providerSessionId: intent.sessionId,
    retainedAdmission: intent,
    receipt: receiptFor(input),
  })

  assert.deepEqual(cancelled, {
    operationId: 'cancel-persisted-interactive-intent',
    outcome: 'accepted',
    detail: 'cancelled-before-start',
  })
  assert.equal(fixture.stats.createCalls, 0)
  assert.equal(fixture.stats.processStarts, 0)
  assert.equal(fixture.stats.stopCalls, 0)
})

test('detaching a persisted interactive intent does not materialize it', async () => {
  const fixture = interactiveFixture()
  const first = interactivePort(fixture, new NativeInteractiveRunBroker())
  const admissions: RetainedInteractiveAdmission[] = []
  const input = executionInput('run/detach-intent', async (admission) => {
    admissions.push(admission)
    if (admission.phase === 'interactive_intent') throw new Error('simulated detach intent loss')
  })
  const initial = first.streamTurn(input)[Symbol.asyncIterator]()
  await assert.rejects(
    () => initial.next(),
    (error: unknown) => causedBy(error, 'simulated detach intent loss'),
  )
  const intent = admissions.find((admission) => admission.phase === 'interactive_intent')
  assert.ok(intent?.phase === 'interactive_intent')

  const restarted = interactivePort(fixture, new NativeInteractiveRunBroker())
  const detached = await restarted.detachRun({
    operationId: 'detach-persisted-interactive-intent',
    runId: input.runId,
    providerSessionId: intent.sessionId,
    retainedAdmission: intent,
    receipt: receiptFor(input),
  })

  assert.deepEqual(detached, {
    operationId: 'detach-persisted-interactive-intent',
    outcome: 'accepted',
    detail: 'detached',
  })
  assert.equal(fixture.stats.createCalls, 0)
  assert.equal(fixture.stats.processStarts, 0)
  assert.equal(fixture.stats.stopCalls, 0)
})

test('cancellation recovers the exact native process after a process restart', async () => {
  const fixture = interactiveFixture()
  const firstBroker = new NativeInteractiveRunBroker()
  const first = interactivePort(fixture, firstBroker)
  const admissions: RetainedInteractiveAdmission[] = []
  const input = executionInput('run/restart-cancel', async (admission) => {
    admissions.push(admission)
  })
  const iterator = first.streamTurn(input)[Symbol.asyncIterator]()
  await next(iterator)
  const handle = await firstBroker.waitForHandle(input.runId)
  await first.detachRun({
    runId: input.runId,
    operationId: 'detach-before-restart-cancel',
    providerSessionId: handle.ref.run.sessionId,
    controlRef: handle.ref.run,
  })
  assert.equal((await iterator.next()).done, true)
  const started = admissions.find((entry) => entry.phase === 'interactive_started')
  assert.ok(started?.phase === 'interactive_started')

  const restarted = interactivePort(fixture, new NativeInteractiveRunBroker())
  const cancelled = await restarted.cancelRun({
    operationId: 'cancel-after-restart',
    runId: input.runId,
    providerSessionId: started.ref.run.sessionId,
    controlRef: started.ref.run,
    retainedAdmission: started,
    receipt: receiptFor(input),
    workspaceRoot: '/workspace',
  })

  assert.equal(cancelled.outcome, 'accepted')
  assert.equal(fixture.stats.processStarts, 1)
  assert.equal(fixture.stats.stopCalls, 1)
})

test('native cancellation omits an expired foreground signal from provider stop', async () => {
  const fixture = interactiveFixture()
  const broker = new NativeInteractiveRunBroker()
  const port = interactivePort(fixture, broker)
  const input = executionInput('run/expired-cancel', async () => {})
  const iterator = port.streamTurn(input)[Symbol.asyncIterator]()
  await next(iterator)
  const handle = await broker.waitForHandle(input.runId)
  const controller = new AbortController()
  controller.abort(new Error('foreground deadline elapsed'))

  const cancelled = await port.cancelRun({
    operationId: 'cancel-expired-foreground',
    runId: input.runId,
    providerSessionId: handle.ref.run.sessionId,
    controlRef: handle.ref.run,
    signal: controller.signal,
  })

  assert.equal(cancelled.outcome, 'accepted')
  assert.equal(fixture.stats.stopSignals.at(-1), undefined)
  const final = await next(iterator)
  assert.equal(final.sequence, 2)
  assert.equal((await iterator.next()).done, true)
})

test('interactive admission rejects a changed request for the same run identity', async () => {
  const fixture = interactiveFixture()
  const port = interactivePort(fixture, new NativeInteractiveRunBroker())
  const input = executionInput('run/request-integrity', async () => {})
  await port.admit(input)

  await assert.rejects(
    () => collect(port.streamTurn({ ...input, text: 'Use a different prompt.' })),
    /different request/u,
  )
  assert.equal(fixture.stats.processStarts, 0)
})

test('provider identity keys preserve uniqueness after normalization and truncation', () => {
  assert.notEqual(safeExecutionId('run/a'), safeExecutionId('run-a'))
  const first = 'x'.repeat(140)
  const second = `${'x'.repeat(139)}y`
  assert.notEqual(stableProviderId('env-braid-', first), stableProviderId('env-braid-', second))
  assert.ok(stableProviderId('env-braid-', first).length <= 128)
})

test('interactive provider admission requires terminal and prompt capabilities', () => {
  const fixture = interactiveFixture()
  const incomplete = {
    ...fixture.prepared,
    capabilities: {
      ...fixture.prepared.capabilities,
      interactiveAgent: {
        ...fixture.prepared.capabilities.interactiveAgent,
        input: false,
      },
    },
  } as PreparedTangleRetainedConnection
  assert.throws(() => assertInteractiveProvider(incomplete), /exact interactive agents/u)
})

test('retained runtime receives the canonical workspace request without a provider cwd shim', () => {
  const fixture = interactiveFixture()
  const workspaceRequest = {
    environment: 'universal',
    repoUrl: 'https://github.com/acme/repository',
    gitRef: 'main',
    cwd: 'src',
  } as const
  const prepared = { ...fixture.prepared, workspaceRequest } as PreparedTangleRetainedConnection

  const environment = interactiveEnvironment(prepared, 'run/workspace-request')

  assert.deepEqual(environment.workspace, workspaceRequest)
  assert.equal(Object.hasOwn(environment, 'cwd'), false)
})

test('native interactive admission does not advertise structured responses it cannot route', async () => {
  const fixture = interactiveFixture()
  const port = new TangleRetainedInteractiveExecutionPort({
    broker: new NativeInteractiveRunBroker(),
    resolve: async (input) => ({
      ...fixture.prepared,
      profile: input.profile,
      capabilities: {
        ...fixture.prepared.capabilities,
        interactions: {
          kinds: ['question'],
          answerFieldTypes: ['text'],
          responseScopes: ['interaction'],
          secretAnswers: false,
          concurrentRequests: false,
          replay: true,
          responseIdempotency: true,
        },
      },
    }),
  })

  const admission = await port.admit(
    executionInput('run/native-interaction-capability', async () => {}),
  )

  assert.equal(admission.capabilities?.environment?.interactions, undefined)
})

interface InteractiveFixture {
  readonly provider: AgentEnvironmentProvider
  readonly prepared: PreparedTangleRetainedConnection
  readonly profile: AgentProfile
  readonly resolveInputs: ExecuteTurnInput[]
  readonly stats: {
    createCalls: number
    getCalls: number
    startCalls: number
    processStarts: number
    startRequests: AgentInteractiveSessionStart[]
    dispatchCalls: number
    stopCalls: number
    stopSignals: (AbortSignal | undefined)[]
  }
  readonly lastCreateMetadata: Readonly<Record<string, unknown>> | undefined
}

function interactiveFixture(): InteractiveFixture {
  const profile = PROFILE
  const resolveInputs: ExecuteTurnInput[] = []
  const stats = {
    createCalls: 0,
    getCalls: 0,
    startCalls: 0,
    processStarts: 0,
    startRequests: [] as AgentInteractiveSessionStart[],
    dispatchCalls: 0,
    stopCalls: 0,
    stopSignals: [],
  }
  const state: {
    ref?: AgentInteractiveSessionRef
    lastCreateMetadata: Readonly<Record<string, unknown>> | undefined
  } = { lastCreateMetadata: undefined }
  const capabilities = interactiveCapabilities()
  const environment: AgentEnvironment = {
    id: 'environment-test',
    provider: 'test-provider',
    status: async () => ({ state: 'ready' }) as never,
    async *stream() {},
    dispatch: async () => {
      stats.dispatchCalls += 1
      throw new Error('headless dispatch must not run')
    },
    startInteractive: async (request) => {
      stats.startCalls += 1
      stats.startRequests.push(request)
      if (state.ref === undefined) {
        stats.processStarts += 1
        state.ref = interactiveRef(request)
      }
      return state.ref
    },
    interactive: (ref) => interactiveSession(ref, stats) as never,
  }
  const provider: AgentEnvironmentProvider = {
    name: 'test-provider',
    capabilities: async () => capabilities,
    create: async (input) => {
      stats.createCalls += 1
      state.lastCreateMetadata = input.metadata
      return environment
    },
    get: async () => {
      stats.getCalls += 1
      return environment
    },
  }
  const prepared = {
    profile,
    model: 'test-model',
    runner: 'pi',
    provider,
    capabilities,
    observation: {
      snapshot: async () => ({
        kind: 'sandbox',
        provider: 'test-provider',
        lifecycle: 'ready',
        lifecycleMode: 'retained',
        cleanup: 'explicit',
        continuity: 'session',
        location: 'remote',
        createdAt: '2026-08-16T00:00:00.000Z',
        observedAt: '2026-08-16T00:00:00.000Z',
        unavailable: [],
      }),
    },
    providerSessionId: 'headless-session-must-not-leak',
    environmentIdempotencyKey: 'headless-environment-key-must-not-leak',
    environmentName: 'headless-name-must-not-leak',
    environmentMetadata: {
      headless: true,
      providerSessionId: 'headless-session-must-not-leak',
    },
    idleTtlSeconds: 3600,
    discoverControlRef: async () => null,
    materializationReceipt: { headless: true, providerSessionId: 'headless-session-must-not-leak' },
  } as PreparedTangleRetainedConnection
  return {
    provider,
    prepared,
    profile,
    resolveInputs,
    stats,
    get lastCreateMetadata() {
      return state.lastCreateMetadata
    },
  }
}

function interactivePort(fixture: InteractiveFixture, broker: NativeInteractiveRunBroker) {
  const port = new TangleRetainedInteractiveExecutionPort({
    broker,
    resolve: async (input) => {
      fixture.resolveInputs.push(input)
      return { ...fixture.prepared, profile: input.profile }
    },
  })
  return port
}

function executionInput(
  runId: string,
  onRetainedAdmission: (admission: RetainedInteractiveAdmission) => Promise<void>,
): ExecuteTurnInput {
  return {
    operationId: `operation-${runId}`,
    runId,
    text: 'Inspect this workspace.',
    profile: PROFILE,
    mode: 'interactive',
    signal: new AbortController().signal,
    onRetainedAdmission: async (admission) => {
      await onRetainedAdmission(admission as unknown as RetainedInteractiveAdmission)
    },
  }
}

function receiptFor(input: ExecuteTurnInput): RunAdmissionReceipt {
  return {
    version: 1,
    runId: input.runId,
    turnId: 'turn-test',
    operationId: input.operationId,
    conversationId: 'conversation-test',
    branchId: 'branch-test',
    admittedAt: '2026-08-16T00:00:00.000Z',
    profileDigest: `sha256:${'1'.repeat(64)}`,
    requested: { text: input.text, profile: input.profile },
    capabilities: {} as RunAdmissionReceipt['capabilities'],
    requestDigest: `sha256:${'2'.repeat(64)}`,
    capabilitiesDigest: `sha256:${'3'.repeat(64)}`,
    digest: `sha256:${'4'.repeat(64)}`,
  }
}

function causedBy(error: unknown, message: string): boolean {
  return error instanceof Error && error.cause instanceof Error && error.cause.message === message
}

async function next<T>(iterator: AsyncIterator<T>): Promise<T> {
  const result = await iterator.next()
  assert.equal(result.done, false)
  return (result as IteratorYieldResult<T>).value
}

async function finish(
  iterator: AsyncIterator<RuntimeEventEnvelope>,
  broker: NativeInteractiveRunBroker,
  runId: string,
): Promise<void> {
  assert.equal(broker.settle(runId, { kind: 'exited', exitCode: 0 }), 'settled')
  const final = await next(iterator)
  assert.equal(final.sequence, 2)
  assert.equal((await iterator.next()).done, true)
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<void> {
  for await (const _event of iterable) {
    return
  }
}

function routingPort(
  label: string,
  admissionMode: 'sync' | 'async',
  calls: string[],
): ExecutionPort {
  return {
    admissionMode,
    capabilities: () => ({
      streaming: { live: true, replay: false, detach: false, turnIdempotency: true },
      sessions: { continue: false, messages: false },
      controls: { cancel: false, steer: false, queue: false, status: false, recreate: false },
      events: { stableIdentity: false, sequence: true, cursor: false },
      usage: false,
    }),
    streamTurn: async function* () {
      calls.push(`${label}:stream`)
      yield* []
    },
    status: async () => {
      calls.push(`${label}:status`)
      return null
    },
    cancelRun: async (control) => {
      calls.push(`${label}:cancel`)
      return { operationId: control.operationId, outcome: 'accepted' }
    },
  }
}

function input(runId: string, overrides: Record<string, unknown> = {}): ExecuteTurnInput {
  return {
    operationId: `operation-${runId}`,
    runId,
    text: 'test',
    profile: PROFILE,
    signal: new AbortController().signal,
    ...overrides,
  } as ExecuteTurnInput
}

function interactiveCapabilities(): AgentEnvironmentCapabilities {
  return {
    profile: {
      namedProfiles: true,
      systemPrompt: { replace: true, append: true },
      instructions: true,
      tools: true,
      permissions: true,
      mcp: true,
      subagents: true,
      resources: { files: true, instructions: true },
      runtimeUpdate: true,
      validation: true,
    },
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, list: true, messages: true },
    retainedControl: {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    },
    workspace: { read: true, write: true, exec: true, git: true, upload: true, download: true },
    branching: { checkpoint: false, fork: false },
    placement: true,
    usage: false,
    confidential: false,
    interactiveAgent: {
      start: true,
      control: true,
      status: true,
      attach: true,
      reattach: true,
      sendPrompt: true,
      input: true,
      resize: true,
      stop: true,
    },
  }
}

function interactiveRef(
  request: Parameters<NonNullable<AgentEnvironment['startInteractive']>>[0],
): AgentInteractiveSessionRef {
  const preparationReceipt = {
    kind: 'agent-execution-preparation' as const,
    schemaVersion: 1 as const,
    preparationId: 'preparation-test',
    requestDigest: request.run.requestDigest,
    authoredProfileDigest: request.requestedProfileDigest,
    effectiveProfileDigest: request.requestedProfileDigest,
    backend: 'test-backend',
    harness: request.profile.harness ?? 'pi',
    harnessVersion: 'test-harness-1',
    resolvedModel: {
      requested: request.profile.model?.default ?? 'test-model',
      resolved: request.profile.model?.default ?? 'test-model',
    },
    workspace: {
      leaseId: 'workspace-lease-test',
      provider: 'test-provider',
      identityDigest: digest('2'),
      isolation: 'per-run' as const,
      sourceSnapshotDigest: digest('3'),
      sourceSnapshotPolicy: {
        kind: 'provider-declared' as const,
        name: 'test',
        version: 1,
        digest: digest('4'),
      },
      preparedWorkspaceDigest: digest('5'),
      profileActivationDigest: digest('6'),
    },
    axisResults: [],
    executionPlanDigest: digest('7'),
    materializer: { name: 'test-materializer', version: '1' },
    expiresAtMs: 4102444800000,
  }
  return AgentInteractiveSessionRefSchema.parse({
    run: request.run,
    preparationReceipt: {
      ...preparationReceipt,
      digest: canonicalCandidateDigest(preparationReceipt),
    },
    incarnationId: 'incarnation-test',
    startedAt: '2026-08-16T00:00:00.000Z',
  })
}

function interactiveSession(ref: AgentInteractiveSessionRef, stats: InteractiveFixture['stats']) {
  const control = (holderId: string) => ({
    refDigest: canonicalCandidateDigest(ref),
    generation: 1,
    leaseId: 'interactive-lease-test',
    holderId,
    expiresAt: '2099-01-01T00:00:00.000Z',
  })
  return {
    ref,
    claimControl: async (request: {
      operationId: string
      requestDigest: string
      holderId: string
    }) => ({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      ref,
      status: 'accepted' as const,
      control: control(request.holderId),
    }),
    status: async () => ({ state: 'running' as const, ref }),
    attach: async (request: { control: unknown }) => ({
      ref: {
        terminalSessionId: 'terminal-test',
        parentExecutionId: ref.run.executionId,
        name: 'pi',
        shell: '/bin/sh',
        command: 'pi',
        cwd: '/workspace',
        cols: 120,
        rows: 40,
        createdAt: '2026-08-16T00:00:00.000Z',
        lastActivityAt: '2026-08-16T00:00:00.000Z',
        expiresAt: '2026-08-17T00:00:00.000Z',
        isRunning: true,
        attachCount: 1,
      },
      control: request.control,
      cursors: { earliest: 0, latest: 0 },
      input: async () => {},
      resize: async () => {},
      detach: async () => ({ status: 'detached' as const, terminalSessionId: 'terminal-test' }),
      close: async () => ({ status: 'closed' as const, terminalSessionId: 'terminal-test' }),
      async *events() {},
    }),
    sendPrompt: async (command: {
      operationId: string
      requestDigest: string
      control: unknown
    }) => ({
      operationId: command.operationId,
      requestDigest: command.requestDigest,
      ref,
      control: command.control,
      status: 'accepted' as const,
    }),
    stop: async (
      command: { operationId: string; requestDigest: string; control: unknown },
      options?: { signal?: AbortSignal },
    ) => {
      stats.stopCalls += 1
      stats.stopSignals.push(options?.signal)
      return {
        operationId: command.operationId,
        requestDigest: command.requestDigest,
        ref,
        control: command.control,
        status: 'accepted' as const,
        effect: 'stopped' as const,
      }
    },
  }
}

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}
