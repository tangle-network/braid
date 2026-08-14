import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type AgentExactRunControlRef, defineAgentProfile } from '@tangle-network/agent-interface'
import type { RetainedRunHandle } from '@tangle-network/agent-runtime/kernel'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import {
  type RetainedExecutionPlan,
  RetainedExecutionPort,
} from '../src/adapters/runtime/retained-execution.js'
import { finalRetainedEnvelope } from '../src/adapters/runtime/retained-execution-projection.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { providerEventFor } from '../src/app/run-event-mapper.js'
import {
  createDurableBraidApplication,
  type DurableBraidApplication,
} from '../src/app/composition.js'
import {
  createProductionComposition,
  type ProductionCompositionConfig,
} from '../src/app/production-composition.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import { isFinalRuntimeEvent, isRuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type RetainedRunAdmissionRecord,
} from '../src/ports/execution.js'
import { RandomIds } from '../src/ports/ids.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const now = '2026-08-11T12:00:00.000Z'

test('retained CLI Bridge cancellation stays cancelled in the final projection', () => {
  const envelope = finalRetainedEnvelope(
    'retained-cancel',
    1,
    'openai/gpt-5',
    {
      text: '',
      success: false,
      error: 'cli-bridge run ended cancelled',
      metadata: {
        runId: 'retained-cancel',
        executionId: 'retained-cancel',
        status: 'cancelled',
      },
    },
    'Execute the retained CLI Bridge turn',
  )

  if (!isRuntimeEventEnvelope(envelope) || !isFinalRuntimeEvent(envelope.event)) {
    throw new Error('Retained cancellation did not produce a final runtime event')
  }
  const final = envelope.event
  assert.deepEqual(
    { type: final.type, status: final.status, reason: final.reason },
    { type: 'final', status: 'cancelled', reason: 'cli-bridge run ended cancelled' },
  )
  const mapped = providerEventFor('retained-cancel', final, {
    eventId: 'retained-cancel:final',
    providerSequence: 1,
    receivedAt: now,
  })
  if (mapped.kind !== 'run.finished') throw new Error('Retained final event was not terminal')
  assert.equal(mapped.status, 'cancelled')
})

function recordAdmissions(target: RetainedRunAdmissionRecord[]) {
  return async (admission: RetainedRunAdmissionRecord): Promise<void> => {
    target.push(structuredClone(admission))
  }
}

function production(endpoint: string): ProductionCompositionConfig {
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-retained-restart'),
    kind: 'cli-bridge',
    name: 'Local CLI Bridge',
    endpoint,
    providerOptions: { transport: 'local' },
    createdAt: now,
    updatedAt: now,
    lastHealth: { status: 'unknown' },
  }
  return {
    profile: defineAgentProfile({
      name: 'Retained restart proof',
      harness: 'pi',
      model: { provider: 'openai', default: 'openai/gpt-5' },
    }),
    connections: [connection],
    connectionId: connection.id,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for retained CLI Bridge state')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function recoveryPlan(controlRef: AgentExactRunControlRef): RetainedExecutionPlan {
  const handle: RetainedRunHandle = {
    controlRef,
    async status() {
      return {
        runId: controlRef.runId,
        controlRef,
        status: 'running',
        effect: 'unknown',
        observedAt: now,
      }
    },
    async *events() {},
    async result() {
      return { text: '', success: true }
    },
    async respondToInteraction() {
      throw new Error('interaction is not part of this recovery test')
    },
    async contextBoundary() {
      return null
    },
    async continueNative() {
      throw new Error('native continuation is not part of this recovery test')
    },
    async cancel() {
      throw new Error('cancellation is not part of this recovery test')
    },
  }
  return {
    providerName: controlRef.provider,
    environmentId: controlRef.environmentId,
    providerSessionId: controlRef.sessionId,
    model: 'cloud-model',
    capabilities: DEFAULT_RUN_CAPABILITIES,
    materializationReceipt: { environmentId: controlRef.environmentId },
    start: async () => handle,
    reconnect: async (requested) => {
      assert.deepEqual(requested, controlRef)
      return handle
    },
    discover: async () => controlRef,
    observe: async () => undefined,
    projectStatus: () => 'streaming',
    isTerminalStatus: () => false,
    projectResult: (result) => ({
      text: result.text,
      usage: { input: 0, output: 0 },
    }),
    projectFinal: () => {
      throw new Error('final projection is not part of this recovery test')
    },
  }
}

