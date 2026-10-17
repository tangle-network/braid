import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
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
import { isRuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import type { ExecutionPort, RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import { RandomIds } from '../src/ports/ids.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const now = '2026-08-11T12:00:00.000Z'

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
      turnId: 'turn-retained-crash-window',
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
      ['intent', 'environment', 'dispatched'],
    )
    await stream.return?.()

    const restarted = createProductionComposition({ ...configuration, workspaceRoot: root })
    if (restarted.execution.status === undefined || restarted.execution.cancelRun === undefined) {
      throw new Error('Retained recovery controls are unavailable')
    }
    const environmentAdmission = admissions.find((entry) => entry.phase === 'environment')
    if (environmentAdmission === undefined) {
      throw new Error('The environment admission was not retained')
    }
    const snapshot = await restarted.execution.status({
      runId,
      providerSessionId,
      retainedAdmission: environmentAdmission,
    })
    assert.equal(snapshot?.runId, runId)
    assert.equal(snapshot?.sessionId, providerSessionId)
    assert.equal(snapshot?.status, 'streaming')

    const cancellation = await restarted.execution.cancelRun({
      operationId: 'operation-retained-crash-window-cancel',
      runId,
      providerSessionId,
      retainedAdmission: environmentAdmission,
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
      turnId: 'turn-retained-foreign-identity',
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
    const environmentAdmission = admissions.find((entry) => entry.phase === 'environment')
    if (environmentAdmission === undefined) {
      throw new Error('The environment admission was not retained')
    }
    await assert.rejects(
      restarted.execution.status({ runId, retainedAdmission: environmentAdmission }),
      /another (?:retained )?run identity/u,
    )
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
      turnId: 'turn-retained-detach-race',
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
      turnId: 'turn-retained-provider-identity',
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
      turnId: 'turn-retained-cancel-requested',
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

/** The production execution port with short watchdog bounds, so the test runs in milliseconds. */
function withWatchdogBounds(execution: ExecutionPort, boundMs: number): ExecutionPort {
  return new Proxy(execution, {
    get(target, property) {
      if (property === 'streamIdleMs' || property === 'statusTimeoutMs') return boundMs
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('a restarted reconnect fails typed within the bound when the provider never answers, then acknowledges a provider-confirmed re-attach', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-reattach-bound-'))
  const bridgeOptions = { holdStreams: true, holdStatus: false }
  const bridge = await startRuntimeBridgeServer(bridgeOptions)
  const configuration = production(bridge.endpoint)
  const path = join(root, 'braid.db')
  const credentials = new MemoryCredentialStore()
  const boundMs = 200
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
      operationId: 'operation-reattach-bound-send',
      text: 'Keep working while Braid restarts.',
    })
    await send.admissionReady
    await waitFor(() => (first?.app.state().runs[0]?.lastProviderSequence ?? 0) >= 2)
    const detached = await first.app.detachRun({
      operationId: 'operation-reattach-bound-detach',
      runId: send.runId,
    })
    await detached.completion
    await send.completion
    await first.app.close()
    first = undefined

    restarted = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      production: configuration,
      execution: withWatchdogBounds(
        createProductionComposition({ ...configuration, workspaceRoot: root }).execution,
        boundMs,
      ),
      ids: new RandomIds(),
    })
    const controller = createApplicationUiController(restarted.app)

    // The replay is silent and the provider never answers its status read.
    bridgeOptions.holdStatus = true
    const replaysBefore = bridge.replays.length
    const started = performance.now()
    const failed = await controller.dispatch({
      type: 'headless-command',
      command: 'reconnect',
      operationId: 'operation-reattach-bound-unanswered',
      params: { runId: send.runId },
    })
    const elapsedMs = performance.now() - started
    assert.equal(failed.kind, 'error', JSON.stringify(failed))
    assert.equal(failed.kind === 'error' ? failed.code : undefined, 'RECONNECT_FAILED')
    assert.equal(failed.kind === 'error' ? failed.retryable : undefined, true)
    assert.match(
      failed.kind === 'error' ? failed.message : '',
      /could not be re-attached: provider stream lost; the status read timed out/u,
    )
    // One idle bound, then one status read: far inside the 180s the stress proof waited.
    assert.ok(elapsedMs < 2 * boundMs + 2_000, `reconnect settled after ${elapsedMs}ms`)
    assert.ok(bridge.replays.length > replaysBefore, 'the reconnect never asked for a replay')
    assert.equal(restarted.app.state().runs[0]?.status, 'unknown')

    // The replay stays silent, but the provider now confirms the run: the reconnect is
    // acknowledged while the run is still live, instead of only once it settles.
    bridgeOptions.holdStatus = false
    const confirmed = await controller.dispatch({
      type: 'headless-command',
      command: 'reconnect',
      operationId: 'operation-reattach-bound-confirmed',
      params: { runId: send.runId },
    })
    assert.equal(confirmed.kind, 'accepted', JSON.stringify(confirmed))
    assert.equal(restarted.app.state().runs[0]?.status, 'reconnecting')
    assert.equal(restarted.app.storageFailure(), undefined)
    assert.equal(bridge.requests.length, 1)
  } finally {
    await first?.app.close().catch(() => undefined)
    await restarted?.app.close().catch(() => undefined)
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})
