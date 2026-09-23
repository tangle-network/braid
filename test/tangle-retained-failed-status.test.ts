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
import { RandomIds } from '../src/ports/ids.js'
import {
  FakeTangleRetainedSandbox,
  prepareFakeTangleRetainedConnection,
} from './support/tangle-retained-sandbox.js'

const profile = defineAgentProfile({
  name: 'Retained failed status',
  harness: 'opencode',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})

// Production shape measured on Tangle Sandbox 2026-09-23: the stream reports `status: failed`
// before the exact result, and the result carries the failure text.
const FAILURE =
  'Trusted pricing is unavailable for the direct provider selected for model "tangle-router/glm-5.3".'

function openApp(
  sandbox: FakeTangleRetainedSandbox,
  root: string,
  credentialStore: MemoryCredentialStore,
): Promise<DurableBraidApplication> {
  const prepare = (input: { readonly runId: string; readonly providerSessionId?: string }) =>
    prepareFakeTangleRetainedConnection({
      sandbox,
      profile,
      runId: input.runId,
      idleTtlSeconds: 1_800,
      ...(input.providerSessionId === undefined
        ? {}
        : { providerSessionId: input.providerSessionId }),
    })
  return createDurableBraidApplication({
    path: join(root, 'braid.db'),
    workspaceRoot: root,
    credentialStore,
    profile,
    execution: new TangleRetainedExecutionPort({
      resolve: (input) =>
        prepare({
          runId: input.runId,
          ...(input.sessionId === undefined ? {} : { providerSessionId: input.sessionId }),
        }),
      recover: prepare,
    }),
    ids: new RandomIds(),
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for retained state')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function runTrail(opened: DurableBraidApplication, runId: string) {
  return opened.app
    .events()
    .filter((entry) => 'runId' in entry.event && entry.event.runId === runId)
    .map((entry) => entry.event)
}

test('a retained run that streams status failed records the exact result failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-tangle-failed-'))
  const sandbox = new FakeTangleRetainedSandbox()
  const opened = await openApp(sandbox, root, new MemoryCredentialStore())
  try {
    opened.app.initialize(root)
    await opened.app.whenDurable()
    const turn = opened.app.send({ operationId: 'operation-failed-status', text: 'Reply DONE.' })
    await turn.admissionReady
    await waitFor(() => sandbox.dispatches.length > 0)
    sandbox.fail(sandbox.dispatches[0]?.executionId ?? '', FAILURE)
    await turn.completion
    const run = opened.app.state().runs.find((candidate) => candidate.id === turn.runId)
    const trail = runTrail(opened, turn.runId)
    const kinds = trail.map((event) => event.kind).join('\n')
    assert.equal(run?.status, 'failed', kinds)
    assert.equal(run?.complete, true, kinds)
    // The status frame alone carries no result; the exact result's failure must reach the run.
    assert.equal(trail.filter((event) => event.kind === 'run.finished').length, 1, kinds)
    // Braid persists typed diagnostics, never provider prose, so the result failure arrives as codes.
    assert.equal(run?.error, 'RUNTIME_FINAL_ERROR', kinds)
    assert.equal(run?.terminalReason, 'RUNTIME_FINAL_REASON', kinds)
    assert.equal(opened.app.state().lastError, run?.error)
  } finally {
    await opened.app.close()
    await rm(root, { recursive: true, force: true })
  }
})

for (const outcome of ['failed', 'completed'] as const) {
  test(`restart reads the final result of a run that exited terminal by status (provider ${outcome})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'braid-tangle-failed-restart-'))
    const sandbox = new FakeTangleRetainedSandbox()
    const credentials = new MemoryCredentialStore()
    let first: DurableBraidApplication | undefined
    let restarted: DurableBraidApplication | undefined
    try {
      first = await openApp(sandbox, root, credentials)
      first.app.initialize(root)
      await first.app.whenDurable()
      const turn = first.app.send({ operationId: 'operation-failed-restart', text: 'Reply DONE.' })
      await turn.admissionReady
      await waitFor(() => sandbox.dispatches.length > 0)
      const executionId = sandbox.dispatches[0]?.executionId ?? ''
      // Braid exits after it commits `status: failed` and before the final event arrives.
      sandbox.reportFailure(executionId, FAILURE)
      const app = first.app
      await waitFor(
        () =>
          app.state().runs.find((candidate) => candidate.id === turn.runId)?.status === 'failed',
      )
      await first.app.whenDurable()
      const before = runTrail(first, turn.runId)
      assert.equal(before.filter((event) => event.kind === 'run.finished').length, 0)
      await first.app.close()
      first = undefined

      if (outcome === 'failed') sandbox.fail(executionId, FAILURE)
      else sandbox.complete(executionId, 'DONE')
      restarted = await openApp(sandbox, root, credentials)
      await restarted.app.whenDurable()
      const run = restarted.app.state().runs.find((candidate) => candidate.id === turn.runId)
      const trail = runTrail(restarted, turn.runId)
      const kinds = trail.map((event) => event.kind).join('\n')
      // The committed terminal status never regresses, whatever the provider replays.
      assert.equal(run?.status, 'failed', kinds)
      assert.equal(run?.complete, true, kinds)
      assert.equal(
        trail.some((event) => event.kind === 'run.reconnecting' || event.kind === 'run.unknown'),
        false,
        kinds,
      )
      const finished = trail.filter((event) => event.kind === 'run.finished')
      if (outcome === 'failed') {
        assert.equal(finished.length, 1, kinds)
        assert.equal(run?.error, 'RUNTIME_FINAL_ERROR', kinds)
        assert.equal(run?.terminalReason, 'RUNTIME_FINAL_REASON', kinds)
      } else {
        // A final that contradicts the committed status is not ingested.
        assert.equal(finished.length, 0, kinds)
        assert.equal(run?.error, undefined, kinds)
      }
    } finally {
      await first?.app.close()
      await restarted?.app.close()
      await rm(root, { recursive: true, force: true })
    }
  })
}
