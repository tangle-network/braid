import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AgentExactRunControlRef,
  defineAgentProfile,
  type InteractionResponseCommand,
} from '@tangle-network/agent-interface'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import {
  type RetainedExecutionPlan,
  RetainedExecutionPort,
} from '../src/adapters/runtime/retained-execution.js'
import { retainedCapabilities } from '../src/adapters/runtime/retained-execution-projection.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  type RetainedRunAdmissionRecord,
} from '../src/ports/execution.js'
import { RETAINED_RUN_HANDLE_CAPABILITIES } from './support/retained-run-capabilities.js'

const now = '2026-08-12T12:00:00.000Z'

const profile = defineAgentProfile({
  name: 'Retained lifecycle test',
  harness: 'pi',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})

type CancelOptions = Parameters<RetainedRunHandle['cancel']>[0]
type CancelResult = Awaited<ReturnType<RetainedRunHandle['cancel']>>

function controlRef(suffix: string): AgentExactRunControlRef {
  return {
    provider: 'retained-test',
    environmentId: `environment-${suffix}`,
    sessionId: `session-${suffix}`,
    executionId: `execution-${suffix}`,
    runId: `provider-run-${suffix}`,
    requestDigest: `sha256:${'a'.repeat(64)}`,
  }
}

function input(suffix: string): ExecuteTurnInput {
  return {
    operationId: `operation-${suffix}`,
    runId: `run-${suffix}`,
    text: 'Continue the retained task.',
    profile,
    signal: new AbortController().signal,
  }
}

function handle(
  exact: AgentExactRunControlRef,
  options: {
    readonly cancel?: (input: CancelOptions) => Promise<CancelResult>
    readonly respondToInteraction?: RetainedRunHandle['respondToInteraction']
    readonly status?: RetainedRunHandle['status']
  } = {},
): RetainedRunHandle {
  return {
    controlRef: exact,
    capabilities: RETAINED_RUN_HANDLE_CAPABILITIES,
    status:
      options.status ??
      (async () => ({
        runId: exact.runId,
        controlRef: exact,
        status: 'running' as const,
        effect: 'unknown' as const,
        observedAt: now,
      })),
    async *events() {},
    async result() {
      return { text: '', success: true }
    },
    respondToInteraction:
      options.respondToInteraction ??
      (async () => {
        throw new Error('interaction is not part of this test')
      }),
    async contextBoundary() {
      return null
    },
    beginNativeContinuation() {
      throw new Error('native continuation is not part of this test')
    },
    async continueNative() {
      throw new Error('native continuation is not part of this test')
    },
    cancel:
      options.cancel ??
      (async (request) => ({
        operationId: request.operationId,
        requestDigest: exact.requestDigest,
        status: 'accepted' as const,
        effect: 'cancelled' as const,
        snapshot: {
          runId: exact.runId,
          controlRef: exact,
          status: 'cancelled' as const,
          effect: 'cancelled' as const,
          observedAt: now,
        },
      })),
  }
}

function plan(
  exact: AgentExactRunControlRef,
  start: () => Promise<RetainedRunHandle>,
  startedHandle = handle(exact),
): RetainedExecutionPlan {
  return {
    providerName: exact.provider,
    environmentId: exact.environmentId,
    providerSessionId: exact.sessionId,
    model: 'openai/gpt-5',
    capabilities: DEFAULT_RUN_CAPABILITIES,
    materializationReceipt: {},
    start,
    reconnect: async () => startedHandle,
    discover: async () => null,
    observe: async () => undefined,
    projectStatus: () => 'streaming',
    isTerminalStatus: () => false,
    projectResult: (result) => ({ text: result.text, usage: { input: 0, output: 0 } }),
    projectFinal: () => {
      throw new Error('final projection is not part of this test')
    },
  }
}

test('retained controls follow complete provider capabilities', () => {
  const unavailable = retainedCapabilities(RETAINED_RUN_HANDLE_CAPABILITIES)
  assert.deepEqual(unavailable.controls, {
    cancel: false,
    steer: false,
    queue: true,
    status: false,
    recreate: false,
  })

  const capableEnvironment = {
    ...RETAINED_RUN_HANDLE_CAPABILITIES,
    retainedControl: {
      exactRunIdentity: true,
      resultIdentity: true,
      eventIdentity: true,
      cancellationIdempotency: true,
    },
  }
  const available = retainedCapabilities(capableEnvironment)
  assert.deepEqual(available.controls, {
    cancel: true,
    steer: false,
    queue: true,
    status: true,
    recreate: true,
  })
  assert.equal(
    retainedCapabilities(capableEnvironment, { exactStatus: false }).controls.status,
    false,
  )
})

