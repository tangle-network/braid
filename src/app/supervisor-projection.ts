import type { TopSnapshot } from '../adapters/runtime/supervisor-watch.js'
import { canonicalDigest } from '../domain/canonical.js'
import type {
  GraphEdgeRecord,
  GraphNodeRecord,
  SupervisorRecord,
  WorkerRecord,
} from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import type { RunId, SupervisorId, WorkerId } from '../domain/ids.js'
import { createSupervisorId, createWorkerId } from '../domain/ids-values.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

const MAX_RUNTIME_ID_LENGTH = 1_024

export interface SupervisorRunBinding {
  readonly runtimeSupervisorId: string
  readonly rootRunId: RunId
}

export interface SupervisorSnapshotRequest {
  readonly rootDir: string
  /** Binds only named runtime supervisors. An omitted binding never implies ownership. */
  readonly bindings?: readonly SupervisorRunBinding[]
  readonly now?: string
}

export interface SupervisorWatchRequest extends SupervisorSnapshotRequest {
  readonly intervalMs?: number
  readonly signal?: AbortSignal
}

export interface SupervisorProjection {
  readonly raw: TopSnapshot
  readonly supervisors: readonly SupervisorRecord[]
  readonly workers: readonly WorkerRecord[]
  readonly graphNodes: readonly GraphNodeRecord[]
  readonly graphEdges: readonly GraphEdgeRecord[]
}

function validIso(value: string | undefined, fallback: string): string {
  if (value !== undefined && Number.isFinite(Date.parse(value))) return value
  return fallback
}

function snapshotTime(input: SupervisorSnapshotRequest, raw: TopSnapshot): string {
  if (input.now !== undefined && Number.isFinite(Date.parse(input.now))) return input.now
  if (Number.isFinite(raw.generatedAt)) return new Date(raw.generatedAt).toISOString()
  return new Date().toISOString()
}

function runtimeIdentity(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`${name} is empty`)
  if (value.length > MAX_RUNTIME_ID_LENGTH) {
    throw new Error(`${name} exceeds ${MAX_RUNTIME_ID_LENGTH} characters`)
  }
  return value
}

function supervisorStatus(value: string): SupervisorRecord['status'] {
  switch (value.toLowerCase()) {
    case 'starting':
    case 'queued':
      return 'starting'
    case 'running':
      return 'running'
    case 'completed':
    case 'complete':
    case 'done':
    case 'success':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    default:
      return 'unknown'
  }
}

function workerStatus(value: string): WorkerRecord['status'] {
  switch (value) {
    case 'running':
      return 'running'
    case 'done':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'down':
      return 'failed'
    default:
      return 'unknown'
  }
}

function supervisorId(rootDir: string, rawId: string): SupervisorId {
  return createSupervisorId(
    `supervisor-runtime-${canonicalDigest({ rootDir, rawId }).slice(0, 40)}`,
  )
}

function workerId(supervisor: SupervisorId, rawId: string): WorkerId {
  return createWorkerId(`worker-runtime-${canonicalDigest({ supervisor, rawId }).slice(0, 40)}`)
}

function finite(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) || value < 0 ? undefined : value
}

function observedUsage(input: {
  readonly tokensInput: number
  readonly tokensOutput: number
  readonly usd: number
  readonly ms?: number
  readonly latencyMs?: number
  readonly iterations?: number
}): NonNullable<SupervisorRecord['totalUsage']> {
  return {
    inputTokens: finite(input.tokensInput) ?? 0,
    outputTokens: finite(input.tokensOutput) ?? 0,
    spendUsd: finite(input.usd) ?? 0,
    latencyMs: finite(input.latencyMs ?? input.ms) ?? 0,
    ...(finite(input.iterations) === undefined ? {} : { iterations: input.iterations }),
    completeness: 'observed-floor',
  }
}

function bindingsFor(input: SupervisorSnapshotRequest): ReadonlyMap<string, RunId> {
  const output = new Map<string, RunId>()
  for (const binding of input.bindings ?? []) {
    const runtimeSupervisorId = runtimeIdentity(
      binding.runtimeSupervisorId,
      'runtime supervisor binding id',
    )
    const existing = output.get(runtimeSupervisorId)
    if (existing !== undefined && existing !== binding.rootRunId) {
      throw new Error(`Runtime supervisor ${runtimeSupervisorId} has conflicting run bindings`)
    }
    output.set(runtimeSupervisorId, binding.rootRunId)
  }
  return output
}