test('retained recovery passes the exact provider reference into plan construction', async () => {
  const localRunId = 'braid/local-recovery-key'
  const controlRef: AgentExactRunControlRef = {
    runId: 'cloud-provider-random-run',
    provider: 'cloud-provider',
    environmentId: 'cloud-server-issued-environment',
    sessionId: 'cloud-session-1',
    executionId: 'cloud-execution-1',
    requestDigest: `sha256:${'b'.repeat(64)}`,
  }
  let recoveredRunId: string | undefined
  let recoveredEnvironmentId: string | undefined
  const execution = new RetainedExecutionPort({
    resolve: async () => {
      throw new Error('fresh admission is not part of this recovery test')
    },
    recover: async ({ runId, controlRef: exact }) => {
      recoveredRunId = runId
      recoveredEnvironmentId = exact?.environmentId
      if (exact === undefined) throw new Error('recovery lost the exact provider reference')
      return recoveryPlan(exact)
    },
  })

  const snapshot = await execution.status({
    runId: localRunId,
    providerSessionId: controlRef.sessionId,
    controlRef,
  })
  assert.equal(recoveredRunId, localRunId)
  assert.equal(recoveredEnvironmentId, controlRef.environmentId)
  assert.equal(snapshot?.runId, localRunId)
  assert.equal(snapshot?.sessionId, controlRef.sessionId)
})

