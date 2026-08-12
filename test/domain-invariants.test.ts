import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import { STARTER_PROFILE } from '../src/app/composition.js'
import type { ConnectionRecord, InteractionRecord, RunRecord } from '../src/domain/entities.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import {
  createBranchId,
  createConnectionId,
  createConversationId,
  createEnvironmentId,
  createEventId,
  createGraphEdgeId,
  createGraphNodeId,
  createInteractionId,
  createOperationId,
  createProviderSessionId,
  createRunId,
  createTurnId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import {
  assertConnectionRecord,
  assertInteractionRecord,
  assertRunRecord,
} from '../src/domain/invariants.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import { reduceEvent } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { DEFAULT_RUN_CAPABILITIES } from '../src/ports/execution.js'

const at = '2026-08-02T00:00:00.000Z'

function envelope(event: BraidEvent, sequence: number): JournalEventEnvelope {
  return {
    eventId: createEventId(`event-invariant-${sequence}`),
    sequence,
    revision: sequence,
    occurredAt: at,
    event,
  }
}

function graphNode(id: ReturnType<typeof createGraphNodeId>) {
  return {
    id,
    reference: { kind: 'workspace' as const, id: createWorkspaceId('workspace-invariant') },
    createdAt: at,
    updatedAt: at,
  }
}

test('graph edges fail closed for dangling nodes and cycles', () => {
  const first = graphNode(createGraphNodeId('node-invariant-a'))
  const second = graphNode(createGraphNodeId('node-invariant-b'))
  const initial = initialState(STARTER_PROFILE)
  const withNodes = [
    envelope({ kind: 'graph.node.upserted', node: first }, 1),
    envelope({ kind: 'graph.node.upserted', node: second }, 2),
  ].reduce(reduceEvent, initial)

  assert.throws(
    () =>
      reduceEvent(
        withNodes,
        envelope(
          {
            kind: 'graph.edge.upserted',
            edge: {
              id: createGraphEdgeId('edge-invariant-dangling'),
              kind: 'continued',
              source: first.id,
              destination: createGraphNodeId('node-invariant-missing'),
              provenance: {},
              createdAt: at,
            },
          },
          3,
        ),
      ),
    /missing node/u,
  )

  const withFirstEdge = reduceEvent(
    withNodes,
    envelope(
      {
        kind: 'graph.edge.upserted',
        edge: {
          id: createGraphEdgeId('edge-invariant-forward'),
          kind: 'continued',
          source: first.id,
          destination: second.id,
          provenance: {},
          createdAt: at,
        },
      },
      3,
    ),
  )

  assert.throws(
    () =>
      reduceEvent(
        withFirstEdge,
        envelope(
          {
            kind: 'graph.edge.upserted',
            edge: {
              id: createGraphEdgeId('edge-invariant-cycle'),
              kind: 'continued',
              source: second.id,
              destination: first.id,
              provenance: {},
              createdAt: at,
            },
          },
          4,
        ),
      ),
    /cycle/u,
  )
})

test('1,000 generated graph histories preserve acyclicity and node boundaries', () => {
  for (let index = 0; index < 1_000; index += 1) {
    const first = graphNode(createGraphNodeId(`node-property-${index}-a`))
    const second = graphNode(createGraphNodeId(`node-property-${index}-b`))
    const third = graphNode(createGraphNodeId(`node-property-${index}-c`))
    const events: JournalEventEnvelope[] = [first, second, third].map((node, nodeIndex) =>
      envelope({ kind: 'graph.node.upserted', node }, nodeIndex + 1),
    )
    events.push(
      envelope(
        {
          kind: 'graph.edge.upserted',
          edge: {
            id: createGraphEdgeId(`edge-property-${index}-ab`),
            kind: 'continued',
            source: first.id,
            destination: second.id,
            provenance: {},
            createdAt: at,
          },
        },
        4,
      ),
      envelope(
        {
          kind: 'graph.edge.upserted',
          edge: {
            id: createGraphEdgeId(`edge-property-${index}-bc`),
            kind: 'continued',
            source: second.id,
            destination: third.id,
            provenance: {},
            createdAt: at,
          },
        },
        5,
      ),
    )
    const state = events.reduce(reduceEvent, initialState(STARTER_PROFILE))
    assert.equal(state.graphNodes.length, 3)
    assert.equal(state.graphEdges.length, 2)
  }
})