function uniqueWorkerReferences(
  supervisor: SupervisorId,
  workers: TopSnapshot['supervisors'][number]['workers'],
): {
  readonly byId: ReadonlyMap<string, WorkerId>
  readonly byUniqueLabel: ReadonlyMap<string, WorkerId>
} {
  const byId = new Map<string, WorkerId>()
  const labels = new Map<string, WorkerId | null>()
  for (const worker of workers) {
    const runtimeWorkerId = runtimeIdentity(worker.id, 'runtime worker id')
    if (byId.has(runtimeWorkerId)) {
      throw new Error(`Runtime supervisor contains duplicate worker id ${runtimeWorkerId}`)
    }
    const id = workerId(supervisor, runtimeWorkerId)
    byId.set(runtimeWorkerId, id)
    const previous = labels.get(worker.label)
    labels.set(worker.label, previous === undefined ? id : null)
  }
  const byUniqueLabel = new Map<string, WorkerId>()
  for (const [label, id] of labels) {
    if (id !== null) byUniqueLabel.set(label, id)
  }
  return { byId, byUniqueLabel }
}

function projectSnapshot(input: SupervisorSnapshotRequest, raw: TopSnapshot): SupervisorProjection {
  const at = snapshotTime(input, raw)
  const bindings = bindingsFor(input)
  const supervisors: SupervisorRecord[] = []
  const workers: WorkerRecord[] = []
  const graphNodes: GraphNodeRecord[] = []
  const graphEdges: GraphEdgeRecord[] = []
  const seenSupervisors = new Set<string>()

  for (const view of raw.supervisors) {
    const runtimeSupervisorId = runtimeIdentity(view.id, 'runtime supervisor id')
    if (seenSupervisors.has(runtimeSupervisorId)) {
      throw new Error(`Runtime snapshot contains duplicate supervisor id ${runtimeSupervisorId}`)
    }
    seenSupervisors.add(runtimeSupervisorId)
    const id = supervisorId(input.rootDir, runtimeSupervisorId)
    const createdAt = validIso(view.startedAt, at)
    const rootRunId = bindings.get(runtimeSupervisorId)
    supervisors.push({
      id,
      runtimeId: runtimeSupervisorId,
      runtimeRoot: input.rootDir,
      ...(rootRunId === undefined ? {} : { rootRunId }),
      status: supervisorStatus(view.status),
      ...(view.task.trim().length === 0 ? {} : { title: redactSensitiveText(view.task) }),
      ...(view.driverModel === undefined || view.driverModel.trim().length === 0
        ? {}
        : { driverModel: redactSensitiveText(view.driverModel) }),
      ...(view.workerModel === undefined || view.workerModel.trim().length === 0
        ? {}
        : { workerModel: redactSensitiveText(view.workerModel) }),
      driverUsage: observedUsage(view.driverSpend),
      totalUsage: observedUsage(view.totals),
      workerCount: view.totals.workers,
      createdAt,
      updatedAt: validIso(view.completedAt, at),
    })
    const supervisorReference = { kind: 'supervisor' as const, id }
    const supervisorNode = graphNode(supervisorReference, createdAt, redactSensitiveText(view.task))
    graphNodes.push({ ...supervisorNode, status: supervisorStatus(view.status) })

    const references = uniqueWorkerReferences(id, view.workers)
    for (const worker of view.workers) {
      const runtimeWorkerId = runtimeIdentity(worker.id, 'runtime worker id')
      const workerDomainId = references.byId.get(runtimeWorkerId)
      if (workerDomainId === undefined) continue
      const createdWorkerAt = validIso(worker.startedAt, createdAt)
      const parentRuntimeRef = worker.parent?.trim() || undefined
      const parentWorkerId =
        parentRuntimeRef === undefined
          ? undefined
          : (references.byId.get(parentRuntimeRef) ??
            references.byUniqueLabel.get(parentRuntimeRef))
      const logTail = redactSensitiveText(worker.liveTail.join('\n'))
      const title = redactSensitiveText(worker.label)
      workers.push({
        id: workerDomainId,
        runtimeId: runtimeWorkerId,
        supervisorId: id,
        ...(parentRuntimeRef === undefined
          ? {}
          : { parentRuntimeRef: redactSensitiveText(parentRuntimeRef) }),
        ...(parentWorkerId === undefined ? {} : { parentWorkerId }),
        status: workerStatus(worker.status),
        ...(finite(worker.spend.usd) === undefined ? {} : { spendUsd: worker.spend.usd }),
        ...(finite(worker.spend.tokensInput) === undefined
          ? {}
          : { inputTokens: worker.spend.tokensInput }),
        ...(finite(worker.spend.tokensOutput) === undefined
          ? {}
          : { outputTokens: worker.spend.tokensOutput }),
        ...(finite(worker.latencyMs) === undefined ? {} : { latencyMs: worker.latencyMs }),
        usageCompleteness: 'observed-floor',
        ...(logTail.length === 0 ? {} : { logTail }),
        title,
        ...(worker.runtime === undefined || worker.runtime.trim().length === 0
          ? {}
          : { runner: redactSensitiveText(worker.runtime) }),
        createdAt: createdWorkerAt,
        updatedAt: validIso(worker.endedAt, at),
      })
      const workerReference = { kind: 'worker' as const, id: workerDomainId }
      const workerNode = graphNode(workerReference, createdWorkerAt, title)
      graphNodes.push({ ...workerNode, status: workerStatus(worker.status) })
      if (parentRuntimeRef === undefined || parentWorkerId !== undefined) {
        graphEdges.push(
          graphEdge({
            kind: 'spawned',
            source:
              parentWorkerId === undefined
                ? supervisorReference
                : { kind: 'worker', id: parentWorkerId },
            destination: workerReference,
            at: createdWorkerAt,
          }),
        )
      }
    }
  }

  for (const binding of bindings.keys()) {
    if (!seenSupervisors.has(binding)) {
      throw new Error(`Run binding names unknown runtime supervisor ${binding}`)
    }
  }
  return { raw, supervisors, workers, graphNodes, graphEdges }
}

