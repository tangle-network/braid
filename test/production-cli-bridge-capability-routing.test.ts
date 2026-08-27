import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type AgentEnvironmentCapabilities,
  AgentEnvironmentCapabilitiesSchema,
  defineAgentProfile,
} from '@tangle-network/agent-interface'
import { defaultCliBridgeCapabilities } from '@tangle-network/agent-provider-cli-bridge'
import { createCliBridgeRetainedPlan } from '../src/adapters/runtime/cli-bridge-retained-run.js'
import { prepareCliBridgeConnection } from '../src/adapters/runtime/production-cli-bridge-backend.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import { createProductionComposition } from '../src/app/production-composition.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import { type ExecuteTurnInput, supportsNativeContinuation } from '../src/ports/execution.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const createdAt = '2026-08-19T00:00:00.000Z'

const profile = defineAgentProfile({
  name: 'CLI Bridge capability routing test',
  harness: 'pi',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})

function connection(endpoint: string, suffix: string): ConnectionRecord {
  return {
    id: createConnectionId(`connection-cli-capability-${suffix}`),
    kind: 'cli-bridge',
    name: `CLI Bridge capability ${suffix}`,
    endpoint,
    providerOptions: { transport: 'local' },
    createdAt,
    updatedAt: createdAt,
    lastHealth: { status: 'unknown' },
  }
}

function input(connectionId: string, suffix: string): ExecuteTurnInput {
  return {
    operationId: `operation-cli-capability-${suffix}`,
    runId: `run-cli-capability-${suffix}`,
    text: 'Prove the capability route.',
    profile,
    connectionId,
    workspaceRoot: '/workspace',
    signal: new AbortController().signal,
  }
}

function genericCapabilities(): AgentEnvironmentCapabilities {
  const advertised = defaultCliBridgeCapabilities('pi')
  const {
    interactions: _interactions,
    nativeContinuation: _nativeContinuation,
    retainedControl: _retainedControl,
    ...withoutNativeControl
  } = advertised
  return AgentEnvironmentCapabilitiesSchema.parse({
    ...withoutNativeControl,
    sessions: { ...withoutNativeControl.sessions, continue: false },
  }) as AgentEnvironmentCapabilities
}

async function productionAdmission(
  advertisedCapabilities: AgentEnvironmentCapabilities | null,
  suffix: string,
) {
  const bridge = await startRuntimeBridgeServer({ advertisedCapabilities })
  const selected = connection(bridge.endpoint, suffix)
  const composition = createProductionComposition({
    profile,
    connections: [selected],
    connectionId: selected.id,
    workspaceRoot: '/workspace',
  })
  try {
    assert.ok(composition.execution.admit)
    return {
      bridge,
      selected,
      admission: await composition.execution.admit(input(selected.id, suffix)),
    }
  } catch (error) {
    await bridge.close()
    throw error
  }
}

test('advertised native capability selects exact continuation in production composition', async () => {
  const result = await productionAdmission(defaultCliBridgeCapabilities('pi'), 'native')
  try {
    assert.equal(result.admission.capabilities?.sessions.continue, true)
    assert.ok(result.admission.capabilities?.environment)
    assert.equal(supportsNativeContinuation(result.admission.capabilities.environment), true)
    assert.deepEqual(result.admission.capabilities?.environment?.nativeContinuation, {
      atomicBoundary: true,
      requestIdempotency: true,
    })
    assert.deepEqual(
      result.admission.capabilities,
      await (async () => {
        const prepared = await prepareCliBridgeConnection(
          {
            connections: new ConnectionRegistry([result.selected]),
            workspaceCwd: '/workspace',
            select: () => ({ connection: { connectionId: result.selected.id } }),
          },
          input(result.selected.id, 'native-check'),
          { connection: { connectionId: result.selected.id } },
          result.selected.id,
          result.bridge.endpoint,
        )
        const plan = await createCliBridgeRetainedPlan(prepared, 'run-native-check')
        return plan.capabilities
      })(),
    )
  } finally {
    await result.bridge.close()
  }
})

test('absent native capability selects generic continuation in production composition', async () => {
  const result = await productionAdmission(genericCapabilities(), 'generic')
  try {
    assert.equal(result.admission.capabilities?.sessions.continue, false)
    assert.ok(result.admission.capabilities?.environment)
    assert.equal(supportsNativeContinuation(result.admission.capabilities.environment), false)
    assert.equal(result.admission.capabilities?.environment?.nativeContinuation, undefined)
    assert.equal(result.admission.capabilities?.environment?.retainedControl, undefined)
  } finally {
    await result.bridge.close()
  }
})

test('missing capability discovery fails production composition', async () => {
  await assert.rejects(
    productionAdmission(null, 'missing'),
    /capability discovery returned HTTP 404/u,
  )
})