test('connection state accepts transport metadata but rejects provider-native options', () => {
  const connection: ConnectionRecord = {
    id: createConnectionId('connection-invariant'),
    kind: 'cli-bridge',
    name: 'Local bridge',
    providerOptions: { transport: 'stdio', capabilityHints: ['interaction.answerSpec'] },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
  assert.doesNotThrow(() => assertConnectionRecord(connection))
  assert.throws(
    () =>
      assertConnectionRecord({
        ...connection,
        providerOptions: {
          ...connection.providerOptions,
          providerNativeModelFlag: '--dangerously-skip-permissions',
        },
      } as ConnectionRecord),
    /provider-native state/u,
  )
  assert.throws(
    () =>
      assertConnectionRecord({
        ...connection,
        endpoint: 'https://user:password=do-not-store@example.test',
      }),
    /credential material|URL credentials/u,
  )
  assert.throws(
    () =>
      assertConnectionRecord({
        ...connection,
        providerOptions: { lifecycle: 'retained', idleTtlSeconds: 1_800 },
      }),
    /only for tangle-sandbox/u,
  )
})

test('unknown interaction kinds remain renderable through the canonical answer specification', () => {
  const interactionId = createInteractionId('interaction-future')
  const base: InteractionRecord = {
    id: interactionId,
    runId: createRunId('run-interaction'),
    request: {
      id: interactionId,
      kind: 'provider.future.interaction',
      title: 'A future provider question',
      answerSpec: { fields: [{ type: 'text', name: 'answer', label: 'Answer', required: true }] },
    },
    status: 'pending',
    createdAt: at,
    updatedAt: at,
  }
  assert.doesNotThrow(() => assertInteractionRecord(base))
  assert.throws(
    () =>
      assertInteractionRecord({
        ...base,
        request: {
          ...base.request,
          answerSpec: {
            fields: [{ type: 'secret', name: 'password', label: 'Password', required: true }],
          },
        },
        status: 'resolved',
        resolution: {
          outcome: 'accepted',
          operationId: createOperationId('op-interaction-secret'),
          publicData: { password: 'must-not-persist' },
          containsSecret: false,
          resolvedAt: at,
        },
      }),
    /secret-designated|secret interaction/u,
  )
})

function providerOwnedRun(): RunRecord {
  const runId = createRunId('run-local-identity')
  const conversationId = createConversationId('conversation-run-identity')
  const branchId = createBranchId('branch-run-identity')
  const turnId = createTurnId('turn-run-identity')
  const operationId = createOperationId('operation-run-identity')
  const providerSessionId = createProviderSessionId('provider-session-run-identity')
  const receipt = createAdmissionReceipt({
    runId,
    turnId,
    operationId,
    conversationId,
    branchId,
    admittedAt: at,
    profile: STARTER_PROFILE,
    text: 'provider-owned run identity',
    capabilities: DEFAULT_RUN_CAPABILITIES,
    provider: 'tangle-sandbox',
    providerSessionId,
  })
  const requestDigest = `sha256:${'a'.repeat(64)}` as `sha256:${string}`
  const controlRef: AgentExactRunControlRef = {
    runId: 'tangle-execution-provider-owned',
    provider: 'tangle-sandbox',
    environmentId: 'tangle-environment-provider-owned',
    sessionId: providerSessionId,
    executionId: 'tangle-execution-provider-owned',
    requestDigest,
  }
  return {
    id: runId,
    conversationId,
    branchId,
    turnId,
    operationId,
    status: 'streaming',
    receipt,
    capabilities: receipt.capabilities,
    providerSessionId,
    environmentId: createEnvironmentId('environment-run-identity'),
    controlRef,
    inputTokens: 0,
    outputTokens: 0,
    tokensKnown: false,
    usdKnown: false,
    complete: false,
    startedAt: at,
    updatedAt: at,
    lastProviderSequence: 0,
    eventCount: 0,
    interactions: [],
    activity: [],
    eventDetails: [],
  }
}

test('run identity keeps local run IDs separate from provider-owned control references', () => {
  const run = providerOwnedRun()

  assert.notEqual(run.controlRef?.runId, run.id)
  assert.doesNotThrow(() => assertRunRecord(run))
})

test('run identity still binds a control reference to the persisted provider session', () => {
  const run = providerOwnedRun()
  const controlRef = run.controlRef
  assert.ok(controlRef)

  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        controlRef: { ...controlRef, sessionId: 'tangle-session-not-persisted' },
      }),
    /run\.controlRef\.sessionId must match run\.providerSessionId/u,
  )
})
