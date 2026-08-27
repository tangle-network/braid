import assert from 'node:assert/strict'
import test from 'node:test'
import type { RuntimeStreamEvent } from '@tangle-network/agent-runtime'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { AppError, BraidApplication } from '../src/app/application.js'
import { DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import type { RuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import { FixedClock } from '../src/ports/clock.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  type ExecutionPort,
} from '../src/ports/execution.js'
import { SequenceIds } from '../src/ports/ids.js'
import { RETAINED_RUN_HANDLE_CAPABILITIES } from './support/retained-run-capabilities.js'

const GENERIC_CAPABILITIES = {
  ...DEFAULT_RUN_CAPABILITIES,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, messages: true },
  controls: { cancel: true, steer: true, queue: true, status: true, recreate: true },
  events: { stableIdentity: true, sequence: true, cursor: true },
} as const

const NATIVE_CAPABILITIES = {
  ...GENERIC_CAPABILITIES,
  environment: {
    ...RETAINED_RUN_HANDLE_CAPABILITIES,
    sessions: { continue: true, list: false, messages: false },
    nativeContinuation: { atomicBoundary: true, requestIdempotency: true },
  },
} as const

const CONTROL_REF = {
  runId: 'pi-provider-run',
  provider: 'pi',
  environmentId: 'environment-pi',
  sessionId: 'session-pi',
  executionId: 'pi-execution',
  requestDigest: `sha256:${'b'.repeat(64)}` as const,
}

const NATIVE_PROOF = {
  ...CONTROL_REF,
  boundary: { kind: 'revision' as const, revision: 'pi-boundary:1' },
  observedAt: '2026-08-01T00:00:01.000Z',
}

function finalEvent(
  text: string,
  status: 'completed' | 'failed' = 'completed',
): RuntimeStreamEvent {
  return {
    type: 'final',
    status,
    reason: status === 'completed' ? 'complete' : 'failed',
    text,
    task: { id: 'task-tui-continuation', intent: 'test' },
    timestamp: '2026-08-01T00:00:00.000Z',
  }
}

function observedEvent(
  input: ExecuteTurnInput,
  controlRef: typeof CONTROL_REF = CONTROL_REF,
): RuntimeEventEnvelope {
  return {
    runId: input.runId,
    eventId: `${input.runId}:observed`,
    sequence: 1,
    receivedAt: '2026-08-01T00:00:00.000Z',
    event: {
      type: 'braid.execution.observed',
      observation: {
        kind: 'local-process',
        provider: CONTROL_REF.provider,
        providerEnvironmentId: CONTROL_REF.environmentId,
        lifecycle: 'ready',
        lifecycleMode: 'retained',
        cleanup: 'explicit',
        continuity: 'session',
        location: 'local',
        createdAt: '2026-08-01T00:00:00.000Z',
        observedAt: '2026-08-01T00:00:00.000Z',
        unavailable: [],
      },
      controlRef,
      timestamp: '2026-08-01T00:00:00.000Z',
    },
  }
}

function continuationExecution(
  kind: 'native' | 'generic',
  failBoundary = false,
  terminal: 'completed' | 'failed' | 'none' = 'completed',
  distinctControlRefs = false,
): {
  readonly execution: ExecutionPort
  readonly admissions: ExecuteTurnInput[]
  readonly nativeBoundaryCalls: number
} {
  const capabilities = kind === 'native' ? NATIVE_CAPABILITIES : GENERIC_CAPABILITIES
  const admissions: ExecuteTurnInput[] = []
  let nativeBoundaryCalls = 0
  const execution: ExecutionPort = {
    capabilities: () => capabilities,
    admit: (input) => {
      admissions.push(input)
      return {
        capabilities,
        provider: CONTROL_REF.provider,
        environmentId: CONTROL_REF.environmentId,
        providerSessionId: CONTROL_REF.sessionId,
      }
    },
    async *streamTurn(input): AsyncIterable<RuntimeEventEnvelope | RuntimeStreamEvent> {
      const controlRef = distinctControlRefs
        ? {
            ...CONTROL_REF,
            runId: `provider-${input.runId}`,
            executionId: `execution-${input.runId}`,
          }
        : CONTROL_REF
      if (kind === 'native' && input.nativeContextBoundaryProof === undefined)
        yield observedEvent(input, controlRef)
      if (terminal !== 'none')
        yield finalEvent(
          input.nativeContextBoundaryProof ? 'native follow-up' : 'source turn',
          terminal,
        )
    },
    ...(kind === 'native'
      ? {
          nativeBoundary: async ({ controlRef }) => {
            nativeBoundaryCalls += 1
            if (failBoundary) throw new Error('native boundary unavailable')
            if (!distinctControlRefs) return NATIVE_PROOF
            const exactControlRef = controlRef ?? CONTROL_REF
            return {
              ...exactControlRef,
              boundary: { kind: 'revision' as const, revision: 'native-boundary:1' },
              observedAt: '2026-08-01T00:00:01.000Z',
            }
          },
        }
      : {}),
  }
  return {
    execution,
    admissions,
    get nativeBoundaryCalls() {
      return nativeBoundaryCalls
    },
  }
}

function appFor(execution: ExecutionPort): BraidApplication {
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  return app
}

async function completeSource(app: BraidApplication): Promise<void> {
  await app.send({ operationId: 'operation-source', text: 'start the branch' }).completion
}

