import {
  buildBraidGraph,
  type BraidGraph,
  type GraphEntity,
  type GraphRelation,
} from '../domain/graph.js'
import { branchId, conversationId, eventId, operationId, runId, turnId } from '../domain/ids.js'
import type { BraidEventEnvelope } from '../domain/events.js'
import type { BraidState } from '../domain/state.js'

function sourceEvent(envelope: BraidEventEnvelope): string {
  if (!envelope.eventId) throw new Error('The journal event has no durable event identity')
  return envelope.eventId
}

function graphOperationId(value: string): ReturnType<typeof operationId> {
  return operationId(value)
}

export function applicationGraph(
  state: BraidState,
  events: readonly BraidEventEnvelope[],
): BraidGraph {
  const conversation = conversationId(state.conversationId)
  const branch = branchId(state.branchId)
  const entities: GraphEntity[] = [
    { id: conversation, kind: 'conversation', label: conversation },
    { id: branch, kind: 'branch', label: branch },
  ]
  const relations: GraphRelation[] = []
  const workspaceEvent = events.find((item) => item.event.kind === 'workspace.opened')
  if (workspaceEvent) {
    relations.push({
      id: `edge-branch-${workspaceEvent.sequence}` as GraphRelation['id'],
      kind: 'continued',
      from: conversation,
      to: branch,
      operationId: operationId(`operation-graph-${workspaceEvent.sequence}`),
      at: workspaceEvent.occurredAt,
      provenance: { sourceEventId: eventId(sourceEvent(workspaceEvent)) },
    })
  }
  for (const run of state.runs) {
    const requested = events.find(
      (item) => item.event.kind === 'run.requested' && item.event.runId === run.id,
    )
    if (!requested) continue
    if (requested.event.kind !== 'run.requested') continue
    const requestedEvent = requested.event
    const turn = turnId(requestedEvent.turnId)
    const runNode = runId(run.id)
    entities.push(
      { id: turn, kind: 'turn', label: turn },
      {
        id: runNode,
        kind: 'run',
        label: runNode,
        data: { status: run.status, operationId: requestedEvent.operationId },
      },
    )
    const provenance = { sourceEventId: eventId(sourceEvent(requested)) }
    relations.push(
      {
        id: `edge-turn-${requested.sequence}` as GraphRelation['id'],
        kind: 'continued',
        from: branch,
        to: turn,
        operationId: graphOperationId(requestedEvent.operationId),
        at: requested.occurredAt,
        provenance,
      },
      {
        id: `edge-run-${requested.sequence}` as GraphRelation['id'],
        kind: 'continued',
        from: turn,
        to: runNode,
        operationId: graphOperationId(requestedEvent.operationId),
        at: requested.occurredAt,
        provenance,
      },
    )
  }
  return buildBraidGraph({ entities, relations })
}
