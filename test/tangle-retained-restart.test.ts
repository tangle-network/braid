import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { TangleRetainedExecutionPort } from '../src/adapters/runtime/tangle-retained-execution.js'
import {
  createDurableBraidApplication,
  type DurableBraidApplication,
} from '../src/app/composition.js'
import { isRuntimeEventEnvelope } from '../src/domain/runtime-events.js'
import type { RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import { RandomIds } from '../src/ports/ids.js'
import {
  FakeTangleRetainedSandbox,
  prepareFakeTangleRetainedConnection,
} from './support/tangle-retained-sandbox.js'

const idleTtlSeconds = 1_800
const profile = defineAgentProfile({
  name: 'Retained sandbox proof',
  harness: 'opencode',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})

function retainedExecution(sandbox: FakeTangleRetainedSandbox): TangleRetainedExecutionPort {
  const prepare = async (input: {
    readonly runId: string
    readonly providerSessionId?: string
  }) => {
    const prepared = await prepareFakeTangleRetainedConnection({
      sandbox,
      profile,
      runId: input.runId,
      idleTtlSeconds,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
    })
    return prepared
  }
  return new TangleRetainedExecutionPort({
    resolve: (input) =>
      prepare({
        runId: input.runId,
        ...(input.sessionId === undefined ? {} : { providerSessionId: input.sessionId }),
      }),
    recover: prepare,
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for retained Tangle state')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test('one retained cloud session survives restart and continues in the same sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-tangle-retained-'))
  const sandbox = new FakeTangleRetainedSandbox()
  const path = join(root, 'braid.db')
  const credentials = new MemoryCredentialStore()
  let first: DurableBraidApplication | undefined
  let restarted: DurableBraidApplication | undefined
  let cancellationRestart: DurableBraidApplication | undefined
  try {
    first = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      profile,
      execution: retainedExecution(sandbox),
      ids: new RandomIds(),
    })
    first.app.initialize(root)
    await first.app.whenDurable()

    const turn = first.app.send({
      operationId: 'operation-tangle-retained-turn',
      text: 'Keep working while Braid restarts.',
    })
    await turn.admissionReady
    await waitFor(() => sandbox.dispatches.length === 1)
    await waitFor(() => {
      const run = first?.app.state().runs.find((candidate) => candidate.id === turn.runId)
      return run?.controlRef !== undefined && (run.lastProviderSequence ?? 0) >= 2
    })
    const firstRun = first.app.state().runs.find((candidate) => candidate.id === turn.runId)
    assert.equal(firstRun?.capabilities.sessions.continue, true)
    assert.equal(firstRun?.capabilities.controls.status, false)
    assert.equal(firstRun?.capabilities.streaming.replay, true)
    assert.equal(firstRun?.capabilities.streaming.detach, true)
    assert.equal(sandbox.createCalls[0]?.idleTimeoutSeconds, idleTtlSeconds)
    assert.equal(sandbox.boxes.length, 1)
    const beforeRestart = first.app.state().runs.find((candidate) => candidate.id === turn.runId)
    assert.equal(beforeRestart?.controlRef?.environmentId, sandbox.boxes[0]?.id)
    const detached = await first.app.detachRun({
      operationId: 'operation-tangle-retained-detach',
      runId: turn.runId,
    })
    await detached.completion
    await turn.completion
    assert.equal(
      first.app.state().runs.find((candidate) => candidate.id === turn.runId)?.status,
      'detached',
    )
    await first.app.close()
    first = undefined

    sandbox.complete(sandbox.dispatches[0]?.executionId ?? '', 'SURVIVED_RESTART')
    restarted = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      profile,
      execution: retainedExecution(sandbox),
      ids: new RandomIds(),
    })
    const restored = restarted.app.state().runs.find((candidate) => candidate.id === turn.runId)
    assert.equal(restored?.status, 'detached')
    assert.deepEqual(restored?.controlRef, beforeRestart?.controlRef)

    await restarted.app.reconnectRun({
      operationId: 'operation-tangle-retained-reconnect',
      runId: turn.runId,
    })
    const completed = restarted.app.state()
    assert.equal(
      completed.runs.find((candidate) => candidate.id === turn.runId)?.status,
      'completed',
    )
    assert.equal(completed.messages.at(-1)?.text, 'SURVIVED_RESTART')
    assert.deepEqual(completed.missingHistory, [])
    assert.equal(
      restarted.app
        .events()
        .filter((entry) => entry.event.kind === 'run.finished' && entry.event.runId === turn.runId)
        .length,
      1,
    )
    assert.equal(sandbox.dispatches.length, 1)

    const followUp = restarted.app.send({
      operationId: 'operation-tangle-retained-follow-up',
      text: 'Continue in the same retained workspace.',
    })
    await followUp.admissionReady
    await waitFor(() => sandbox.dispatches.length === 2)
    const followUpDispatch = sandbox.dispatches[1]
    assert.equal(followUpDispatch?.sessionId, beforeRestart?.providerSessionId)
    assert.equal(followUpDispatch?.boxId, sandbox.boxes[0]?.id)
    assert.notEqual(followUpDispatch?.executionId, sandbox.dispatches[0]?.executionId)
    assert.equal(sandbox.boxes.length, 1)
    sandbox.complete(followUpDispatch?.executionId ?? '', 'CONTINUED_AFTER_RESTART')
    await followUp.completion

    const followUpRun = restarted.app
      .state()
      .runs.find((candidate) => candidate.id === followUp.runId)
    assert.equal(followUpRun?.status, 'completed')
    assert.equal(followUpRun?.providerSessionId, beforeRestart?.providerSessionId)
    assert.equal(restarted.app.state().messages.at(-1)?.text, 'CONTINUED_AFTER_RESTART')
    assert.equal(sandbox.boxes.length, 1)

    const cancellationTarget = restarted.app.send({
      operationId: 'operation-tangle-retained-cancel-target',
      text: 'Remain active until this run is cancelled.',
    })
    await cancellationTarget.admissionReady
    await waitFor(() => sandbox.dispatches.length === 3)
    await waitFor(
      () =>
        restarted?.app.state().runs.find((candidate) => candidate.id === cancellationTarget.runId)
          ?.controlRef !== undefined,
    )
    const cancellation = await restarted.app.cancelRun({
      operationId: 'operation-tangle-retained-cancel',
      runId: cancellationTarget.runId,
      reason: 'Prove cancellation replay after a state snapshot.',
      terminalStatus: 'aborted',
    })
    await cancellation.completion
    await cancellationTarget.completion
    assert.equal(cancellation.replayed, false)
    assert.equal(cancellation.acknowledgement.outcome, 'accepted')
    assert.equal(
      restarted.app.state().runs.find((candidate) => candidate.id === cancellationTarget.runId)
        ?.status,
      'aborted',
    )
    await restarted.app.close()
    restarted = undefined

    cancellationRestart = await createDurableBraidApplication({
      path,
      workspaceRoot: root,
      credentialStore: credentials,
      profile,
      execution: retainedExecution(sandbox),
      ids: new RandomIds(),
    })
    const replay = await cancellationRestart.app.cancelRun({
      operationId: 'operation-tangle-retained-cancel',
      runId: cancellationTarget.runId,
      reason: 'Prove cancellation replay after a state snapshot.',
      terminalStatus: 'aborted',
    })
    assert.equal(replay.replayed, true)
    assert.equal(replay.acknowledgement.outcome, 'accepted')
    await assert.rejects(
      cancellationRestart.app.cancelRun({
        operationId: 'operation-tangle-retained-cancel',
        runId: cancellationTarget.runId,
        reason: 'Changed cancellation body.',
        terminalStatus: 'aborted',
      }),
      /different input/u,
    )
    assert.equal(sandbox.cancellations.length, 1)
  } finally {
    await first?.app.close().catch(() => undefined)
    await restarted?.app.close().catch(() => undefined)
    await cancellationRestart?.app.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('provider lookup recovers the pre-journal crash window without a saved reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-tangle-crash-window-'))
  const sandbox = new FakeTangleRetainedSandbox()
  const runId = 'run-tangle-crash-window'
  const providerRunId = 'provider-run-tangle-crash-window'
  sandbox.providerRunId = providerRunId
  const providerSessionId = 'session-braid-existing-conversation'
  const abort = new AbortController()
  const admissions: RetainedRunAdmissionRecord[] = []
  try {
    const first = retainedExecution(sandbox)
    if (first.admit === undefined) throw new Error('Retained admission is unavailable')
    const input = {
      operationId: 'operation-tangle-crash-window',
      runId,
      text: 'Continue the existing retained conversation.',
      profile,
      workspaceRoot: root,
      sessionId: providerSessionId,
      signal: abort.signal,
      onRetainedAdmission: async (admission: RetainedRunAdmissionRecord) => {
        admissions.push(structuredClone(admission))
      },
    }
    const admission = await first.admit(input)
    assert.equal(admission.providerSessionId, providerSessionId)
    assert.equal(sandbox.boxes.length, 0)

    const stream = first.streamTurn(input)[Symbol.asyncIterator]()
    const observed = await stream.next()
    assert.equal(observed.done, false)
    const event =
      observed.value !== undefined && isRuntimeEventEnvelope(observed.value)
        ? observed.value.event
        : undefined
    assert.equal(event?.type, 'braid.execution.observed')
    const controlRef = event?.type === 'braid.execution.observed' ? event.controlRef : undefined
    assert.equal(controlRef?.sessionId, providerSessionId)
    assert.equal(controlRef?.runId, providerRunId)
    assert.deepEqual(
      admissions.map((admission) => admission.phase),
      ['environment', 'dispatched'],
    )
    await stream.return?.(undefined)

    const restarted = retainedExecution(sandbox)
    if (restarted.status === undefined || restarted.cancelRun === undefined) {
      throw new Error('Retained recovery controls are unavailable')
    }
    assert.equal(await restarted.status({ runId, providerSessionId }), null)
    assert.equal(await restarted.status({ runId, providerSessionId, controlRef }), null)
    const cancelled = await restarted.cancelRun({
      operationId: 'operation-tangle-crash-window-cancel',
      runId,
      providerSessionId,
    })
    assert.equal(cancelled.outcome, 'accepted')
    assert.equal(sandbox.cancellations.length, 1)
    assert.equal(sandbox.cancellations[0]?.run.runId, providerRunId)
  } finally {
    abort.abort()
    await rm(root, { recursive: true, force: true })
  }
})
