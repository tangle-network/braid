import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AgentExactRunControlRef,
  type AgentNativeContextContinuationResult,
  defineAgentProfile,
  type NativeContextBoundaryProof,
  type NativeContextContinuationRequest,
  type NativeContextContinuationTurn,
} from '@tangle-network/agent-interface'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import {
  type RetainedExecutionPlan,
  RetainedExecutionPort,
} from '../src/adapters/runtime/retained-execution.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import type { RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  supportsNativeContinuation,
} from '../src/ports/execution.js'
import { RETAINED_RUN_HANDLE_CAPABILITIES } from './support/retained-run-capabilities.js'

const at = '2026-08-19T12:00:00.000Z'

type NativeContinuationHandle = {
  readonly admission: Promise<AgentExactRunControlRef>
  readonly result: Promise<AgentNativeContextContinuationResult>
}

type NativeContinuationRetainedRunHandle = RetainedRunHandle & {
  readonly beginNativeContinuation: (
    request: NativeContextContinuationRequest,
    turn: NativeContextContinuationTurn & {
      readonly timeoutMs?: number
      readonly signal?: AbortSignal
    },
  ) => NativeContinuationHandle
}

const profile = defineAgentProfile({
  name: 'Native continuation test',
  harness: 'pi',
  model: { default: 'openai/gpt-5.6-luna' },
})

test('native continuation stays disabled until the provider exposes early control', () => {
  const safeReplay = {
    ...RETAINED_RUN_HANDLE_CAPABILITIES,
    sessions: { continue: true, list: false, messages: false },
    nativeContinuation: { atomicBoundary: true, requestIdempotency: true },
  }
  assert.equal(supportsNativeContinuation(safeReplay), false)
  assert.equal(
    supportsNativeContinuation({
      ...safeReplay,
      nativeContinuation: { ...safeReplay.nativeContinuation, admissionControl: true },
    }),
    true,
  )
})

function exact(suffix: string): AgentExactRunControlRef {
  return {
    runId: `provider-run-${suffix}`,
    provider: 'retained-test',
    environmentId: 'environment-native',
    sessionId: 'session-native',
    executionId: `execution-${suffix}`,
    requestDigest: `sha256:${(suffix === 'source' ? 'a' : 'b').repeat(64)}`,
  }
}