function assertRunBindingsExist(
  state: BraidState,
  bindings: readonly SupervisorRunBinding[] | undefined,
): void {
  const runIds = new Set(state.runs.map((run) => String(run.id)))
  for (const binding of bindings ?? []) {
    if (!runIds.has(String(binding.rootRunId))) {
      throw new Error(`Run binding names unknown Braid run ${binding.rootRunId}`)
    }
  }
}

function mergeSupervisor(
  existing: SupervisorRecord | undefined,
  observed: SupervisorRecord,
): SupervisorRecord {
  if (
    existing !== undefined &&
    (existing.runtimeId !== observed.runtimeId || existing.runtimeRoot !== observed.runtimeRoot)
  ) {
    throw new Error(`Supervisor identity collision for ${observed.id}`)
  }
  const rootRunId = observed.rootRunId ?? existing?.rootRunId
  return {
    ...observed,
    ...(rootRunId === undefined ? {} : { rootRunId }),
    createdAt: existing?.createdAt ?? observed.createdAt,
  }
}

function mergeWorker(existing: WorkerRecord | undefined, observed: WorkerRecord): WorkerRecord {
  if (
    existing !== undefined &&
    (existing.runtimeId !== observed.runtimeId || existing.supervisorId !== observed.supervisorId)
  ) {
    throw new Error(`Worker identity collision for ${observed.id}`)
  }
  return { ...observed, createdAt: existing?.createdAt ?? observed.createdAt }
}

function reconcileSupervisors(
  state: BraidState,
  input: SupervisorSnapshotRequest,
  observed: readonly SupervisorRecord[],
  at: string,
): SupervisorRecord[] {
  const existing = new Map(state.supervisors.map((record) => [String(record.id), record] as const))
  const output = observed.map((record) => mergeSupervisor(existing.get(String(record.id)), record))
  const observedIds = new Set(output.map((record) => String(record.id)))
  for (const record of state.supervisors) {
    if (record.runtimeRoot !== input.rootDir || observedIds.has(String(record.id))) continue
    output.push(
      record.status === 'starting' || record.status === 'running'
        ? { ...record, status: 'unknown', updatedAt: at }
        : record,
    )
  }
  return output
}

function reconcileWorkers(
  state: BraidState,
  sourceSupervisors: readonly SupervisorRecord[],
  observed: readonly WorkerRecord[],
  at: string,
): WorkerRecord[] {
  const existing = new Map(state.workers.map((record) => [String(record.id), record] as const))
  const output = observed.map((record) => mergeWorker(existing.get(String(record.id)), record))
  const observedIds = new Set(output.map((record) => String(record.id)))
  const sourceSupervisorIds = new Set(sourceSupervisors.map((record) => String(record.id)))
  for (const record of state.workers) {
    if (
      !sourceSupervisorIds.has(String(record.supervisorId)) ||
      observedIds.has(String(record.id))
    ) {
      continue
    }
    output.push(
      record.status === 'pending' || record.status === 'running' || record.status === 'waiting'
        ? { ...record, status: 'unknown', updatedAt: at }
        : record,
    )
  }
  return output
}

