import type {
  RuntimeSupervisorController,
  SupervisorCancelResult,
  SupervisorWorkerCancelResult,
  SupervisorWorkerSteerResult,
} from '../adapters/runtime/supervisor-control.js'
import type {
  RuntimeSupervisorSnapshotPort,
  SupervisorWatchOptions,
  TopSnapshot,
} from '../adapters/runtime/supervisor-watch.js'
import { canonicalDigest } from '../domain/canonical.js'
import type { SupervisorRecord, WorkerRecord } from '../domain/entities.js'
import { graphEdge, graphNode } from '../domain/graph-records.js'
import type { RunId, SupervisorId, WorkerId } from '../domain/ids.js'
import { createSupervisorId, createWorkerId } from '../domain/ids-values.js'
import { redactSensitiveText } from '../domain/redaction.js'
import type { AnalysisApplicationHost } from './analysis-types.js'

export interface SupervisorSnapshotRequest {
  readonly rootDir: string
  readonly rootRunId: RunId
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
  readonly graphNodes: readonly ReturnType<typeof graphNode>[]
  readonly graphEdges: readonly ReturnType<typeof graphEdge>[]
}

function validIso(value: string | undefined, fallback: string): string {
  if (value !== undefined && Number.isFinite(Date.parse(value))) return value
  return fallback
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

function supervisorId(rawId: string): SupervisorId {
  return createSupervisorId(`supervisor-runtime-${canonicalDigest(rawId).slice(0, 40)}`)
}

function workerId(supervisor: SupervisorId, rawId: string): WorkerId {
  return createWorkerId(`worker-runtime-${canonicalDigest({ supervisor, rawId }).slice(0, 40)}`)
}

function finite(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) || value < 0 ? undefined : value
}

function projectSnapshot(input: SupervisorSnapshotRequest, raw: TopSnapshot): SupervisorProjection {
  const at = input.now ?? new Date(raw.generatedAt).toISOString()
  const supervisors: SupervisorRecord[] = []
  const workers: WorkerRecord[] = []
  const graphNodes: ReturnType<typeof graphNode>[] = []
  const graphEdges: ReturnType<typeof graphEdge>[] = []

  for (const view of raw.supervisors) {
    const id = supervisorId(view.id)
    const createdAt = validIso(view.startedAt, at)
    supervisors.push({
      id,
      rootRunId: input.rootRunId,
      status: supervisorStatus(view.status),
      createdAt,
      updatedAt: validIso(view.completedAt, at),
    })
    const supervisorReference = { kind: 'supervisor' as const, id }
    const supervisorNode = graphNode(supervisorReference, createdAt, view.task)
    graphNodes.push({ ...supervisorNode, status: supervisorStatus(view.status) })

    const rawToDomain = new Map<string, WorkerId>()
    for (const worker of view.workers) rawToDomain.set(worker.id, workerId(id, worker.id))
    for (const worker of view.workers) rawToDomain.set(worker.label, workerId(id, worker.id))
    for (const worker of view.workers) {
      const workerDomainId = rawToDomain.get(worker.id)
      if (workerDomainId === undefined) continue
      const createdWorkerAt = validIso(worker.startedAt, createdAt)
      const parentWorkerId =
        worker.parent === undefined ? undefined : rawToDomain.get(worker.parent)
      const logTail = redactSensitiveText(worker.liveTail.join('\n'))
      workers.push({
        id: workerDomainId,
        supervisorId: id,
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
        ...(logTail.length === 0 ? {} : { logTail }),
        title: worker.label,
        createdAt: createdWorkerAt,
        updatedAt: validIso(worker.endedAt, at),
      })
      const workerReference = { kind: 'worker' as const, id: workerDomainId }
      const workerNode = graphNode(workerReference, createdWorkerAt, worker.label)
      graphNodes.push({ ...workerNode, status: workerStatus(worker.status) })
      graphEdges.push(
        graphEdge({
          kind: 'spawned',
          source: supervisorReference,
          destination: workerReference,
          at: createdWorkerAt,
        }),
      )
      if (parentWorkerId !== undefined) {
        graphEdges.push(
          graphEdge({
            kind: 'spawned',
            source: { kind: 'worker', id: parentWorkerId },
            destination: workerReference,
            at: createdWorkerAt,
          }),
        )
      }
    }
  }

  return { raw, supervisors, workers, graphNodes, graphEdges }
}

