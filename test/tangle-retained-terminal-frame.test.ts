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
  name: 'Retained terminal frame',
  harness: 'opencode',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})

test('a retained headless run completes when the replay stream ends with an id-less stream.terminal frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-tangle-terminal-'))
  const sandbox = new FakeTangleRetainedSandbox()
  sandbox.replayTerminalFrames = true
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
    const turn = opened.app.send({ operationId: 'operation-terminal-frame', text: 'Reply DONE.' })
    await turn.admissionReady
    const deadline = Date.now() + 5_000
    while (sandbox.dispatches.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 2))
    sandbox.complete(sandbox.dispatches[0]?.executionId ?? '', 'DONE')
    await turn.completion
    const run = opened.app.state().runs.find((candidate) => candidate.id === turn.runId)
    const trail = opened.app
      .events()
      .filter((entry) => 'runId' in entry.event && entry.event.runId === turn.runId)
      .map(
        (entry) =>
          entry.event.kind + ('detail' in entry.event ? `: ${String(entry.event.detail)}` : ''),
      )
    assert.equal(run?.status, 'completed', trail.join('\n'))
    assert.equal(opened.app.state().messages.at(-1)?.text, 'DONE')
  } finally {
    await opened.app.close()
    await rm(root, { recursive: true, force: true })
  }
})
