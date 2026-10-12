import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalAgentProfileDigest,
  createContextTransferRequest,
  defineAgentProfile,
  portableContextPlanDigest,
  portableConversationContextDigest,
  type ContextTransferRequest,
} from '@tangle-network/agent-interface'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import { createAgentEnvironmentProviderRegistry } from '@tangle-network/agent-runtime/kernel'
import { bindCredentialToOrigin } from '../src/adapters/connections/production-connection-credentials.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createProductionComposition } from '../src/app/production-composition.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import { credentialRef } from '../src/ports/credentials.js'
import type { ExecuteTurnInput, RetainedRunAdmissionRecord } from '../src/ports/execution.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const at = '2026-10-11T12:00:00.000Z'
const profile = defineAgentProfile({
  name: 'Exact portable profile',
  harness: 'pi',
  model: { provider: 'openai', default: 'openai/gpt-5' },
})
function transferRequest(): ContextTransferRequest {
  const source = {
    source: {
      runId: 'run-source',
      messageId: 'message-source',
      provider: 'local',
      environmentId: 'environment-source',
      sessionId: 'session-source',
      executionId: 'execution-source',
      requestDigest: `sha256:${'a'.repeat(64)}` as const,
    },
    completeness: 'complete' as const,
    messages: [
      {
        id: 'message-source',
        role: 'user' as const,
        parts: [{ type: 'text' as const, text: 'Continue the selected work' }],
        timestamp: at,
      },
    ],
    attachments: [],
  }
  const context = { ...source, digest: portableConversationContextDigest(source) }
  const material = {
    planId: 'plan-registered-destination',
    source: context,
    context,
    destination: {
      provider: 'same-provider',
      runner: 'pi',
      environmentId: 'environment-registered-destination',
      sessionId: 'session-registered-destination',
      runId: 'run-provider-destination',
      executionId: 'execution-registered-destination',
      profileDigest: canonicalAgentProfileDigest(profile),
    },
    messages: [
      {
        messageId: 'message-source',
        action: 'include' as const,
        parts: [{ partIndex: 0, action: 'include' as const }],
      },
    ],
    requiresAcceptance: false,
  }
  const plan = { ...material, digest: portableContextPlanDigest(material) }
  return createContextTransferRequest({
    operationId: 'operation-transfer-registered',
    profile,
    plan,
    acceptance: { planDigest: plan.digest, acceptedAt: at, acceptedBy: 'user' },
  })
}

