import assert from 'node:assert/strict'
import test from 'node:test'
import {
  type ContextTransferRequest,
  type ContextTransferResult,
  type AgentEnvironmentProvider,
  canonicalAgentProfileDigest,
  contextTransferRequestDigest,
  defineAgentProfile,
  type PortableConversationContext,
  portableContextPlanDigest,
  portableConversationContextDigest,
} from '@tangle-network/agent-interface'
import { execOnlyEnvironmentCapabilities } from '@tangle-network/agent-interface/environment-provider'
import { createProviderContextTransferPort } from '../src/adapters/runtime/provider-context-transfer.js'
import { createProductionComposition } from '../src/app/production-composition.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId } from '../src/domain/ids.js'
import type { ExecuteTurnInput, RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const at = '2026-08-20T12:00:00.000Z'

test('production CLI Bridge transfers context into one exact fresh retained session', async () => {
  const bridge = await startRuntimeBridgeServer({ responseText: 'CONTEXT_TRANSFER_OK' })
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-cli-context'),
    kind: 'cli-bridge',
    name: 'CLI Bridge context test',
    endpoint: bridge.endpoint,
    providerOptions: { transport: 'local' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
  const profile = defineAgentProfile({
    name: 'CLI Bridge context destination',
    harness: 'pi',
    model: { provider: 'openai', default: 'openai/gpt-5' },
  })
  const transfer = contextTransfer(profile)
  const production = createProductionComposition({
    profile,
    connections: [connection],
    connectionId: connection.id,
    workspaceRoot: '/workspace',
  })

  try {
    assert.ok(production.execution.context?.transfer)
    const receipt = await production.execution.context.transfer(transfer)
    assert.equal(receipt.status, 'accepted')
    if (receipt.status !== 'accepted') throw new Error('context transfer was not accepted')

    const admissions: RetainedRunAdmissionRecord[] = []
    const input: ExecuteTurnInput = {
      operationId: 'operation-context-destination',
      runId: 'run-braid-context-destination',
      turnId: 'turn-context-destination',
      text: 'Continue with the transferred marker.',
      profile,
      connectionId: connection.id,
      workspaceRoot: '/workspace',
      sessionId: receipt.sessionId,
      signal: new AbortController().signal,
      contextTransfer: transfer,
      onRetainedAdmission: async (admission) => {
        admissions.push(structuredClone(admission))
      },
    }
    const admission = await production.execution.admit?.(input)
    assert.equal(admission?.environmentId, transfer.plan.destination.environmentId)
    assert.equal(admission?.providerSessionId, transfer.plan.destination.sessionId)

    const events = []
    for await (const event of production.execution.streamTurn(input)) events.push(event)

    assert.ok(
      events.some((candidate) => {
        const event = 'event' in candidate ? candidate.event : undefined
        return (
          typeof event === 'object' && event !== null && 'type' in event && event.type === 'final'
        )
      }),
    )
    assert.deepEqual(
      admissions.map((candidate) => candidate.phase),
      ['intent', 'environment', 'dispatched'],
    )
    assert.equal(bridge.sessions[0]?.id, transfer.plan.destination.sessionId)
    assert.notEqual(input.runId, transfer.plan.destination.runId)
    assert.equal(bridge.requests[0]?.runId, transfer.plan.destination.runId)
    assert.deepEqual(bridge.requests[0]?.body.context_transfer, transfer)
    assert.equal(bridge.requests[0]?.body.environment_id, transfer.plan.destination.environmentId)
    assert.equal(bridge.requests[0]?.body.execution_id, transfer.plan.destination.executionId)
  } finally {
    await bridge.close()
  }
})

test('portable context routes any capable provider by exact destination connection', async () => {
  const profile = defineAgentProfile({ name: 'portable destination' })
  const request = contextTransfer(profile, 'daytona')
  const capability = {
    ...execOnlyEnvironmentCapabilities({
      read: false,
      write: false,
      exec: false,
      git: false,
      upload: false,
      download: false,
    }),
    contextTransfer: {
      freshSession: true as const,
      requestIdempotency: true as const,
      lookup: true as const,
    },
  }
  let target: string | undefined
  let calls = 0
  const result: ContextTransferResult = {
    status: 'unknown',
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    message: 'No prior admission',
    retryable: true,
  }
  const provider: AgentEnvironmentProvider = {
    name: 'daytona',
    capabilities: () => capability,
    async create() {
      throw new Error('Transfer routing must not create an environment')
    },
    contextTransfer: {
      async lookup() {
        return undefined
      },
      async transfer(input) {
        calls += 1
        assert.deepEqual(input, request)
        return result
      },
    },
  }
  const port = createProviderContextTransferPort({
    async resolve(_request, selected) {
      target = selected?.connectionId
      return { provider, capabilities: capability }
    },
  })
  assert.equal(await port.supports?.(request.plan.destination, { connectionId: 'connection-daytona' }), true)
  assert.equal(await port.lookup?.(request, { connectionId: 'connection-daytona' }), undefined)
  assert.deepEqual(await port.transfer?.(request, { connectionId: 'connection-daytona' }), result)
  assert.equal(target, 'connection-daytona')
  assert.equal(calls, 1)
  const wrongProvider = createProviderContextTransferPort({
    async resolve() {
      return { provider: { ...provider, name: 'another-provider' }, capabilities: capability }
    },
  })
  assert.equal(await wrongProvider.supports?.(request.plan.destination), false)
  assert.equal((await wrongProvider.transfer?.(request))?.status, 'unknown')
  assert.equal(calls, 1)
  const wrongReceipt = createProviderContextTransferPort({
    async resolve() {
      return {
        provider: {
          ...provider,
          contextTransfer: {
            async lookup() {
              return { ...result, operationId: 'another-operation' }
            },
            async transfer() {
              return { ...result, requestDigest: `sha256:${'f'.repeat(64)}` }
            },
          },
        },
        capabilities: capability,
      }
    },
  })
  await assert.rejects(() => wrongReceipt.lookup!(request), /does not match the exact request/)
  await assert.rejects(() => wrongReceipt.transfer!(request), /does not match the exact request/)
})

test('portable context validates the request before selecting a credential route', async () => {
  let resolutions = 0
  const port = createProviderContextTransferPort({
    async resolve() {
      resolutions += 1
      return undefined
    },
  })
  const request = contextTransfer(defineAgentProfile({ name: 'invalid destination' }))
  await assert.rejects(() =>
    port.transfer!({ ...request, requestDigest: `sha256:${'f'.repeat(64)}` }),
  )
  assert.equal(resolutions, 0)
})

function contextTransfer(
  profile: ReturnType<typeof defineAgentProfile>,
  provider = 'cli-bridge',
): ContextTransferRequest {
  const sourceMaterial = {
    source: {
      runId: 'run-context-source',
      messageId: 'message-context-source',
      provider: 'cli-bridge',
      environmentId: 'environment-context-source',
      sessionId: 'session-context-source',
      executionId: 'execution-context-source',
      requestDigest: `sha256:${'a'.repeat(64)}` as const,
    },
    completeness: 'complete' as const,
    messages: [
      {
        id: 'message-context-source',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'portable context marker 96e1' }],
        timestamp: '2026-08-20T11:59:58.000Z',
      },
    ],
    attachments: [],
  }
  const context: PortableConversationContext = {
    ...sourceMaterial,
    digest: portableConversationContextDigest(sourceMaterial),
  }
  const destination = {
    runner: 'pi',
    provider,
    environmentId: 'environment-context-destination',
    sessionId: 'session-context-destination',
    runId: 'run-context-destination',
    executionId: 'execution-context-destination',
    model: 'openai/gpt-5',
    profileDigest: canonicalAgentProfileDigest(profile),
  }
  const planMaterial = {
    planId: 'plan-context-destination',
    source: context,
    destination,
    messages: [
      {
        messageId: 'message-context-source',
        action: 'include' as const,
        parts: [{ partIndex: 0, action: 'include' as const }],
      },
    ],
    context,
    requiresAcceptance: false,
  }
  const plan = { ...planMaterial, digest: portableContextPlanDigest(planMaterial) }
  const requestMaterial = {
    operationId: 'transfer-context-destination',
    plan,
    acceptance: {
      planDigest: plan.digest,
      acceptedAt: at,
      acceptedBy: 'policy' as const,
    },
  }
  return {
    ...requestMaterial,
    requestDigest: contextTransferRequestDigest(requestMaterial),
  }
}
