import type { RemoteSupervisorObservation } from '../adapters/runtime/remote-supervisor.js'
import { canonicalDigest } from '../domain/canonical.js'
import type {
  GraphEdgeRecord,
  GraphNodeRecord,
  SupervisorRecord,
  WorkerRecord,
} from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import { createSupervisorId, createWorkerId } from '../domain/ids-values.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { AnalysisApplicationHost } from './analysis-types.js'
import {
  commitSupervisionRecords,
  type SupervisionRecords,
  type SupervisorSnapshotRequest,
} from './supervisor-projection.js'

function status(value: string): WorkerRecord['status'] {
  switch (value) {
    case 'pending':
    case 'queued':
      return 'pending'
    case 'acquiring':
    case 'running':
      return 'running'
    case 'done':
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'down':
    case 'failed':
      return 'failed'
    default:
      return 'unknown'
  }
}

/** Bind one Runtime read capability to the requesting conversation without inventing a Braid run. */
export async function commitRemoteSupervisorProjection(
  host: AnalysisApplicationHost,
  input: SupervisorSnapshotRequest & { readonly remoteEndpointEnv: string },
  observation: RemoteSupervisorObservation,
): Promise<SupervisionRecords> {
  const state = host.currentState()
  if (state.conversationId === null)
    throw new Error('Open a conversation before observing a remote tree')
  const { tree, streams } = observation
  const id = createSupervisorId(
    `supervisor-remote-${canonicalDigest({ workspace: input.rootDir, endpointEnv: input.remoteEndpointEnv, root: tree.root }).slice(0, 40)}`,
  )
  const previous = state.supervisors.find((record) => record.id === id)
  if (previous?.conversationId !== undefined && previous.conversationId !== state.conversationId) {
    throw new Error('This remote Runtime tree is already attached to another conversation')
  }
  const at = input.now ?? new Date().toISOString()
  const createdAt = previous?.createdAt ?? at
  const root = tree.nodes.find((node) => node.id === tree.root)
  const supervisor: SupervisorRecord = {
    id,
    runtimeId: tree.root,
    runtimeRoot: input.rootDir,
    conversationId: state.conversationId,
    remoteEndpointEnv: input.remoteEndpointEnv,
    status:
      root === undefined ? (tree.inFlight > 0 ? 'running' : 'unknown') : rootStatus(root.status),
    title: redactSensitiveText(`Runtime ${tree.root}`),
    workerCount: tree.nodes.length,
    createdAt,
    updatedAt: at,
  }
  const byId = new Map(
    tree.nodes.map((node) => [
      node.id,
      createWorkerId(
        `worker-remote-${canonicalDigest({ supervisor: id, worker: node.id }).slice(0, 40)}`,
      ),
    ]),
  )
  if (new Set(tree.nodes.map((node) => node.id)).size !== tree.nodes.length)
    throw new Error('Runtime tree contains duplicate agent identities')
  const workers: WorkerRecord[] = []
  const parents = new Set(tree.nodes.map((node) => node.parent))
  const priorWorkers = new Map(state.workers.map((worker) => [worker.id, worker]))
  const graphNodes: GraphNodeRecord[] = [
    {
      ...graphNode({ kind: 'supervisor', id }, createdAt, supervisor.title),
      status: supervisor.status,
    },
  ]
  const graphEdges: GraphEdgeRecord[] = [
    graphEdge({
      kind: 'attached',
      source: { kind: 'conversation', id: state.conversationId },
      destination: { kind: 'supervisor', id },
      at: createdAt,
    }),
  ]
  for (const node of tree.nodes) {
    const workerId = byId.get(node.id)
    if (workerId === undefined) continue
    const prior = priorWorkers.get(workerId)
    const stream = streams.get(node.id)
    const parent = node.parent === undefined ? undefined : byId.get(node.parent)
    const worker: WorkerRecord = {
      id: workerId,
      runtimeId: node.id,
      supervisorId: id,
      ...(node.parent === undefined ? {} : { parentRuntimeRef: node.parent }),
      ...(parent === undefined ? {} : { parentWorkerId: parent }),
      title: redactSensitiveText(node.label),
      role: parents.has(node.id) ? 'manager' : 'worker',
      runner: redactSensitiveText(node.runtime),
      status: status(node.status),
      streamStatus: stream?.status ?? 'select this agent to read its live events',
      ...(stream?.text === undefined || stream.text.length === 0
        ? prior?.logTail === undefined
          ? {}
          : { logTail: prior.logTail }
        : { logTail: stream.text }),
      createdAt: prior?.createdAt ?? at,
      updatedAt: at,
    }
    workers.push(worker)
    graphNodes.push({
      ...graphNode({ kind: 'worker', id: workerId }, worker.createdAt, worker.title),
      status: worker.status,
    })
    if (node.parent === undefined || node.parent === tree.root || parent !== undefined) {
      graphEdges.push(
        graphEdge({
          kind: 'spawned',
          source:
            parent === undefined ? { kind: 'supervisor', id } : { kind: 'worker', id: parent },
          destination: { kind: 'worker', id: workerId },
          at: worker.createdAt,
        }),
      )
    }
  }
  // Absence from a later complete tree is explicit uncertainty, not an invented completion.
  const seen = new Set(workers.map((worker) => worker.id))
  for (const prior of state.workers) {
    if (prior.supervisorId !== id || seen.has(prior.id)) continue
    workers.push({
      ...prior,
      status: 'unknown',
      streamStatus: 'agent absent from the latest Runtime tree',
      updatedAt: at,
    })
    graphNodes.push({
      ...graphNode({ kind: 'worker', id: prior.id }, prior.createdAt, prior.title),
      status: 'unknown',
    })
  }
  const projection = { supervisors: [supervisor], workers, graphNodes, graphEdges }
  await commitSupervisionRecords(host, projection)
  return projection
}

function rootStatus(value: string): SupervisorRecord['status'] {
  const observed = status(value)
  return observed === 'pending' ? 'unknown' : observed === 'waiting' ? 'running' : observed
}
