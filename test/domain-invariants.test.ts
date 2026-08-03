import assert from 'node:assert/strict'
import test from 'node:test'
import { STARTER_PROFILE } from '../src/app/composition.js'
import { assertConnectionRecord, assertInteractionRecord } from '../src/domain/invariants.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import { reduceEvent } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import {
  createConnectionId,
  createEventId,
  createGraphEdgeId,
  createGraphNodeId,
  createInteractionId,
  createOperationId,
  createRunId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import type { ConnectionRecord, InteractionRecord } from '../src/domain/entities.js'

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