test('retained observations use the exact provider environment identity', async () => {
  const exact = controlRef('observation')
  const retainedPlan: RetainedExecutionPlan = {
    ...plan(exact, async () => handle(exact)),
    observe: async () => ({
      kind: 'remote-service',
      provider: exact.provider,
      lifecycle: 'ready',
      lifecycleMode: 'retained',
      cleanup: 'explicit',
      continuity: 'session',
      location: 'remote',
      createdAt: now,
      observedAt: now,
      unavailable: [],
    }),
  }
  const execution = executionFor(async () => retainedPlan)
  const runInput = input('observation')

  await execution.admit(runInput)
  const stream = execution.streamTurn(runInput)[Symbol.asyncIterator]()
  const first = await stream.next()

  assert.equal(first.done, false)
  assert.equal(first.value?.event.type, 'braid.execution.observed')
  if (first.value?.event.type !== 'braid.execution.observed') {
    throw new Error('expected the retained execution observation')
  }
  assert.equal(first.value.event.observation.providerEnvironmentId, exact.environmentId)
  assert.deepEqual(first.value.event.controlRef, exact)
  await stream.return?.(undefined as never)
})

function executionFor(
  resolve: (input: ExecuteTurnInput) => Promise<RetainedExecutionPlan>,
): RetainedExecutionPort {
  return new RetainedExecutionPort({
    resolve,
    recover: async () => {
      throw new Error('recovery is not part of this lifecycle test')
    },
  })
}

test('pre-start cancellation prevents the retained plan from starting', async () => {
  const exact = controlRef('pre-start')
  let starts = 0
  const retainedPlan = plan(exact, async () => {
    starts += 1
    return handle(exact)
  })
  const execution = executionFor(async () => retainedPlan)
  const runInput = input('pre-start')

  await execution.admit(runInput)
  const acknowledgement = await execution.cancelRun({
    operationId: 'operation-pre-start-cancel',
    runId: runInput.runId,
  })

  assert.deepEqual(acknowledgement, {
    operationId: 'operation-pre-start-cancel',
    outcome: 'accepted',
    detail: 'cancelled-before-start',
  })
  const stream = execution.streamTurn(runInput)[Symbol.asyncIterator]()
  assert.deepEqual(await stream.next(), { done: true, value: undefined })
  assert.equal(starts, 0)

  const replayed = await execution.cancelRun({
    operationId: 'operation-pre-start-cancel-replay',
    runId: runInput.runId,
  })
  assert.equal(replayed.outcome, 'already-applied')
})

test('restart cancellation of a persisted retained intent does not recover provider work', async () => {
  const exact = controlRef('restart-intent')
  const execution = new RetainedExecutionPort({
    resolve: async () => {
      throw new Error('a cancelled intent must not resolve a new plan')
    },
    recover: async () => {
      throw new Error('a cancelled intent must not recover provider work')
    },
  })
  const admission: RetainedRunAdmissionRecord = {
    phase: 'intent',
    provider: exact.provider,
    idempotencyKey: 'environment-restart-intent',
    turnId: 'turn-restart-intent',
    sessionId: exact.sessionId,
    executionId: exact.executionId,
    runId: 'runtime-restart-intent',
    requestedProfileDigest: `sha256:${'1'.repeat(64)}`,
    requestDigest: `sha256:${'2'.repeat(64)}`,
  }

  const acknowledgement = await execution.cancelRun({
    operationId: 'operation-restart-intent-cancel',
    runId: 'run-restart-intent',
    providerSessionId: exact.sessionId,
    retainedAdmission: admission,
  })

  assert.deepEqual(acknowledgement, {
    operationId: 'operation-restart-intent-cancel',
    outcome: 'accepted',
    detail: 'cancelled-before-start',
  })
})