test('durable Braid detaches, restarts, and resumes one retained CLI Bridge job exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-restart-'))
  const bridge = await startRuntimeBridgeServer({
    holdStreams: true,
    responseText: 'SURVIVED_RESTART',
  })
  const configuration = production(bridge.endpoint)
  const path = join(root, 'braid.db')
  const credentials = new MemoryCredentialStore()
  let first: DurableBraidApplication | undefined
  let restarted: DurableBraidApplication | undefined
  try {
    first = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      production: configuration,
      ids: new RandomIds(),
    })
    first.app.initialize(root)
    await first.app.whenDurable()
    const send = first.app.send({
      operationId: 'operation-retained-restart-send',
      text: 'Keep working while Braid restarts.',
    })
    await send.admissionReady
    await waitFor(() => (first?.app.state().runs[0]?.lastProviderSequence ?? 0) >= 2)

    const beforeDetach = first.app.state().runs[0]
    assert.equal(beforeDetach?.lastCursor, '1:0')
    assert.equal(beforeDetach?.controlRef?.runId, send.runId)
    assert.equal(bridge.requests.length, 1)

    const detached = await first.app.detachRun({
      operationId: 'operation-retained-restart-detach',
      runId: send.runId,
    })
    await detached.completion
    await send.completion
    assert.equal(first.app.state().runs[0]?.status, 'detached')
    assert.equal(createApplicationUiController(first.app).view().status, 'detached')
    await first.app.close()
    first = undefined

    restarted = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      production: configuration,
      ids: new RandomIds(),
    })
    const restored = restarted.app.state().runs[0]
    assert.equal(restored?.status, 'detached')
    assert.equal(restored?.controlRef?.runId, send.runId)
    const controller = createApplicationUiController(restarted.app)
    assert.equal(controller.view().status, 'detached')
    assert.equal(controller.view().runs[0]?.status, 'detached')
    assert.equal(controller.view().capabilities['run.reconnect']?.available, true)

    const reconnection = controller.dispatch({
      type: 'run-command',
      operationId: 'operation-retained-restart-reconnect',
      command: 'reconnect',
      args: [],
    })
    await waitFor(() => bridge.replays.length >= 2)
    bridge.complete(send.runId)
    const result = await reconnection
    assert.equal(result.kind, 'accepted')
    const completed = restarted.app.state()

    assert.equal(bridge.requests.length, 1)
    assert.equal(completed.runs[0]?.status, 'completed')
    assert.equal(completed.runs[0]?.llmCalls, 1)
    assert.equal(completed.runs[0]?.lastCursor, '1:0')
    assert.equal(completed.messages.at(-1)?.text, 'SURVIVED_RESTART')
    assert.deepEqual(completed.missingHistory, [])
    assert.equal(
      restarted.app
        .events()
        .filter((entry) => entry.event.kind === 'run.finished' && entry.event.runId === send.runId)
        .length,
      1,
    )

    const followUp = restarted.app.send({
      operationId: 'operation-retained-restart-follow-up',
      text: 'Continue in the same provider session.',
    })
    await followUp.admissionReady
    await waitFor(() => bridge.requests.length === 2)
    bridge.complete()
    await followUp.completion
    assert.equal(bridge.requests.length, 2)
    assert.equal(typeof bridge.requests[0]?.sessionId, 'string')
    assert.equal(bridge.requests[1]?.sessionId, bridge.requests[0]?.sessionId)
    assert.equal(restarted.app.state().runs.at(-1)?.status, 'completed')
    assert.equal(restarted.app.state().runs.at(-1)?.llmCalls, 1)
  } finally {
    await first?.app.close().catch(() => undefined)
    await restarted?.app.close().catch(() => undefined)
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('restart discovery preserves a continued provider session before the control reference is journaled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-crash-window-'))
  const bridge = await startRuntimeBridgeServer({ holdStreams: true })
  const configuration = production(bridge.endpoint)
  const runId = 'run/retained-crash-window'
  const providerSessionId = 'session-existing-conversation'
  const abort = new AbortController()
  const admissions: RetainedRunAdmissionRecord[] = []
  try {
    const first = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (first.execution.admit === undefined) throw new Error('Retained admission is unavailable')
    const input = {
      operationId: 'operation-retained-crash-window',
      runId,
      text: 'Continue the existing conversation.',
      profile: configuration.profile,
      connectionId: configuration.connectionId,
      workspaceRoot: root,
      sessionId: providerSessionId,
      signal: abort.signal,
      onRetainedAdmission: recordAdmissions(admissions),
    }
    const admission = await first.execution.admit(input)
    assert.equal(admission.providerSessionId, providerSessionId)

    const stream = first.execution.streamTurn(input)[Symbol.asyncIterator]()
    const unjournaledObservation = await stream.next()
    assert.equal(unjournaledObservation.done, false)
    assert.equal(
      unjournaledObservation.value !== undefined &&
        isRuntimeEventEnvelope(unjournaledObservation.value) &&
        unjournaledObservation.value.event.type,
      'braid.execution.observed',
    )
    assert.equal(bridge.requests[0]?.sessionId, providerSessionId)
    assert.deepEqual(
      admissions.map((entry) => entry.phase),
      ['environment', 'dispatched'],
    )
    await stream.return?.()

    const restarted = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (restarted.execution.status === undefined || restarted.execution.cancelRun === undefined) {
      throw new Error('Retained recovery controls are unavailable')
    }
    const snapshot = await restarted.execution.status({ runId, providerSessionId })
    assert.equal(snapshot?.runId, runId)
    assert.equal(snapshot?.sessionId, providerSessionId)
    assert.equal(snapshot?.status, 'streaming')

    const cancellation = await restarted.execution.cancelRun({
      operationId: 'operation-retained-crash-window-cancel',
      runId,
      providerSessionId,
    })
    assert.equal('outcome' in cancellation ? cancellation.outcome : cancellation.status, 'accepted')
    assert.equal(bridge.cancellations.length, 1)
    assert.equal(bridge.requests.length, 1)
  } finally {
    abort.abort()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('restart discovery rejects a status response for another CLI Bridge run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-foreign-run-'))
  const bridge = await startRuntimeBridgeServer({
    holdStreams: true,
    statusRunId: 'foreign-provider-run',
  })
  const configuration = production(bridge.endpoint)
  const runId = 'run/retained-foreign-identity'
  const abort = new AbortController()
  const admissions: RetainedRunAdmissionRecord[] = []
  try {
    const first = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (first.execution.admit === undefined) throw new Error('Retained admission is unavailable')
    const input = {
      operationId: 'operation-retained-foreign-identity',
      runId,
      text: 'Keep this exact run isolated.',
      profile: configuration.profile,
      connectionId: configuration.connectionId,
      workspaceRoot: root,
      signal: abort.signal,
      onRetainedAdmission: recordAdmissions(admissions),
    }
    await first.execution.admit(input)
    const stream = first.execution.streamTurn(input)[Symbol.asyncIterator]()
    await stream.next()
    await stream.return?.()

    const restarted = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (restarted.execution.status === undefined) {
      throw new Error('Retained recovery controls are unavailable')
    }
    await assert.rejects(restarted.execution.status({ runId }), /another run identity/u)
    assert.equal(bridge.requests.length, 1)
  } finally {
    bridge.complete()
    abort.abort()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('detach during execution-observation persistence stops the retained reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-detach-race-'))
  const bridge = await startRuntimeBridgeServer({ holdStreams: true })
  const configuration = production(bridge.endpoint)
  const abort = new AbortController()
  const admissions: RetainedRunAdmissionRecord[] = []
  try {
    const composition = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (
      composition.execution.admit === undefined ||
      composition.execution.detachRun === undefined
    ) {
      throw new Error('Retained admission or detach control is unavailable')
    }
    const input = {
      operationId: 'operation-retained-detach-race',
      runId: 'run-retained-detach-race',
      text: 'Keep this run alive while Braid persists its control reference.',
      profile: configuration.profile,
      connectionId: configuration.connectionId,
      workspaceRoot: root,
      signal: abort.signal,
      onRetainedAdmission: recordAdmissions(admissions),
    }
    await composition.execution.admit(input)

    const stream = composition.execution.streamTurn(input)[Symbol.asyncIterator]()
    const observation = await stream.next()
    assert.equal(observation.done, false)
    assert.equal(
      observation.value !== undefined &&
        isRuntimeEventEnvelope(observation.value) &&
        observation.value.event.type,
      'braid.execution.observed',
    )

    const detached = await composition.execution.detachRun({
      operationId: 'operation-retained-detach-race-control',
      runId: input.runId,
    })
    assert.equal(detached.outcome, 'accepted')
    await assert.rejects(
      stream.next(),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )
    assert.equal(bridge.requests.length, 1)
  } finally {
    abort.abort()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('retained control keeps provider-owned identity separate from the Braid run id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-provider-identity-'))
  const bridge = await startRuntimeBridgeServer({ holdStreams: true })
  const configuration = production(bridge.endpoint)
  const runId = 'run/provider-owned-identity'
  const providerSessionId = 'session-provider-owned-identity'
  const abort = new AbortController()
  const admissions: RetainedRunAdmissionRecord[] = []
  try {
    const composition = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (composition.execution.admit === undefined) {
      throw new Error('Retained admission is unavailable')
    }
    const input = {
      operationId: 'operation-retained-provider-identity',
      runId,
      text: 'Keep the provider identity exact.',
      profile: configuration.profile,
      connectionId: configuration.connectionId,
      workspaceRoot: root,
      sessionId: providerSessionId,
      signal: abort.signal,
      onRetainedAdmission: recordAdmissions(admissions),
    }
    await composition.execution.admit(input)
    const stream = composition.execution.streamTurn(input)[Symbol.asyncIterator]()
    const observation = await stream.next()
    if (
      observation.done ||
      observation.value === undefined ||
      !isRuntimeEventEnvelope(observation.value) ||
      observation.value.event.type !== 'braid.execution.observed' ||
      observation.value.event.controlRef === undefined
    ) {
      throw new Error('Retained execution did not emit an exact control reference')
    }
    const controlRef = observation.value.event.controlRef
    assert.notEqual(controlRef.runId, runId)
    assert.equal(controlRef.provider, 'cli-bridge')
    assert.equal(controlRef.sessionId, providerSessionId)

    bridge.complete(controlRef.runId)
    const providerEvent = await stream.next()
    assert.equal(providerEvent.done, false)
    if (providerEvent.value === undefined || !isRuntimeEventEnvelope(providerEvent.value)) {
      throw new Error('Retained execution did not emit a provider event envelope')
    }
    assert.equal(providerEvent.value.runId, runId)

    if (composition.execution.status === undefined)
      throw new Error('Retained status is unavailable')
    await assert.rejects(
      composition.execution.status({
        runId,
        controlRef: { ...controlRef, executionId: `${controlRef.executionId}-changed` },
      }),
      /conflicts with the saved run/u,
    )
    await stream.return?.()
  } finally {
    abort.abort()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('cancel_requested remains an unconfirmed Braid outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-cancel-requested-'))
  const bridge = await startRuntimeBridgeServer({
    holdStreams: true,
    cancellation: { effect: 'cancel_requested' },
  })
  const configuration = production(bridge.endpoint)
  const abort = new AbortController()
  const admissions: RetainedRunAdmissionRecord[] = []
  try {
    const composition = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (
      composition.execution.admit === undefined ||
      composition.execution.cancelRun === undefined
    ) {
      throw new Error('Retained admission or cancellation is unavailable')
    }
    const input = {
      operationId: 'operation-retained-cancel-requested',
      runId: 'run-retained-cancel-requested',
      text: 'Remain live until cancellation is confirmed.',
      profile: configuration.profile,
      connectionId: configuration.connectionId,
      workspaceRoot: root,
      signal: abort.signal,
      onRetainedAdmission: recordAdmissions(admissions),
    }
    await composition.execution.admit(input)
    const stream = composition.execution.streamTurn(input)[Symbol.asyncIterator]()
    const observation = await stream.next()
    assert.equal(observation.done, false)

    const cancellation = await composition.execution.cancelRun({
      operationId: 'operation-retained-cancel-requested-control',
      runId: input.runId,
    })
    assert.equal('outcome' in cancellation ? cancellation.outcome : cancellation.status, 'unknown')
    assert.equal('outcome' in cancellation ? cancellation.detail : undefined, 'cancel_requested')
    if (composition.execution.status === undefined)
      throw new Error('Retained status is unavailable')
    assert.equal((await composition.execution.status({ runId: input.runId }))?.status, 'streaming')
    await stream.return?.()
  } finally {
    abort.abort()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
