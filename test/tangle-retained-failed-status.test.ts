import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { TangleRetainedExecutionPort } from '../src/adapters/runtime/tangle-retained-execution.js'
import { createDurableBraidApplication } from '../src/app/composition.js'
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

test('a retained run that streams status failed records the exact result failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-tangle-failed-'))
  const sandbox = new FakeTangleRetainedSandbox()
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
  const opened = await createDurableBraidApplication({
    path: join(root, 'braid.db'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
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
  try {
    opened.app.initialize(root)
    await opened.app.whenDurable()
    const turn = opened.app.send({ operationId: 'operation-failed-status', text: 'Reply DONE.' })
    await turn.admissionReady
    const deadline = Date.now() + 5_000
    while (sandbox.dispatches.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2))
    sandbox.fail(sandbox.dispatches[0]?.executionId ?? '', FAILURE)
    await turn.completion
    const run = opened.app.state().runs.find((candidate) => candidate.id === turn.runId)
    const trail = opened.app
      .events()
      .filter((entry) => 'runId' in entry.event && entry.event.runId === turn.runId)
      .map((entry) => entry.event)
    const kinds = trail.map((event) => event.kind).join('\n')
    assert.equal(run?.status, 'failed', kinds)
    assert.equal(run?.complete, true, kinds)
    // The status frame alone carries no result; the exact result's failure must reach the run.
    const finished = trail.filter((event) => event.kind === 'run.finished')
    assert.equal(finished.length, 1, kinds)
    // Braid persists typed diagnostics, never provider prose, so the result failure arrives as codes.
    assert.equal(run?.error, 'RUNTIME_FINAL_ERROR', kinds)
    assert.equal(run?.terminalReason, 'RUNTIME_FINAL_REASON', kinds)
    assert.equal(opened.app.state().lastError, run?.error)
  } finally {
    await opened.app.close()
    await rm(root, { recursive: true, force: true })
  }
})
