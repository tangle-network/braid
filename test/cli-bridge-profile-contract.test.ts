import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { AgentRuntimeExecutionPort } from '../src/adapters/runtime/agent-runtime-execution.js'
import { CliBridgeRetainedExecutionPort } from '../src/adapters/runtime/cli-bridge-retained-execution.js'
import {
  type ProductionBackendResolverOptions,
  resolveProductionCliBridgeConnection,
} from '../src/adapters/runtime/production-backend-resolver.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import type {
  ExecuteTurnInput,
  RetainedRunAdmissionRecord,
} from '../src/ports/execution.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const at = '2026-08-03T12:00:00.000Z'
const sessionId = 'bridge-session-contract'
const workspaceCwd = '/tmp/braid-contract-workspace'

const profile: AgentProfile = {
  name: 'braid-profile-contract',
  description: 'Profile contract fixture',
  version: '1.0.0',
  tags: ['contract', 'profile'],
  prompt: {
    systemPrompt: 'Use the selected profile exactly.',
    instructions: ['Keep answers concise.'],
  },
  model: {
    default: 'gpt-5.6-luna',
    small: 'gpt-5.5',
    provider: 'openai-codex',
    reasoningEffort: 'high',
    metadata: { maxTurns: 1 },
  },
  harness: 'pi',
  permissions: { read: 'allow', write: 'ask' },
  tools: { read: true, write: false },
  mcp: {
    disabled: { enabled: false },
    remote: { transport: 'http', url: 'https://example.com/mcp', metadata: { scope: 'contract' } },
  },
  connections: [{ connectionId: 'hub-demo', capabilities: ['tickets.read'], alias: 'tickets' }],
  subagents: {
    reviewer: {
      description: 'Reviews the response',
      prompt: 'Review only.',
      model: 'openai-codex/gpt-5.5',
      tools: { read: true },
      permissions: { read: 'allow' },
      maxSteps: 2,
      metadata: { role: 'reviewer' },
    },
  },
  resources: {
    files: [
      {
        path: 'AGENTS.md',
        resource: { kind: 'inline', name: 'contract', content: 'Contract instructions.' },
      },
    ],
    tools: [{ kind: 'inline', name: 'tool', content: 'Tool description.' }],
    skills: [{ kind: 'inline', name: 'skill', content: 'Skill description.' }],
    agents: [{ kind: 'inline', name: 'agent', content: 'Agent description.' }],
    commands: [{ kind: 'inline', name: 'command', content: 'Command description.' }],
    instructions: { kind: 'inline', name: 'instructions', content: 'Resource instructions.' },
    failOnError: true,
  },
  hooks: {
    before: [{ command: 'echo contract-hook', timeoutMs: 1000, blocking: true, matcher: '.*' }],
  },
  modes: {
    review: {
      description: 'Review mode',
      model: 'openai-codex/gpt-5.5',
      prompt: 'Review.',
      tools: { read: true },
      permissions: { read: 'allow' },
      metadata: { mode: true },
    },
  },
  confidential: { tee: 'any', sealed: false },
  metadata: { contract: 'all-profile-dimensions' },
  extensions: { 'provider.test': { enabled: true, version: 1 } },
}

