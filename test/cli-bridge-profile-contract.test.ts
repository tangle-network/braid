import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { AgentRuntimeExecutionPort } from '../src/adapters/runtime/agent-runtime-execution.js'
import {
  createProductionBackendResolver,
  type ProductionBackendResolverOptions,
} from '../src/adapters/runtime/production-backend-resolver.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import type { ExecuteTurnInput } from '../src/ports/execution.js'
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
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the Runtime Bridge request')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

let contractConnection: ConnectionRecord

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
    const resolver = createProductionBackendResolver(options)
    const first = input('first contract turn', 'run-contract-1')
    const second = input('second contract turn', 'run-contract-2')
    const prepared = await resolver(first)
    assert.equal(prepared.kind, 'prepared-execution')
    assert.deepEqual(prepared.backend.profile, profile)
    assert.equal(prepared.materializationReceipt.runner, 'pi')
    assert.equal(prepared.materializationReceipt.workspace, workspaceCwd)

    const execution = new AgentRuntimeExecutionPort(resolver)
    const firstAdmission = await execution.admit(first)
    assert.equal(firstAdmission.providerSessionId, sessionId)
    assert.equal(firstAdmission.capabilities?.environment?.streaming.replay, true)
    assert.equal(firstAdmission.capabilities?.environment?.sessions.continue, true)
    assert.equal(firstAdmission.capabilities?.environment?.streaming.turnIdempotency, true)
    assert.equal(firstAdmission.capabilities?.streaming.replay, false)
    assert.equal(firstAdmission.capabilities?.sessions.continue, true)
    assert.equal(firstAdmission.capabilities?.controls.cancel, true)
    assert.equal(firstAdmission.capabilities?.controls.status, false)
    const firstEvents = []
    for await (const event of execution.streamTurn(first)) firstEvents.push(event)
    const secondAdmission = await execution.admit(second)
    assert.equal(secondAdmission.providerSessionId, sessionId)
    const secondEvents = []
    for await (const event of execution.streamTurn(second)) secondEvents.push(event)
    assert.equal(firstEvents.at(-1)?.type, 'final')
    assert.equal(secondEvents.at(-1)?.type, 'final')
    assert.equal(bridge.requests.length, 2, JSON.stringify({ firstEvents, secondEvents }, null, 2))

    for (const [request, turn] of bridge.requests.map(
      (request, index) => [request, index === 0 ? first : second] as const,
    )) {
      const body = request.body
      assert.deepEqual(body.agent_profile, profile)
      assert.equal(
        body.agent_profile &&
          typeof body.agent_profile === 'object' &&
          'harness' in body.agent_profile
          ? body.agent_profile.harness
          : undefined,
        'pi',
      )
      assert.equal(body.model, 'pi/openai-codex/gpt-5.6-luna')
      assert.equal(body.run_id, request.runId)
      assert.match(String(body.run_id), /^bridge-run-/u)
      assert.notEqual(body.run_id, turn.runId)
      assert.equal(body.session_id, sessionId)
      assert.equal(request.sessionId, sessionId)
      assert.equal(body.cwd, workspaceCwd)
      assert.equal(
        body.messages && Array.isArray(body.messages) ? body.messages.at(-1)?.content : undefined,
        turn.text,
      )
      assert.equal(JSON.stringify(body).includes('inline-'), false)
    }
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
    const resolver = createProductionBackendResolver(options)
    const execution = new AgentRuntimeExecutionPort(resolver)
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
      detail: 'Provider cancellation acknowledged',
    })
    assert.equal(bridge.cancellations.length, 1)
    assert.equal(bridge.cancellations[0]?.runId.startsWith('bridge-run-'), true)

    await pendingEvent
    for await (const _event of stream) {
      // Drain the Runtime terminal path after provider acknowledgement.
    }
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
    const resolver = createProductionBackendResolver(options)
    const execution = new AgentRuntimeExecutionPort(resolver)
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
      detail: 'Provider cancellation failed before acknowledgement',
    })
    await pendingEvent
    for await (const _event of stream) {
      // Drain the Runtime terminal path after the provider error.
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