test('restart detach validates the persisted retained control reference', async () => {
  const exact = controlRef('restart-detach')
  let recoveries = 0
  const recoveredPlan = plan(exact, async () => handle(exact))
  const admission: RetainedRunAdmissionRecord = {
    phase: 'dispatched',
    idempotencyKey: 'environment-restart-detach',
    turnId: 'turn-restart-detach',
    controlRef: exact,
  }
  const execution = new RetainedExecutionPort({
    resolve: async () => {
      throw new Error('restart detach must not resolve a fresh run')
    },
    recover: async ({ controlRef }) => {
      recoveries += 1
      assert.deepEqual(controlRef, exact)
      return recoveredPlan
    },
  })

  await assert.rejects(
    execution.detachRun({
      operationId: 'operation-restart-detach-conflict',
      runId: 'run-restart-detach',
      providerSessionId: exact.sessionId,
      controlRef: { ...exact, requestDigest: `sha256:${'3'.repeat(64)}` },
      retainedAdmission: admission,
    }),
    /conflicts with the persisted run/u,
  )
  const detached = await execution.detachRun({
    operationId: 'operation-restart-detach',
    runId: 'run-restart-detach',
    providerSessionId: exact.sessionId,
    retainedAdmission: admission,
  })
  assert.equal(detached.outcome, 'accepted')
  assert.equal(recoveries, 1)
})

test('restart controls reject a process reference against a pre-dispatch admission', async () => {
  const exact = controlRef('pre-dispatch-control')
  const conflicting = { ...exact, environmentId: 'environment-other' }
  const admission: RetainedRunAdmissionRecord = {
    phase: 'environment',
    provider: exact.provider,
    environmentId: exact.environmentId,
    idempotencyKey: 'environment-pre-dispatch-control',
    turnId: 'turn-pre-dispatch-control',
    sessionId: exact.sessionId,
    executionId: exact.executionId,
  }
  let recoveries = 0
  const execution = new RetainedExecutionPort({
    resolve: async () => {
      throw new Error('pre-dispatch control must not resolve a fresh run')
    },
    recover: async () => {
      recoveries += 1
      return plan(exact, async () => handle(exact))
    },
  })

  await assert.rejects(
    execution.detachRun({
      operationId: 'operation-pre-dispatch-control',
      runId: 'run-pre-dispatch-control',
      providerSessionId: exact.sessionId,
      controlRef: conflicting,
      retainedAdmission: admission,
    }),
    /pre-dispatch admission/u,
  )
  assert.equal(recoveries, 0)
})

test('in-flight start cancellation omits an expired foreground signal', async () => {
  const exact = controlRef('in-flight')
  let resolveStart: (value: RetainedRunHandle) => void = () => undefined
  let receivedSignal: AbortSignal | undefined
  const started = new Promise<RetainedRunHandle>((resolve) => {
    resolveStart = resolve
  })
  const startedHandle = handle(exact, {
    cancel: async (request) => {
      receivedSignal = request.signal
      return {
        operationId: request.operationId,
        requestDigest: exact.requestDigest,
        status: 'accepted',
        effect: 'cancelled',
        snapshot: {
          runId: exact.runId,
          controlRef: exact,
          status: 'cancelled',
          effect: 'cancelled',
          observedAt: now,
        },
      }
    },
  })
  const execution = executionFor(async () => plan(exact, async () => started, startedHandle))
  const runInput = input('in-flight')
  await execution.admit(runInput)
  const stream = execution.streamTurn(runInput)[Symbol.asyncIterator]()
  const streamCompletion = stream.next().catch(() => undefined)
  await new Promise((resolve) => setImmediate(resolve))

  const control = new AbortController()
  const cancellation = execution.cancelRun({
    operationId: 'operation-in-flight-cancel',
    runId: runInput.runId,
    signal: control.signal,
  })
  control.abort(new Error('foreground deadline elapsed'))
  resolveStart(startedHandle)

  const acknowledgement = await cancellation
  await streamCompletion
  assert.equal(acknowledgement.outcome, 'accepted')
  assert.equal(receivedSignal, undefined)
})

