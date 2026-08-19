import assert from 'node:assert/strict'
import test from 'node:test'
import { type AgentExactRunControlRef, defineAgentProfile } from '@tangle-network/agent-interface'
import {
  createCliBridgeRetainedPlan,
  startCliBridgeRetainedRun,
} from '../src/adapters/runtime/cli-bridge-retained-run.js'
import { prepareCliBridgeConnection } from '../src/adapters/runtime/production-cli-bridge-backend.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import type { RunAdmissionReceipt } from '../src/domain/run-contracts.js'
import {
  DEFAULT_RUN_CAPABILITIES,
  type ExecuteTurnInput,
  type RetainedRunAdmissionRecord,
} from '../src/ports/execution.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const createdAt = '2026-08-15T00:00:00.000Z'

test('fresh CLI Bridge plans keep provider identity unknown until Runtime admission', async () => {
  const bridge = await startRuntimeBridgeServer()
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-cli-identity'),
    kind: 'cli-bridge',
    name: 'CLI Bridge identity test',
    endpoint: bridge.endpoint,
    providerOptions: { transport: 'local' },
    createdAt,
    updatedAt: createdAt,
    lastHealth: { status: 'unknown' },
  }
  const profile = defineAgentProfile({
    name: 'CLI Bridge identity test',
    harness: 'pi',
    model: { provider: 'openai', default: 'openai/gpt-5' },
  })
  const input: ExecuteTurnInput = {
    operationId: 'operation-cli-identity',
    runId: 'run-cli-identity',
    text: 'Retain this exact provider identity.',
    profile,
    connectionId: connection.id,
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
  }
  const options = {
    connections: new ConnectionRegistry([connection]),
    workspaceCwd: '/workspace',
    select: () => ({ connection: { connectionId: connection.id } }),
  }

  try {
    const prepared = await prepareCliBridgeConnection(
      options,
      input,
      { connection: { connectionId: connection.id } },
      connection.id,
      bridge.endpoint,
    )
    const fresh = await createCliBridgeRetainedPlan(prepared, input.runId)
    assert.equal(fresh.environmentId, undefined)
    assert.match(fresh.environmentIdempotencyKey, /^environment-braid-/u)
    assert.equal(fresh.materializationReceipt.environmentId, undefined)

    const exact: AgentExactRunControlRef = {
      runId: 'provider-run-cli-identity',
      provider: 'cli-bridge',
      environmentId: 'cb1.opaque-cli-identity',
      sessionId: 'session-cli-identity',
      executionId: 'execution-cli-identity',
      requestDigest: `sha256:${'d'.repeat(64)}`,
    }
    const recovered = await createCliBridgeRetainedPlan(prepared, input.runId, exact)
    assert.equal(recovered.environmentId, exact.environmentId)
    assert.equal(recovered.environmentIdempotencyKey, 'environment-braid-run-cli-identity')
    assert.notEqual(recovered.environmentId, recovered.environmentIdempotencyKey)
  } finally {
    await bridge.close()
  }
})