test('typed dispatch routes an exact-capable branch tip through native continuation', async () => {
  const fixture = continuationExecution('native')
  const app = appFor(fixture.execution)
  await completeSource(app)

  const result = await createApplicationUiController(app).dispatch({
    type: 'send',
    operationId: 'operation-native-follow-up',
    text: 'continue the native branch',
  })
  assert.equal(result.kind, 'accepted')
  if (result.kind !== 'accepted') return
  await result.completion

  assert.equal(fixture.nativeBoundaryCalls, 1)
  assert.equal(fixture.admissions.length, 2)
  assert.equal(fixture.admissions[1]?.sessionId, CONTROL_REF.sessionId)
  assert.deepEqual(app.state().runs.at(-1)?.receipt.nativeContextBoundaryProof, NATIVE_PROOF)
  assert.equal(app.state().runs.at(-1)?.status, 'completed')
})

test('headless send keeps a generic Tangle continuation on app.send', async () => {
  const fixture = continuationExecution('generic')
  const app = appFor(fixture.execution)
  await completeSource(app)

  const result = await createApplicationUiController(app).dispatch({
    type: 'headless-command',
    command: 'send',
    operationId: 'operation-generic-follow-up',
    params: { text: 'continue the generic branch' },
  })
  assert.equal(result.kind, 'accepted')
  if (result.kind !== 'accepted') return
  await result.completion

  assert.equal(fixture.nativeBoundaryCalls, 0)
  assert.equal(fixture.admissions.length, 2)
  assert.equal(fixture.admissions[1]?.sessionId, CONTROL_REF.sessionId)
  assert.equal(fixture.admissions[1]?.nativeContextBoundaryProof, undefined)
  assert.equal(app.state().runs.at(-1)?.status, 'completed')
})

test('an exact boundary failure is returned without a generic fallback', async () => {
  const fixture = continuationExecution('native', true)
  const app = appFor(fixture.execution)
  await completeSource(app)

  const result = await createApplicationUiController(app).dispatch({
    type: 'send',
    operationId: 'operation-native-boundary-failure',
    text: 'do not fork this branch',
  })
  assert.equal(result.kind, 'error')
  if (result.kind !== 'error') return
  assert.match(result.message, /native boundary unavailable/u)
  assert.equal(fixture.nativeBoundaryCalls, 1)
  assert.equal(fixture.admissions.length, 1)
  assert.equal(app.state().runs.length, 1)
})

test('a stale native run is rejected before the provider boundary or proof admission', async () => {
  const fixture = continuationExecution('native', false, 'completed', true)
  const app = appFor(fixture.execution)
  const first = await app.send({ operationId: 'operation-stale-source', text: 'first branch turn' })
    .completion
  const firstRun = first.runs[0]
  assert.ok(firstRun)
  const second = await app.send({ operationId: 'operation-stale-tip', text: 'new branch tip' })
    .completion
  assert.notEqual(second.runs.at(-1)?.id, firstRun.id)
  const firstControlRef = firstRun.controlRef
  const firstSessionId = firstRun.providerSessionId
  assert.ok(firstControlRef)
  assert.ok(firstSessionId)

  await assert.rejects(
    () =>
      app.continueNative({
        operationId: 'operation-stale-native',
        runId: firstRun.id,
        text: 'must not continue the stale run',
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'NATIVE_CONTINUATION_UNVERIFIED',
  )
  assert.equal(fixture.nativeBoundaryCalls, 0)

  assert.throws(
    () =>
      app.send({
        operationId: 'operation-stale-proof',
        text: 'must not admit the stale proof',
        sessionId: firstSessionId,
        nativeContextBoundaryProof: {
          ...firstControlRef,
          boundary: { kind: 'revision' as const, revision: 'stale-boundary:1' },
          observedAt: '2026-08-01T00:00:01.000Z',
        },
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'NATIVE_CONTINUATION_UNVERIFIED',
  )
  assert.equal(fixture.nativeBoundaryCalls, 0)
})

test('an incomplete native run is rejected before the provider boundary or proof admission', async () => {
  const fixture = continuationExecution('native', false, 'none')
  const app = appFor(fixture.execution)
  const source = await app.send({
    operationId: 'operation-incomplete-source',
    text: 'incomplete turn',
  }).completion
  const sourceRun = source.runs[0]
  assert.ok(sourceRun)
  assert.equal(sourceRun.status, 'unknown')
  assert.equal(sourceRun.complete, false)
  const sourceSessionId = sourceRun.providerSessionId
  assert.ok(sourceSessionId)

  await assert.rejects(
    () =>
      app.continueNative({
        operationId: 'operation-incomplete-native',
        runId: sourceRun.id,
        text: 'must not continue the incomplete run',
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'NATIVE_CONTINUATION_UNVERIFIED',
  )
  assert.equal(fixture.nativeBoundaryCalls, 0)

  assert.throws(
    () =>
      app.send({
        operationId: 'operation-incomplete-proof',
        text: 'must not admit the incomplete proof',
        sessionId: sourceSessionId,
        nativeContextBoundaryProof: NATIVE_PROOF,
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'NATIVE_CONTINUATION_UNVERIFIED',
  )
  assert.equal(fixture.nativeBoundaryCalls, 0)
})