test('registered same-provider connections attach and recover the accepted HTTP destination without create', async () => {
  const firstServer = await startRuntimeBridgeServer({
    expectedBearer: 'private-first',
    responseText: 'WRONG_ACCOUNT',
  })
  const secondServer = await startRuntimeBridgeServer({
    expectedBearer: 'private-second',
    responseText: 'REGISTERED_TRANSFER_OK',
  })
  const credentials = new MemoryCredentialStore()
  const records = ['first', 'second'].map(
    (account, index): ConnectionRecord => ({
      id: createConnectionId(`connection-registered-${account}`),
      kind: 'agent-provider',
      name: account,
      endpoint: index === 0 ? firstServer.endpoint : secondServer.endpoint,
      credentialRef: createCredentialRefId(`credential-${account}`),
      providerOptions: {
        provider: 'same-provider',
        transport: 'local',
        account,
        lifecycle: 'retained',
        idleTtlSeconds: 1800,
      },
      createdAt: at,
      updatedAt: at,
      lastHealth: { status: 'unknown' },
    }),
  )
  const first = records[0]!
  const second = records[1]!
  for (const record of records)
    await credentials.store({
      ref: credentialRef(`cred:v1:${record.providerOptions.account}`),
      value: bindCredentialToOrigin(
        new TextEncoder().encode(`private-${record.providerOptions.account}`),
        record.endpoint!,
      ),
    })
  const selected: string[] = []
  let creates = 0
  const connectionOptions = {
    credentials,
    credentialRefResolver: (ref: string) =>
      credentialRef(`cred:v1:${ref.replace('credential-', '')}`),
    providerRegistryFactory: ({
      record,
      endpoint,
      credential,
    }: import('../src/adapters/connections/production-connection-types.js').ConnectionProviderRegistryInput) => {
      selected.push(record.id)
      const provider = createCliBridgeProvider({
        name: 'same-provider',
        baseUrl: endpoint,
        defaultModel: 'pi/gpt-5',
        ...(credential === undefined ? {} : { bearerToken: credential }),
      })
      return createAgentEnvironmentProviderRegistry([
        {
          ...provider,
          async create() {
            creates += 1
            throw new Error('Attachment must never create')
          },
        },
      ])
    },
  }
  const admissions: RetainedRunAdmissionRecord[] = []
  const production = createProductionComposition({
    profile,
    connections: records,
    connectionId: first.id,
    connectionOptions,
  })
  try {
    const request = transferRequest()
    assert.equal(
      await production.execution.context?.supports?.(request.plan.destination, {
        connectionId: second.id,
      }),
      true,
    )
    const accepted = await production.execution.context?.transfer?.(request, {
      connectionId: second.id,
    })
    assert.ok(accepted?.status === 'accepted')
    const input: ExecuteTurnInput = {
      operationId: 'operation-first-registered-turn',
      runId: 'run-braid-registered-destination',
      turnId: 'turn-braid-registered-destination',
      text: 'Continue here',
      profile,
      connectionId: second.id,
      contextTransfer: request,
      contextTransferReceipt: accepted,
      sessionId: accepted.sessionId,
      signal: new AbortController().signal,
      onRetainedAdmission: async (admission) => {
        admissions.push(structuredClone(admission))
      },
    }
    const admission = await production.execution.admit?.(input)
    assert.ok(admission)
    for (const changed of [
      {
        ...input,
        contextTransfer: { ...request, requestDigest: `sha256:${'b'.repeat(64)}` as const },
      },
      { ...input, contextTransferReceipt: { ...accepted, runId: 'run-substituted-destination' } },
    ]) {
      await assert.rejects(async () => {
        for await (const _ of production.execution.streamTurn(changed)) {
          /* drain */
        }
      }, /not admitted with this exact request/u)
    }
    assert.equal(secondServer.requests.length, 0)
    assert.equal(creates, 0)
    const events = []
    for await (const event of production.execution.streamTurn(input)) events.push(event)
    assert.match(JSON.stringify(events), /REGISTERED_TRANSFER_OK/u)
    assert.doesNotMatch(JSON.stringify(events), /WRONG_ACCOUNT/u)
    assert.equal(firstServer.requests.length, 0)
    assert.equal(secondServer.requests[0]?.authorization, 'Bearer private-second')
    assert.deepEqual(secondServer.requests[0]?.body.context_transfer, request)
    assert.equal(secondServer.requests[0]?.runId, accepted.runId)
    assert.equal(secondServer.requests[0]?.body.execution_id, accepted.executionId)
    assert.deepEqual(
      admissions.map((value) => value.phase),
      ['intent', 'environment', 'dispatched'],
    )
    const dispatched = admissions.find((value) => value.phase === 'dispatched')
    assert.ok(dispatched?.phase === 'dispatched')
    assert.equal(dispatched.controlRef.runId, accepted.runId)
    const receipt = createAdmissionReceipt({
      runId: input.runId,
      turnId: input.turnId!,
      operationId: input.operationId,
      conversationId: 'conversation-registered',
      branchId: 'branch-registered',
      admittedAt: at,
      text: input.text,
      profile,
      connectionId: second.id,
      capabilities: admission.capabilities,
      materializationReceipt: admission.materializationReceipt,
      environmentId: accepted.environmentId,
      providerSessionId: accepted.sessionId,
      portableContextTransferRequest: request,
      portableContextTransferReceipt: accepted,
    })
    const persisted = JSON.parse(JSON.stringify(receipt)) as typeof receipt
    assert.deepEqual(persisted.requested.portableContextTransferRequest, request)
    assert.deepEqual(persisted.requested.portableContextTransferReceipt, accepted)
    assert.doesNotMatch(JSON.stringify(persisted), /private-first|private-second/u)
    const restarted = createProductionComposition({
      profile,
      connections: records,
      connectionId: first.id,
      connectionOptions,
    })
    const recovery = {
      runId: input.runId,
      receipt: persisted,
      retainedAdmission: dispatched,
      controlRef: dispatched.controlRef,
    }
    const status = await restarted.execution.status?.(recovery)
    assert.ok(status)
    assert.equal(status.runId, input.runId)
    const cancelled = await restarted.execution.cancelRun?.({
      ...recovery,
      operationId: 'operation-cancel-registered',
    })
    assert.equal(cancelled?.outcome, 'accepted')
    for await (const _ of restarted.execution.reconnect!({ ...recovery, signal: input.signal })) {
      /* drain */
    }
    assert.equal(firstServer.cancellations.length, 0)
    assert.equal(secondServer.cancellations[0]?.runId, accepted.runId)
    assert.ok(secondServer.replays.some((value) => value.runId === accepted.runId))
    assert.deepEqual(selected, [second.id, second.id])
    assert.equal(creates, 0)
  } finally {
    await firstServer.close()
    await secondServer.close()
  }
})