test('retained CLI Bridge replays a persisted intent through Runtime', async () => {
  const bridge = await startRuntimeBridgeServer({ responseText: 'CLI_BRIDGE_REPLAY_OK' })
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-cli-replay'),
    kind: 'cli-bridge',
    name: 'CLI Bridge replay test',
    endpoint: bridge.endpoint,
    providerOptions: { transport: 'local' },
    createdAt,
    updatedAt: createdAt,
    lastHealth: { status: 'unknown' },
  }
  const profile = defineAgentProfile({
    name: 'CLI Bridge replay test',
    harness: 'pi',
    model: { provider: 'openai', default: 'openai/gpt-5' },
  })
  const input: ExecuteTurnInput = {
    operationId: 'operation-cli-replay',
    runId: 'run-cli-replay',
    text: 'Replay this retained intent exactly.',
    profile,
    connectionId: connection.id,
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
    onRetainedAdmission: async () => {},
  }
  const options = {
    connections: new ConnectionRegistry([connection]),
    workspaceCwd: '/workspace',
    select: () => ({ connection: { connectionId: connection.id } }),
  }

  try {
    const prepared = await prepareCliBridgeConnection(
      options,
      input,
      { connection: { connectionId: connection.id } },
      connection.id,
      bridge.endpoint,
    )
    const plan = await createCliBridgeRetainedPlan(prepared, input.runId)
    const admissions: RetainedRunAdmissionRecord[] = []
    await assert.rejects(
      startCliBridgeRetainedRun(plan, {
        ...input,
        onRetainedAdmission: async (admission) => {
          admissions.push(structuredClone(admission))
          if (admission.phase === 'intent') throw new Error('simulated process death')
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message === 'simulated process death',
    )
    const intent = admissions[0]
    if (intent?.phase !== 'intent') throw new Error('the retained intent was not persisted')

    const receipt: RunAdmissionReceipt = {
      version: 1,
      runId: input.runId,
      turnId: input.operationId,
      operationId: input.operationId,
      conversationId: 'conversation-cli-replay',
      branchId: 'branch-cli-replay',
      admittedAt: createdAt,
      profileDigest: `sha256:${'a'.repeat(64)}`,
      requested: {
        text: input.text,
        profile,
        connectionId: connection.id,
        interactions: {},
      },
      capabilities: DEFAULT_RUN_CAPABILITIES,
      requestDigest: `sha256:${'b'.repeat(64)}`,
      capabilitiesDigest: `sha256:${'c'.repeat(64)}`,
      digest: `sha256:${'d'.repeat(64)}`,
    }
    const recoveredAdmissions: RetainedRunAdmissionRecord[] = []
    const recovered = await plan.recover?.({
      admission: intent,
      receipt,
      onRetainedAdmission: async (admission) => {
        recoveredAdmissions.push(structuredClone(admission))
      },
    })
    assert.ok(recovered)
    assert.deepEqual(
      recoveredAdmissions.map((admission) => admission.phase),
      ['environment', 'dispatched'],
    )
    assert.equal(bridge.requests.length, 1)
    assert.equal(recovered.controlRef.sessionId, prepared.providerSessionId)
  } finally {
    await bridge.close()
  }
})

test('retained CLI Bridge receives the exact admitted interaction map', async () => {
  const bridge = await startRuntimeBridgeServer({ responseText: 'CLI_BRIDGE_INTERACTION_OK' })
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-cli-interactions'),
    kind: 'cli-bridge',
    name: 'CLI Bridge interaction test',
    endpoint: bridge.endpoint,
    providerOptions: { transport: 'local' },
    createdAt,
    updatedAt: createdAt,
    lastHealth: { status: 'unknown' },
  }
  const profile = defineAgentProfile({
    name: 'CLI Bridge interaction test',
    harness: 'pi',
    model: { provider: 'openai', default: 'openai/gpt-5' },
  })
  const input: ExecuteTurnInput = {
    operationId: 'operation-cli-interactions',
    runId: 'run-cli-interactions',
    text: 'Continue with the approved interaction posture.',
    profile,
    connectionId: connection.id,
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
    interactions: Object.freeze({ permission: true, question: true, plan: true }),
    onRetainedAdmission: async (_admission: RetainedRunAdmissionRecord) => {},
  }
  const options = {
    connections: new ConnectionRegistry([connection]),
    workspaceCwd: '/workspace',
    select: () => ({ connection: { connectionId: connection.id } }),
  }

  try {
    const prepared = await prepareCliBridgeConnection(
      options,
      input,
      { connection: { connectionId: connection.id } },
      connection.id,
      bridge.endpoint,
    )
    const plan = await createCliBridgeRetainedPlan(prepared, input.runId)
    await startCliBridgeRetainedRun(plan, input)

    assert.equal(bridge.requests.length, 1)
    assert.deepEqual(bridge.requests[0]?.body.interactions, input.interactions)
  } finally {
    await bridge.close()
  }
})
