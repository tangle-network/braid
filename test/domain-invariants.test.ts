import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentExactRunControlRef } from '@tangle-network/agent-interface'
import { STARTER_PROFILE } from '../src/app/composition.js'
import {
  createInteractionRequest,
  interactionResponseBinding,
} from '../src/app/interaction-request.js'
import type { ConnectionRecord, RunRecord } from '../src/domain/entities.js'
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
  createRuleId,
  createRunId,
  createTurnId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import { assertConnectionRecord, assertRunRecord } from '../src/domain/invariants.js'
import { createAdmissionReceipt } from '../src/domain/receipts.js'
import { reduceEvent } from '../src/domain/reducer.js'
import type { BraidInteraction } from '../src/domain/runtime-projection.js'
import { initialState } from '../src/domain/state.js'
import { DEFAULT_RUN_CAPABILITIES } from '../src/ports/execution.js'
import type { Digest } from '../src/domain/ids.js'

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

function canonicalRunInteraction(
  run: RunRecord,
  options: {
    readonly idSuffix?: string
    readonly kind?: string
    readonly bindingRunId?: string
  } = {},
): BraidInteraction {
  const interactionId = createInteractionId(
    `interaction-run-invariant-${options.idSuffix ?? 'future'}`,
  )
  const controlRef = run.controlRef
  const request = createInteractionRequest({
    id: interactionId,
    kind: options.kind ?? 'provider.future.interaction',
    title: 'A future provider question',
    answerSpec: {
      fields: [{ type: 'text', name: 'answer', label: 'Answer', required: true }],
    },
    binding: {
      runId: options.bindingRunId ?? run.id,
      provider: controlRef?.provider ?? 'test-provider',
      environmentId: controlRef?.environmentId ?? 'environment-run-invariant',
      sessionId: controlRef?.sessionId ?? 'session-run-invariant',
      executionId: controlRef?.executionId ?? 'execution-run-invariant',
      interactionId,
    },
  })
  return {
    request,
    responseBinding: interactionResponseBinding(request),
    runId: run.id,
    source: { occurredAt: at },
    status: 'pending',
  }
}

test('canonical run interactions accept future kinds and reject duplicate request IDs', () => {
  const run = providerOwnedRun()
  const interaction = canonicalRunInteraction(run)

  assert.doesNotThrow(() => assertRunRecord({ ...run, interactions: [interaction] }))
  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [{ ...interaction, source: { sequence: 0 } }],
      }),
    /run\.interactions\[0\]\.source\.sequence must be a positive safe integer/u,
  )
  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [{ ...interaction, source: { eventId: 'password=not-persisted' } }],
      }),
    /run\.interactions\[0\]\.source\.eventId must be a safe public identifier/u,
  )
  assert.throws(
    () => assertRunRecord({ ...run, interactions: [interaction, interaction] }),
    /run\.interactions\.request contains duplicate identifier/u,
  )
})

test('canonical run interactions reject malformed secret requests and mismatched bindings', () => {
  const run = providerOwnedRun()
  const interaction = canonicalRunInteraction(run, { idSuffix: 'invalid' })
  const secretDefault = {
    ...interaction,
    request: {
      ...interaction.request,
      answerSpec: {
        fields: [{ type: 'secret' as const, name: 'password', label: 'Password', required: true }],
      },
      default: { outcome: 'accepted' as const, data: { password: 'must-not-persist' } },
    },
  }

  assert.throws(
    () => assertRunRecord({ ...run, interactions: [secretDefault] }),
    /run\.interactions\[0\]\.request is invalid/u,
  )

  const mismatchedRequestBinding = canonicalRunInteraction(run, {
    idSuffix: 'request-binding',
    bindingRunId: createRunId('run-not-containing'),
  })
  assert.throws(
    () => assertRunRecord({ ...run, interactions: [mismatchedRequestBinding] }),
    /request\.binding\.runId must match run\.id/u,
  )

  const mismatchedResponseBinding = {
    ...interaction,
    responseBinding: {
      ...interaction.responseBinding,
      executionId: 'tangle-execution-not-matching',
    },
  }
  assert.throws(
    () => assertRunRecord({ ...run, interactions: [mismatchedResponseBinding] }),
    /responseBinding\.executionId must match request\.binding\.executionId/u,
  )

  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [{ ...interaction, runId: createRunId('run-not-containing') }],
      }),
    /runId must match run\.id/u,
  )
})

test('canonical run interaction response operations preserve status and secrecy invariants', () => {
  const run = providerOwnedRun()
  const interaction = canonicalRunInteraction(run, { idSuffix: 'response-operation' })
  const responding = {
    ...interaction,
    status: 'responding' as const,
    responseOperation: {
      operationId: createOperationId('operation-interaction-response-invariant'),
      outcome: 'accepted' as const,
      dataDigest: 'b'.repeat(64) as Digest,
      containsSecret: false,
    },
  }

  assert.doesNotThrow(() => assertRunRecord({ ...run, interactions: [responding] }))
  const automationRule = {
    id: createRuleId('rule-interaction-response-invariant'),
    enabled: true,
    matcher: { interactionKind: 'provider.future.interaction' },
    answer: { answer: 'approved' },
    responseScope: 'once' as const,
    createdAt: at,
    uses: 0,
  }
  assert.doesNotThrow(() =>
    assertRunRecord({
      ...run,
      interactions: [
        {
          ...responding,
          responseOperation: { ...responding.responseOperation, automationRule },
        },
      ],
    }),
  )
  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [
          {
            ...responding,
            responseOperation: {
              ...responding.responseOperation,
              automationRule: { ...automationRule, answer: { password: 'must-not-persist' } },
            },
          },
        ],
      }),
    /rule\.answer\.password is secret-designated and cannot be retained/u,
  )
  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [
          {
            ...responding,
            responseOperation: { ...responding.responseOperation, containsSecret: true },
          },
        ],
      }),
    /secret responseOperation cannot retain dataDigest/u,
  )
  assert.throws(
    () => assertRunRecord({ ...run, interactions: [{ ...responding, status: 'declined' }] }),
    /responseOperation status does not match its outcome/u,
  )
  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [
          {
            ...responding,
            responseOperation: { ...responding.responseOperation, operationId: 'not-an-operation' },
          },
        ],
      }),
    /responseOperation\.operationId is not a valid operation identifier/u,
  )
  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [
          {
            ...responding,
            responseOperation: { ...responding.responseOperation, dataDigest: 'not-a-digest' },
          },
        ],
      }),
    /responseOperation\.dataDigest is not a SHA-256 digest/u,
  )
  assert.throws(
    () =>
      assertRunRecord({
        ...run,
        interactions: [
          {
            ...responding,
            responseOperation: {
              ...responding.responseOperation,
              containsSecret: 'false' as unknown as boolean,
            },
          },
        ],
      }),
    /responseOperation\.containsSecret must be boolean/u,
  )
})

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