function connection(endpoint: string): ConnectionRecord {
  return {
    id: createConnectionId('connection-cli-contract'),
    kind: 'cli-bridge',
    name: 'Contract CLI Bridge',
    endpoint,
    providerOptions: { transport: 'local' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

function input(value: string, runId: string): ExecuteTurnInput {
  return {
    operationId: `operation-${runId}`,
    runId,
    text: value,
    profile,
    connectionId: contractConnection.id,
    sessionId,
    signal: new AbortController().signal,
    onRetainedAdmission: async (admission: RetainedRunAdmissionRecord) => {
      admissions.push(admission)
    },
  }
}

/** Braid drives CLI Bridge through the retained port; the ephemeral resolver refuses it. */
function retainedExecution(options: ProductionBackendResolverOptions) {
  return new CliBridgeRetainedExecutionPort({
    resolve: (turn) => resolveProductionCliBridgeConnection(options, turn),
    recover: () => {
      throw new Error('This contract test never recovers a persisted run')
    },
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the Runtime Bridge request')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

let contractConnection: ConnectionRecord
let admissions: RetainedRunAdmissionRecord[] = []

test('production CLI Bridge sends the frozen profile and complete turn identity', async () => {
  const bridge = await startRuntimeBridgeServer({ responseText: 'CONTRACT_OK' })
  try {
    contractConnection = connection(bridge.endpoint)
    const registry = new ConnectionRegistry([contractConnection])
    const options: ProductionBackendResolverOptions = {
      connections: registry,
      workspaceCwd,
      select: () => ({
        connection: { connectionId: contractConnection.id },
        runner: 'pi',
        ...(profile.model?.default === undefined ? {} : { model: profile.model.default }),
      }),
    }
    admissions = []
    const first = input('first contract turn', 'run-contract-1')
    const second = input('second contract turn', 'run-contract-2')
    const prepared = await resolveProductionCliBridgeConnection(options, first)
    assert.deepEqual(prepared.profile, profile)
    assert.equal(prepared.materializationReceipt.runner, 'pi')
    assert.equal(prepared.materializationReceipt.workspace, workspaceCwd)

    const execution = retainedExecution(options)
    const firstAdmission = await execution.admit(first)
    assert.equal(firstAdmission.providerSessionId, sessionId)
    assert.equal(firstAdmission.capabilities?.environment?.streaming.replay, true)
    assert.equal(firstAdmission.capabilities?.environment?.sessions.continue, true)
    assert.equal(firstAdmission.capabilities?.environment?.streaming.turnIdempotency, true)
    // The retained port replays and reads exact status from the durable run.
    assert.equal(firstAdmission.capabilities?.streaming.replay, true)
    assert.equal(firstAdmission.capabilities?.sessions.continue, true)
    assert.equal(firstAdmission.capabilities?.controls.cancel, true)
    assert.equal(firstAdmission.capabilities?.controls.status, true)
    const firstEvents = []
    for await (const event of execution.streamTurn(first)) firstEvents.push(event)
    const secondAdmission = await execution.admit(second)
    assert.equal(secondAdmission.providerSessionId, sessionId)
    const secondEvents = []
    for await (const event of execution.streamTurn(second)) secondEvents.push(event)
    assert.equal(firstEvents.at(-1)?.event.type, 'final')
    assert.equal(secondEvents.at(-1)?.event.type, 'final')
    assert.equal(bridge.requests.length, 2, JSON.stringify({ firstEvents, secondEvents }, null, 2))

    // One native session carries the frozen profile; every turn binds to its exact run.
    assert.equal(bridge.sessions.length, 1)
    const session = bridge.sessions[0]
    assert.deepEqual(session?.body.agent_profile, profile)
    assert.equal(
      session?.body.agent_profile &&
        typeof session.body.agent_profile === 'object' &&
        'harness' in session.body.agent_profile
        ? session.body.agent_profile.harness
        : undefined,
      'pi',
    )
    assert.equal(session?.model, 'pi/openai-codex/gpt-5.6-luna')
    assert.equal(session?.id, sessionId)
    assert.equal(session?.body.cwd, workspaceCwd)
    assert.equal(JSON.stringify(session?.body).includes('inline-'), false)

    for (const [request, turn] of bridge.requests.map(
      (request, index) => [request, index === 0 ? first : second] as const,
    )) {
      const body = request.body
      assert.equal(body.run_id, request.runId)
      assert.equal(body.run_id, turn.runId)
      assert.equal(body.execution_id, turn.runId)
      assert.equal(body.provider, 'cli-bridge')
      assert.equal(request.session?.id, sessionId)
      assert.equal(request.sessionId, sessionId)
      assert.equal(body.message, turn.text)
      assert.equal(JSON.stringify(body).includes('inline-'), false)
    }
    assert.deepEqual(
      admissions.map((admission) => admission.phase),
      ['intent', 'environment', 'dispatched', 'intent', 'environment', 'dispatched'],
    )
  } finally {
    await bridge.close()
  }
})

test('production CLI Bridge cancellation uses Runtime provider acknowledgement', async () => {
  const bridge = await startRuntimeBridgeServer({ holdStreams: true })
  try {
    contractConnection = connection(bridge.endpoint)
    const registry = new ConnectionRegistry([contractConnection])
    const options: ProductionBackendResolverOptions = {
      connections: registry,
      workspaceCwd,
      select: () => ({
        connection: { connectionId: contractConnection.id },
        runner: 'pi',
        ...(profile.model?.default === undefined ? {} : { model: profile.model.default }),
      }),
    }
    admissions = []
    const execution = retainedExecution(options)
    const turn = input('cancel this provider turn', 'run-contract-provider-cancel')

    const admission = await execution.admit(turn)
    assert.equal(admission.capabilities?.controls.cancel, true)
    const stream = execution.streamTurn(turn)
    await stream.next()
    const pendingEvent = stream.next()
    await waitFor(() => bridge.requests.length === 1)

    const acknowledgement = await execution.cancelRun({
      runId: turn.runId,
      operationId: 'operation-provider-cancel',
      reason: 'operator requested cancellation',
    })
    assert.deepEqual(acknowledgement, {
      operationId: 'operation-provider-cancel',
      outcome: 'accepted',
      detail: 'cancelled',
    })
    assert.equal(bridge.cancellations.length, 1)
    assert.equal(bridge.cancellations[0]?.runId, turn.runId)

    // The retained reader stops at the cancellation; Braid keeps no second terminal path.
    await assert.rejects(async () => {
      await pendingEvent
      for await (const _event of stream) {
        // The cancelled reader emits nothing more.
      }
    }, /Retained run cancelled/u)
  } finally {
    await bridge.close()
  }
})

test('production CLI Bridge cancellation keeps a Runtime provider error unknown', async () => {
  const bridge = await startRuntimeBridgeServer({
    holdStreams: true,
    cancellation: { mode: 'rejected' },
  })
  try {
    contractConnection = connection(bridge.endpoint)
    const registry = new ConnectionRegistry([contractConnection])
    const options: ProductionBackendResolverOptions = {
      connections: registry,
      workspaceCwd,
      select: () => ({
        connection: { connectionId: contractConnection.id },
        runner: 'pi',
        ...(profile.model?.default === undefined ? {} : { model: profile.model.default }),
      }),
    }
    admissions = []
    const execution = retainedExecution(options)
    const turn = input('reject this provider turn', 'run-contract-provider-reject')

    const admission = await execution.admit(turn)
    assert.equal(admission.capabilities?.controls.cancel, true)
    const stream = execution.streamTurn(turn)
    await stream.next()
    const pendingEvent = stream.next()
    await waitFor(() => bridge.requests.length === 1)

    const acknowledgement = await execution.cancelRun({
      runId: turn.runId,
      operationId: 'operation-provider-reject',
    })
    assert.deepEqual(acknowledgement, {
      operationId: 'operation-provider-reject',
      outcome: 'unknown',
      detail: 'unknown',
    })
    // A refused cancellation leaves the provider run live, so the reader stays open.
    bridge.complete(turn.runId)
    await pendingEvent
    for await (const _event of stream) {
      // Drain the retained reader after the provider refused the cancellation.
    }
  } finally {
    await bridge.close()
  }
})

test('a turn cancelled before iteration never resolves or materializes execution', async () => {
  let resolverCalls = 0
  const execution = new AgentRuntimeExecutionPort(async () => {
    resolverCalls += 1
    throw new Error('resolver must not run after cancellation')
  })
  const abort = new AbortController()
  abort.abort(new Error('cancelled before start'))
  const cancelled = {
    ...input('cancelled contract turn', 'run-contract-cancelled'),
    signal: abort.signal,
  }

  await assert.rejects(async () => {
    for await (const _event of execution.streamTurn(cancelled)) {
      // A pre-cancelled turn cannot emit runtime work.
    }
  }, /cancelled before start/u)
  assert.equal(resolverCalls, 0)
})
