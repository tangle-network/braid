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
import { RandomIds } from '../src/ports/ids.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const now = '2026-08-11T12:00:00.000Z'

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
  const runId = 'run-retained-crash-window'
  const providerSessionId = 'session-existing-conversation'
  const abort = new AbortController()
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

test('detach during execution-observation persistence stops the retained reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-retained-detach-race-'))
  const bridge = await startRuntimeBridgeServer({ holdStreams: true })
  const configuration = production(bridge.endpoint)
  const abort = new AbortController()
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
