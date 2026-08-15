import assert from 'node:assert/strict'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import {
  createCliBridgeRetainedPlan,
  startCliBridgeRetainedRun,
} from '../src/adapters/runtime/cli-bridge-retained-run.js'
import { prepareCliBridgeConnection } from '../src/adapters/runtime/production-cli-bridge-backend.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import type { ExecuteTurnInput, RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const createdAt = '2026-08-15T00:00:00.000Z'

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
