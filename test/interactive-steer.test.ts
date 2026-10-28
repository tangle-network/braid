import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type AgentProfile, defineAgentProfile } from '@tangle-network/agent-interface'
import { FileObserverJournal } from '@tangle-network/agent-runtime/durable'
import {
  type RetainedInteractiveAdmission,
  startRetainedInteractiveRun,
} from '@tangle-network/agent-runtime/kernel'
import type { PreparedTangleRetainedConnection } from '../src/adapters/runtime/production-tangle-sandbox-backend.js'
import {
  interactiveEnvironment,
  interactiveIdempotencyKey,
  interactiveRunCapabilities,
} from '../src/adapters/runtime/tangle-retained-interactive-contract.js'
import { TangleRetainedInteractiveExecutionPort } from '../src/adapters/runtime/tangle-retained-interactive-execution.js'
import type { RunAdmissionReceipt } from '../src/domain/run-contracts.js'
import { InteractiveEnvironmentFixture } from './support/interactive-environment-provider.js'

const runId = 'run-interactive-steer'
const profile: Readonly<AgentProfile> = defineAgentProfile({
  name: 'interactive steer profile',
  harness: 'claude-code',
  model: { default: 'anthropic/claude-sonnet-4-5', provider: 'anthropic' },
})

async function prepared(
  fixture: InteractiveEnvironmentFixture,
): Promise<PreparedTangleRetainedConnection> {
  const provider = fixture.provider()
  // The port reads only the provider, its capabilities and the run identity material.
  return {
    profile,
    model: 'anthropic/claude-sonnet-4-5',
    runner: 'claude-code',
    provider,
    capabilities: await provider.capabilities(),
    idleTtlSeconds: 1_800,
  } as unknown as PreparedTangleRetainedConnection
}

/** One `braid rpc` process: a fresh port with no handle, reaching the same provider process. */
function braidProcess(fixture: InteractiveEnvironmentFixture, journalRoot: string) {
  return new TangleRetainedInteractiveExecutionPort({
    resolve: () => prepared(fixture),
    broker: {
      open: () => {
        throw new Error('a steering process opens no terminal')
      },
      settle: () => 'absent',
    },
    journalRoot,
  })
}

/** The first process starts the run exactly as the interactive port does and exits. */
async function startedRun(fixture: InteractiveEnvironmentFixture, journalRoot: string) {
  const connection = await prepared(fixture)
  let started: RetainedInteractiveAdmission | undefined
  const handle = await startRetainedInteractiveRun({
    provider: connection.provider,
    environment: interactiveEnvironment(connection, runId),
    interactiveIdempotencyKey: interactiveIdempotencyKey(runId),
    initialPrompt: 'Inspect the workspace.',
    journalRoot,
    onAdmission: async (admission) => {
      started = admission
    },
  })
  assert.equal(started?.phase, 'interactive_started')
  const receipt = {
    version: 1,
    runId,
    turnId: 'turn-interactive-steer',
    operationId: 'operation-interactive-steer',
    conversationId: 'conversation-interactive-steer',
    branchId: 'branch-interactive-steer',
    admittedAt: '2026-10-28T00:00:00.000Z',
    profileDigest: 'sha256:profile',
    requested: { text: 'Inspect the workspace.', profile, mode: 'interactive' },
    capabilities: interactiveRunCapabilities(connection),
  } as RunAdmissionReceipt
  return { sessionId: handle.ref.run.sessionId, recovery: { retainedAdmission: started, receipt } }
}

async function turnOperations(journalRoot: string, sessionId: string): Promise<string[]> {
  const records = await new FileObserverJournal(
    join(journalRoot, sessionId, 'observer.jsonl'),
    sessionId,
  ).read()
  return records.flatMap((record) =>
    record.event?.target === 'agent.turn' ? [String(record.event.payload?.operationId)] : [],
  )
}

test('retained interactive runs advertise steering from the provider prompt contract', async () => {
  const fixture = new InteractiveEnvironmentFixture()
  assert.equal(interactiveRunCapabilities(await prepared(fixture)).controls.steer, true)
})

test('fresh processes steer one started run once per operation id and journal one turn each', async () => {
  const fixture = new InteractiveEnvironmentFixture()
  const journalRoot = await mkdtemp(join(tmpdir(), 'braid-interactive-steer-'))
  const { sessionId, recovery } = await startedRun(fixture, journalRoot)
  const steer = (operationId: string, text: string) =>
    braidProcess(fixture, journalRoot).steerRun({ runId, operationId, text, ...recovery })

  // Disconnect: the starting process is gone; each steer reconnects from the durable admission.
  assert.deepEqual(await steer('steer-1', 'Run the tests.'), {
    operationId: 'steer-1',
    outcome: 'accepted',
    detail: 'steered',
  })
  // Replay: the same operation from another process is the provider's held result.
  assert.equal((await steer('steer-1', 'Run the tests.')).outcome, 'already-applied')
  // The same operation id with different text never reaches the agent.
  assert.deepEqual(await steer('steer-1', 'Delete the tests.'), {
    operationId: 'steer-1',
    outcome: 'rejected',
    detail: 'operation-conflict',
  })
  // Duplicate events: two processes race one new operation. The provider delivers it once; the
  // loser either reads the held result or loses its control generation, which Braid records as
  // unknown and reconciles with the same operation id.
  const raced = await Promise.all(
    [0, 1].map(() =>
      steer('steer-2', 'Summarize.').then(
        (receipt) => receipt.outcome,
        () => 'stale-claim',
      ),
    ),
  )
  assert.equal(raced.filter((outcome) => outcome === 'accepted').length, 1)
  assert.equal((await steer('steer-2', 'Summarize.')).outcome, 'already-applied')

  assert.deepEqual(fixture.prompts, ['Run the tests.', 'Summarize.'])
  assert.deepEqual(await turnOperations(journalRoot, sessionId), ['steer-1', 'steer-2'])
})

test('a cancelled steer delivers nothing and the same operation applies once on retry', async () => {
  const fixture = new InteractiveEnvironmentFixture()
  const journalRoot = await mkdtemp(join(tmpdir(), 'braid-interactive-steer-cancel-'))
  const { sessionId, recovery } = await startedRun(fixture, journalRoot)
  const controller = new AbortController()
  controller.abort(new Error('operator cancelled the steer'))
  await assert.rejects(
    braidProcess(fixture, journalRoot).steerRun({
      runId,
      operationId: 'steer-cancelled',
      text: 'Run the tests.',
      signal: controller.signal,
      ...recovery,
    }),
  )
  assert.deepEqual(fixture.prompts, [])

  const retried = await braidProcess(fixture, journalRoot).steerRun({
    runId,
    operationId: 'steer-cancelled',
    text: 'Run the tests.',
    ...recovery,
  })
  assert.equal(retried.outcome, 'accepted')
  assert.deepEqual(fixture.prompts, ['Run the tests.'])
  assert.deepEqual(await turnOperations(journalRoot, sessionId), ['steer-cancelled'])
})

test('a run that never started refuses a steer without creating an environment', async () => {
  const fixture = new InteractiveEnvironmentFixture()
  const journalRoot = await mkdtemp(join(tmpdir(), 'braid-interactive-steer-intent-'))
  const receipt = await braidProcess(fixture, journalRoot).steerRun({
    runId,
    operationId: 'steer-early',
    text: 'Run the tests.',
  })
  assert.deepEqual(receipt, {
    operationId: 'steer-early',
    outcome: 'rejected',
    detail: 'interactive-run-not-started',
  })
  assert.equal(fixture.creates, 0)
})