async function commitProjection(
  host: AnalysisApplicationHost,
  input: SupervisorSnapshotRequest,
  raw: TopSnapshot,
): Promise<SupervisorProjection> {
  const projection = projectSnapshot(input, raw)
  for (const supervisor of projection.supervisors) {
    await host.commit({ kind: 'supervisor.upserted', supervisor })
  }
  for (const worker of projection.workers) await host.commit({ kind: 'worker.upserted', worker })
  for (const node of projection.graphNodes) await host.commit({ kind: 'graph.node.upserted', node })
  for (const edge of projection.graphEdges) await host.commit({ kind: 'graph.edge.upserted', edge })
  return projection
}

export class SupervisorService {
  readonly #host: AnalysisApplicationHost
  #watcher: RuntimeSupervisorSnapshotPort | undefined
  #controller: RuntimeSupervisorController | undefined
  #watcherLoad: Promise<RuntimeSupervisorSnapshotPort> | undefined
  #controllerLoad: Promise<RuntimeSupervisorController> | undefined

  constructor(
    host: AnalysisApplicationHost,
    options: {
      readonly watcher?: RuntimeSupervisorSnapshotPort
      readonly controller?: RuntimeSupervisorController
    } = {},
  ) {
    this.#host = host
    this.#watcher = options.watcher
    this.#controller = options.controller
  }

  async snapshot(input: SupervisorSnapshotRequest): Promise<SupervisorProjection> {
    const watcher = await this.#loadWatcher()
    const raw = watcher.snapshot(input.rootDir)
    return commitProjection(this.#host, input, raw)
  }

  async reconnect(input: SupervisorSnapshotRequest): Promise<SupervisorProjection> {
    const watcher = await this.#loadWatcher()
    const raw = watcher.reconnect(input.rootDir)
    return commitProjection(this.#host, input, raw)
  }

  async *watch(input: SupervisorWatchRequest): AsyncGenerator<SupervisorProjection, void, void> {
    const watcher = await this.#loadWatcher()
    const options: SupervisorWatchOptions = {
      ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }
    for await (const raw of watcher.watch(input.rootDir, options)) {
      yield await commitProjection(this.#host, input, raw)
    }
  }

  async steerWorker(
    rootDir: string,
    supervisorId: string,
    workerIdOrLabel: string,
    message: string,
    source?: string,
  ): Promise<SupervisorWorkerSteerResult> {
    const controller = await this.#loadController()
    return controller.steerWorker(rootDir, supervisorId, workerIdOrLabel, message, source)
  }

  async cancelWorker(worker: string): Promise<SupervisorWorkerCancelResult> {
    const controller = await this.#loadController()
    return controller.cancelWorker(worker)
  }

  async cancelSupervisor(reason?: string): Promise<SupervisorCancelResult> {
    const controller = await this.#loadController()
    return controller.cancelSupervisor(reason)
  }

  #loadWatcher(): Promise<RuntimeSupervisorSnapshotPort> {
    if (this.#watcher !== undefined) return Promise.resolve(this.#watcher)
    if (this.#watcherLoad !== undefined) return this.#watcherLoad
    this.#watcherLoad = import('../adapters/runtime/supervisor-watch.js').then(
      ({ RuntimeSupervisorWatcher }) => {
        const watcher = new RuntimeSupervisorWatcher()
        this.#watcher = watcher
        return watcher
      },
    )
    return this.#watcherLoad
  }

  #loadController(): Promise<RuntimeSupervisorController> {
    if (this.#controller !== undefined) return Promise.resolve(this.#controller)
    if (this.#controllerLoad !== undefined) return this.#controllerLoad
    this.#controllerLoad = Promise.all([
      this.#loadWatcher(),
      import('../adapters/runtime/supervisor-control.js'),
    ]).then(([watcher, { RuntimeSupervisorController }]) => {
      const controller = new RuntimeSupervisorController({ watcher })
      this.#controller = controller
      return controller
    })
    return this.#controllerLoad
  }
}

export type { SupervisorCancelResult, SupervisorWorkerCancelResult, SupervisorWorkerSteerResult }