function reconciledGraphNodes(
  state: BraidState,
  observed: readonly GraphNodeRecord[],
  supervisors: readonly SupervisorRecord[],
  workers: readonly WorkerRecord[],
): GraphNodeRecord[] {
  const existing = new Map(state.graphNodes.map((record) => [String(record.id), record] as const))
  const observedById = new Map(observed.map((record) => [String(record.id), record] as const))
  const records: GraphNodeRecord[] = []
  for (const record of supervisors) {
    const projected = graphNode(
      { kind: 'supervisor', id: record.id },
      record.createdAt,
      `supervisor ${record.id}`,
    )
    const source = observedById.get(String(projected.id)) ?? existing.get(String(projected.id))
    records.push({
      ...(source ?? projected),
      status: record.status,
      createdAt: source?.createdAt ?? projected.createdAt,
      updatedAt: record.updatedAt,
    })
  }
  for (const record of workers) {
    const projected = graphNode(
      { kind: 'worker', id: record.id },
      record.createdAt,
      record.title ?? `worker ${record.id}`,
    )
    const source = observedById.get(String(projected.id)) ?? existing.get(String(projected.id))
    records.push({
      ...(source ?? projected),
      status: record.status,
      createdAt: source?.createdAt ?? projected.createdAt,
      updatedAt: record.updatedAt,
    })
  }
  return records
}

export async function commitSupervisorProjection(
  host: AnalysisApplicationHost,
  input: SupervisorSnapshotRequest,
  raw: TopSnapshot,
): Promise<SupervisorProjection> {
  const state = host.currentState()
  assertRunBindingsExist(state, input.bindings)
  const observed = projectSnapshot(input, raw)
  const at = snapshotTime(input, raw)
  const supervisors = reconcileSupervisors(state, input, observed.supervisors, at)
  const workers = reconcileWorkers(state, supervisors, observed.workers, at)
  const graphNodes = reconciledGraphNodes(state, observed.graphNodes, supervisors, workers)
  const existingSupervisors = new Map(
    state.supervisors.map((record) => [String(record.id), record] as const),
  )
  const existingWorkers = new Map(
    state.workers.map((record) => [String(record.id), record] as const),
  )
  const existingNodes = new Map(
    state.graphNodes.map((record) => [String(record.id), record] as const),
  )
  const existingEdges = new Map(
    state.graphEdges.map((record) => [String(record.id), record] as const),
  )
  const projection = {
    raw,
    supervisors,
    workers,
    graphNodes,
    graphEdges: observed.graphEdges,
  }

  for (const supervisor of supervisors) {
    const existing = existingSupervisors.get(String(supervisor.id))
    if (existing !== undefined && sameObservation(existing, supervisor)) continue
    await host.commit({ kind: 'supervisor.upserted', supervisor })
  }
  for (const worker of workers) {
    const existing = existingWorkers.get(String(worker.id))
    if (existing !== undefined && sameObservation(existing, worker)) continue
    await host.commit({ kind: 'worker.upserted', worker })
  }
  for (const node of graphNodes) {
    const existing = existingNodes.get(String(node.id))
    if (existing !== undefined && sameObservation(existing, node)) continue
    await host.commit({ kind: 'graph.node.upserted', node })
  }
  for (const edge of observed.graphEdges) {
    const existing = existingEdges.get(String(edge.id))
    if (existing !== undefined && sameObservation(existing, edge)) continue
    await host.commit({ kind: 'graph.edge.upserted', edge })
  }
  return projection
}

function sameObservation(left: object, right: object): boolean {
  return (
    canonicalDigest(withoutObservationTime(left)) === canonicalDigest(withoutObservationTime(right))
  )
}

function withoutObservationTime(value: object): Readonly<Record<string, unknown>> {
  const { updatedAt: _updatedAt, ...stable } = value as Readonly<Record<string, unknown>>
  if (stable.status === 'running' && 'latencyMs' in stable) {
    const { latencyMs: _latencyMs, ...withoutLiveLatency } = stable
    return withoutLiveLatency
  }
  return stable
}