function fixture(
  settings: { readonly pendingResult?: boolean; readonly streamEvents?: boolean } = {},
) {
  const source = exact('source')
  const next = exact('next')
  const proof: NativeContextBoundaryProof = {
    ...source,
    boundary: { kind: 'revision', revision: 'pi-message-count:2' },
    observedAt: at,
  }
  const outcomes = new Map<string, AgentNativeContextContinuationResult>()
  const continuationRequests: Array<{
    readonly operationId: string
    readonly requestDigest: string
    readonly run: AgentExactRunControlRef
    readonly expectedBoundary: NativeContextBoundaryProof
  }> = []
  const continuationStatuses: string[] = []
  const statusControlRefs: AgentExactRunControlRef[] = []
  const cancellationControlRefs: AgentExactRunControlRef[] = []
  let continuationCalls = 0
  let reconnectCalls = 0
  let resultCalls = 0
  let terminalSettled = settings.pendingResult !== true
  let releaseTerminal: () => void = () => undefined
  const terminalGate =
    settings.pendingResult === true
      ? new Promise<void>((resolve) => {
          releaseTerminal = resolve
        })
      : Promise.resolve()
  let resolveEventsActive: () => void = () => undefined
  const eventsActive =
    settings.streamEvents === true
      ? new Promise<void>((resolve) => {
          resolveEventsActive = resolve
        })
      : Promise.resolve()
  let cancelled = false

  const createHandle = (): NativeContinuationRetainedRunHandle => {
    let current = source
    const result = { text: 'continued exactly once', success: true, sessionId: source.sessionId }
    const continueNative = async (
      request: NativeContextContinuationRequest,
      turn: NativeContextContinuationTurn & {
        readonly timeoutMs?: number
        readonly signal?: AbortSignal
      },
    ): Promise<AgentNativeContextContinuationResult> => {
      continuationCalls += 1
      continuationRequests.push(structuredClone(request))
      assert.deepEqual(request.run, source)
      assert.deepEqual(request.expectedBoundary, proof)
      assert.equal(turn.prompt, 'Continue this exact Pi chat.')
      assert.equal(turn.model, 'openai/gpt-5.6-luna')
      const prior = outcomes.get(request.requestDigest)
      if (prior !== undefined) {
        continuationStatuses.push('replayed')
        current = next
        return {
          ...prior,
          acknowledgement: { ...prior.acknowledgement, status: 'replayed' },
        } as AgentNativeContextContinuationResult
      }
      current = next
      const accepted: AgentNativeContextContinuationResult = {
        acknowledgement: {
          operationId: request.operationId,
          requestDigest: request.requestDigest,
          status: 'accepted',
          historyMessagesSent: 0,
        },
        result,
        controlRef: next,
      }
      continuationStatuses.push('accepted')
      outcomes.set(request.requestDigest, accepted)
      await terminalGate
      terminalSettled = true
      return accepted
    }
    return {
      get controlRef() {
        return current
      },
      capabilities: {
        ...RETAINED_RUN_HANDLE_CAPABILITIES,
        sessions: { continue: true, list: false, messages: false },
        nativeContinuation: {
          atomicBoundary: true,
          requestIdempotency: true,
          admissionControl: true,
        },
      },
      async status() {
        statusControlRefs.push(current)
        return {
          runId: current.runId,
          controlRef: current,
          status: cancelled ? 'cancelled' : 'running',
          effect: cancelled ? 'cancelled' : 'unknown',
          observedAt: at,
        }
      },
      async *events(eventOptions) {
        if (settings.streamEvents !== true) return
        yield {
          runId: current.runId,
          eventId: `${current.runId}:progress`,
          sequence: 1,
          receivedAt: at,
          event: { type: 'status', status: 'processing' },
        }
        resolveEventsActive()
        await new Promise<void>((resolve) => {
          if (eventOptions?.signal?.aborted === true) {
            resolve()
            return
          }
          eventOptions?.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
      },
      async result() {
        resultCalls += 1
        return result
      },
      async respondToInteraction() {
        throw new Error('interaction response is not part of this test')
      },
      async contextBoundary() {
        return proof
      },
      beginNativeContinuation(request, turn) {
        const admission = Promise.resolve().then(() => {
          current = next
          return next
        })
        return { admission, result: continueNative(request, turn) }
      },
      async continueNative() {
        throw new Error('legacy native continuation is not part of this test')
      },
      async cancel(request) {
        cancellationControlRefs.push(current)
        cancelled = true
        return {
          operationId: request.operationId,
          requestDigest: current.requestDigest,
          status: 'accepted',
          effect: 'cancelled',
          snapshot: {
            runId: current.runId,
            controlRef: current,
            status: 'cancelled',
            effect: 'cancelled',
            observedAt: at,
          },
        }
      },
    }
  }

  const capabilities = {
    ...DEFAULT_RUN_CAPABILITIES,
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, messages: false },
    controls: { cancel: true, steer: false, queue: true, status: true, recreate: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
    environment: {
      ...RETAINED_RUN_HANDLE_CAPABILITIES,
      sessions: { continue: true, list: false, messages: false },
      nativeContinuation: {
        atomicBoundary: true,
        requestIdempotency: true,
        admissionControl: true,
      },
    },
  } as const
  const plan: RetainedExecutionPlan = {
    providerName: source.provider,
    environmentId: source.environmentId,
    providerSessionId: source.sessionId,
    model: 'openai/gpt-5.6-luna',
    capabilities,
    materializationReceipt: { backend: 'environment-provider' },
    start: async () => {
      throw new Error('native continuation must not start another environment')
    },
    reconnect: async (controlRef) => {
      reconnectCalls += 1
      assert.deepEqual(controlRef, source)
      return createHandle()
    },
    discover: async () => null,
    observe: async () => ({
      kind: 'local-process',
      provider: source.provider,
      lifecycle: 'ready',
      lifecycleMode: 'retained',
      cleanup: 'explicit',
      continuity: 'session',
      location: 'local',
      createdAt: at,
      observedAt: at,
      unavailable: [],
    }),
    projectStatus: ({ status }) => (status === 'completed' ? 'completed' : 'unknown'),
    isTerminalStatus: (status) => status === 'completed',
    projectResult: (value) => ({
      text: value.text,
      usage: { input: 0, output: 0, tokensKnown: false, usdKnown: false },
    }),
    projectFinal: ({ runId, sequence, result }) => ({
      runId,
      eventId: `${runId}:final`,
      sequence,
      receivedAt: at,
      event: {
        type: 'final',
        task: { id: runId, intent: 'Continue the native chat' },
        status: result.success ? 'completed' : 'failed',
        reason: result.success ? 'completed' : (result.error ?? 'failed'),
        text: result.text,
        timestamp: at,
      },
    }),
  }
  const input: ExecuteTurnInput = {
    operationId: 'operation-native-next',
    runId: 'braid-run-next',
    text: 'Continue this exact Pi chat.',
    profile,
    connectionId: 'connection-native',
    workspaceRoot: '/workspace',
    sessionId: source.sessionId,
    signal: new AbortController().signal,
    nativeContextBoundaryProof: proof,
  }
  return {
    source,
    next,
    proof,
    plan,
    input,
    continuationCalls: () => continuationCalls,
    continuationRequests,
    continuationStatuses,
    reconnectCalls: () => reconnectCalls,
    statusControlRefs,
    cancellationControlRefs,
    resultCalls: () => resultCalls,
    eventsActive,
    terminalSettled: () => terminalSettled,
    releaseTerminal: () => {
      releaseTerminal()
    },
  }
}

async function collect(stream: AsyncIterable<RuntimeEventEnvelope>) {
  const events: RuntimeEventEnvelope[] = []
  for await (const event of stream) events.push(event)
  return events
}

test('retained execution continues through Runtime without creating another environment', async () => {
  const f = fixture()
  let continuedControl: AgentExactRunControlRef | undefined
  const execution = new RetainedExecutionPort({
    resolve: async () => {
      throw new Error('native continuation must not resolve a fresh plan')
    },
    continue: async (_input, controlRef) => {
      continuedControl = controlRef
      return f.plan
    },
    recover: async () => {
      throw new Error('same-process continuation must not enter restart recovery')
    },
  })

  const admission = await execution.admit(f.input)
  assert.deepEqual(continuedControl, f.source)
  assert.equal(admission.environmentId, f.source.environmentId)
  const events = await collect(execution.streamTurn(f.input))

  assert.equal(f.continuationCalls(), 1)
  assert.equal(f.reconnectCalls(), 1)
  assert.deepEqual(events[0]?.event.type, 'braid.execution.observed')
  assert.deepEqual(
    events[0]?.event.type === 'braid.execution.observed' ? events[0].event.controlRef : undefined,
    f.next,
  )
  assert.equal(events.at(-1)?.event.type, 'final')
  assert.equal(f.resultCalls(), 0)
})

test('native continuation streams and accepts controls after admission while its result is pending', async () => {
  const f = fixture({ pendingResult: true, streamEvents: true })
  const execution = new RetainedExecutionPort({
    resolve: async () => {
      throw new Error('native continuation must not resolve a fresh plan')
    },
    continue: async () => f.plan,
    recover: async () => {
      throw new Error('same-process continuation must not enter restart recovery')
    },
  })

  await execution.admit(f.input)
  const stream = execution.streamTurn(f.input)[Symbol.asyncIterator]()
  const observed = await stream.next()
  assert.equal(observed.value?.event.type, 'braid.execution.observed')
  const streamed = await stream.next()
  assert.equal(streamed.value?.event.type, 'status')
  const pendingStream = stream.next()
  await f.eventsActive

  const status = await execution.status({ runId: f.input.runId })
  assert.equal(status?.runId, f.input.runId)
  assert.deepEqual(f.statusControlRefs, [f.next])
  assert.equal(f.terminalSettled(), false)

  const cancellation = await execution.cancelRun({
    operationId: 'operation-native-next-cancel',
    runId: f.input.runId,
  })
  assert.deepEqual(cancellation, {
    operationId: 'operation-native-next-cancel',
    outcome: 'accepted',
    detail: 'cancelled',
  })
  assert.deepEqual(f.cancellationControlRefs, [f.next])
  assert.equal(f.terminalSettled(), false)

  f.releaseTerminal()
  const final = await pendingStream
  assert.equal(final.value?.event.type, 'final')
  assert.equal(f.terminalSettled(), true)
  assert.equal(f.resultCalls(), 0)
  assert.deepEqual(await stream.next(), { done: true, value: undefined })
})

test('restart reconnect retries the same continuation request and receives a replay', async () => {
  const f = fixture()
  const receipt = createAdmissionReceipt({
    runId: f.input.runId,
    turnId: 'turn-native-next',
    operationId: f.input.operationId,
    conversationId: 'conversation-native',
    branchId: 'branch-native',
    admittedAt: at,
    profile,
    connectionId: 'connection-native',
    text: f.input.text,
    sessionId: f.source.sessionId,
    capabilities: f.plan.capabilities,
    provider: f.source.provider,
    environmentId: f.source.environmentId,
    providerSessionId: f.source.sessionId,
    nativeContextBoundaryProof: f.proof,
  })
  const recover = async ({ controlRef }: { readonly controlRef?: AgentExactRunControlRef }) => {
    assert.deepEqual(controlRef, f.source)
    return f.plan
  }
  const first = new RetainedExecutionPort({
    resolve: async () => f.plan,
    continue: async () => f.plan,
    recover,
  })
  const recovery = {
    runId: f.input.runId,
    providerSessionId: f.source.sessionId,
    receipt,
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
  }
  assert.equal((await first.status(recovery))?.status, 'reconnecting')
  const accepted = await collect(first.reconnect(recovery))
  assert.equal(accepted.at(-1)?.event.type, 'final')

  const restarted = new RetainedExecutionPort({
    resolve: async () => f.plan,
    continue: async () => f.plan,
    recover,
  })
  const replayed = await collect(restarted.reconnect(recovery))
  assert.equal(replayed.at(-1)?.event.type, 'final')
  assert.equal(f.continuationCalls(), 2)
  assert.deepEqual(f.continuationStatuses, ['accepted', 'replayed'])
  assert.deepEqual(f.continuationRequests[0], f.continuationRequests[1])
  assert.equal(f.resultCalls(), 0)
})