test('in-flight detach starts the cloud run but never opens a local event reader', async () => {
  const exact = controlRef('detach-in-flight')
  let resolveStart: (value: RetainedRunHandle) => void = () => undefined
  let starts = 0
  const started = new Promise<RetainedRunHandle>((resolve) => {
    resolveStart = resolve
  })
  const retainedHandle = handle(exact)
  const execution = executionFor(async () =>
    plan(exact, async () => {
      starts += 1
      return started
    }),
  )
  const runInput = input('detach-in-flight')
  await execution.admit(runInput)
  const stream = execution.streamTurn(runInput)[Symbol.asyncIterator]()
  const streamCompletion = stream.next()
  await new Promise((resolve) => setImmediate(resolve))

  const acknowledgement = await execution.detachRun({
    operationId: 'operation-detach-in-flight',
    runId: runInput.runId,
  })
  resolveStart(retainedHandle)

  assert.deepEqual(acknowledgement, {
    operationId: 'operation-detach-in-flight',
    outcome: 'accepted',
    detail: 'detached',
  })
  assert.deepEqual(await streamCompletion, { done: true, value: undefined })
  assert.equal(starts, 1)
  assert.equal(
    (
      await execution.detachRun({
        operationId: 'operation-detach-in-flight-retry',
        runId: runInput.runId,
      })
    ).outcome,
    'already-applied',
  )
})

test('active retained controls reject a provider session not bound to the handle', async () => {
  const exact = controlRef('active-session')
  let cancelCalls = 0
  let statusCalls = 0
  const retainedHandle = handle(exact, {
    cancel: async (request) => {
      cancelCalls += 1
      return {
        operationId: request.operationId,
        requestDigest: exact.requestDigest,
        status: 'accepted',
        effect: 'cancelled',
        snapshot: {
          runId: exact.runId,
          controlRef: exact,
          status: 'cancelled',
          effect: 'cancelled',
          observedAt: now,
        },
      }
    },
    status: async () => {
      statusCalls += 1
      return {
        runId: exact.runId,
        controlRef: exact,
        status: 'running',
        effect: 'unknown',
        observedAt: now,
      }
    },
  })
  const resolvedPlan = plan(exact, async () => retainedHandle, retainedHandle)
  const { providerSessionId: _providerSessionId, ...unboundPlan } = resolvedPlan
  const execution = executionFor(async () => unboundPlan)
  const runInput = input('active-session')
  await execution.admit(runInput)
  const stream = execution.streamTurn(runInput)[Symbol.asyncIterator]()
  await stream.next().catch(() => undefined)

  await assert.rejects(
    execution.cancelRun({
      operationId: 'operation-active-session-cancel',
      runId: runInput.runId,
      providerSessionId: 'session-other',
    }),
    /active run/u,
  )
  await assert.rejects(
    execution.status({ runId: runInput.runId, providerSessionId: 'session-other' }),
    /active run/u,
  )
  assert.equal(cancelCalls, 0)
  assert.equal(statusCalls, 0)
})

test('ambiguous cancellation effects reconcile or remain unknown', async () => {
  for (const effect of ['unknown', 'not_live'] as const) {
    const exact = controlRef(`ambiguous-${effect}`)
    let statusCalls = 0
    const retainedHandle = handle(exact, {
      status: async () => {
        statusCalls += 1
        return {
          runId: exact.runId,
          controlRef: exact,
          status: 'running',
          effect: 'unknown',
          observedAt: now,
        }
      },
      cancel: async (request) => ({
        operationId: request.operationId,
        requestDigest: exact.requestDigest,
        status: 'accepted',
        effect,
        snapshot: {
          runId: exact.runId,
          controlRef: exact,
          status: 'running',
          effect,
          observedAt: now,
        },
      }),
    })
    const execution = executionFor(async () =>
      plan(exact, async () => retainedHandle, retainedHandle),
    )
    const runInput = input(`ambiguous-${effect}`)
    await execution.admit(runInput)
    const stream = execution.streamTurn(runInput)[Symbol.asyncIterator]()
    await stream.next().catch(() => undefined)

    const acknowledgement = await execution.cancelRun({
      operationId: `operation-ambiguous-${effect}`,
      runId: runInput.runId,
    })
    assert.deepEqual(acknowledgement, {
      operationId: `operation-ambiguous-${effect}`,
      outcome: 'unknown',
      detail: effect,
    })
    assert.equal(statusCalls, 1)
  }
})

test('a terminal snapshot confirms ambiguous and pending cancellations', async () => {
  for (const effect of ['unknown', 'cancel_requested'] as const) {
    const exact = controlRef(`reconciled-${effect}`)
    const statusWaits: Array<number | undefined> = []
    const retainedHandle = handle(exact, {
      status: async (options) => {
        statusWaits.push(options?.waitMs)
        return {
          runId: exact.runId,
          controlRef: exact,
          status: 'cancelled',
          effect: 'cancelled',
          observedAt: now,
        }
      },
      cancel: async (request) => ({
        operationId: request.operationId,
        requestDigest: exact.requestDigest,
        status: 'accepted',
        effect,
        snapshot: {
          runId: exact.runId,
          controlRef: exact,
          status: 'running',
          effect,
          observedAt: now,
        },
      }),
    })
    const execution = executionFor(async () =>
      plan(exact, async () => retainedHandle, retainedHandle),
    )
    const runInput = input(`reconciled-${effect}`)
    await execution.admit(runInput)
    const stream = execution.streamTurn(runInput)[Symbol.asyncIterator]()
    await stream.next().catch(() => undefined)

    const operationId = `operation-reconciled-${effect}`
    const acknowledgement = await execution.cancelRun({
      operationId,
      runId: runInput.runId,
    })
    assert.deepEqual(acknowledgement, {
      operationId,
      outcome: 'accepted',
      detail: 'cancelled',
    })
    assert.deepEqual(statusWaits, [effect === 'cancel_requested' ? 30_000 : undefined])
  }
})

test('interaction response recovers the retained handle and preserves retry acknowledgement', async () => {
  const exact = controlRef('interaction')
  let responses = 0
  let recoverySignal: AbortSignal | undefined
  const retainedHandle = handle(exact, {
    respondToInteraction: async (command) => {
      responses += 1
      return {
        operationId: command.operationId,
        binding: command.binding,
        commandDigest: command.commandDigest,
        status: responses === 1 ? 'accepted' : 'already_resolved_same',
      }
    },
  })
  const recoveredPlan: RetainedExecutionPlan = {
    ...plan(exact, async () => retainedHandle, retainedHandle),
    discover: async (runId) => {
      assert.equal(runId, 'run-interaction')
      return exact
    },
  }
  const execution = new RetainedExecutionPort({
    resolve: async () => {
      throw new Error('a recovered interaction must not resolve a new run')
    },
    recover: async ({ runId, providerSessionId, signal }) => {
      assert.equal(runId, 'run-interaction')
      assert.equal(providerSessionId, exact.sessionId)
      recoverySignal = signal
      return recoveredPlan
    },
  })
  const command: InteractionResponseCommand = {
    operationId: 'operation-interaction-response',
    binding: {
      requestDigest: `sha256:${'b'.repeat(64)}`,
      runId: 'run-interaction',
      provider: exact.provider,
      environmentId: exact.environmentId,
      sessionId: exact.sessionId,
      executionId: exact.executionId,
      interactionId: 'interaction-retained',
    },
    commandDigest: `sha256:${'c'.repeat(64)}`,
    response: { id: 'interaction-retained', outcome: 'accepted' },
  }

  const signal = new AbortController().signal
  assert.deepEqual(await execution.respondInteraction({ command, signal }), {
    operationId: command.operationId,
    outcome: 'accepted',
    detail: 'INTERACTION_RESPONSE_ACCEPTED',
  })
  assert.equal(recoverySignal, signal)
  assert.deepEqual(await execution.respondInteraction({ command }), {
    operationId: command.operationId,
    outcome: 'already-applied',
    detail: 'INTERACTION_RESPONSE_REPLAYED',
  })
  assert.equal(responses, 2)
})

test('admission rejects at capacity instead of evicting a prepared plan', async () => {
  let starts = 0
  const execution = executionFor(async (runInput) => {
    const exact = controlRef(runInput.runId)
    return plan(exact, async () => {
      starts += 1
      return handle(exact)
    })
  })
  const inputs = Array.from({ length: 129 }, (_, index) => input(`capacity-${index}`))

  for (const runInput of inputs.slice(0, 128)) await execution.admit(runInput)
  await assert.rejects(
    execution.admit(inputs[128] as ExecuteTurnInput),
    /Retained execution admission capacity reached/u,
  )

  const firstStream = execution.streamTurn(inputs[0] as ExecuteTurnInput)[Symbol.asyncIterator]()
  await firstStream.next().catch(() => undefined)
  assert.equal(starts, 1)
})
