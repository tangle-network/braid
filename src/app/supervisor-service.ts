import type { RemoteSupervisorWatcher } from '../adapters/runtime/remote-supervisor.js'
import type {
  RuntimeSupervisorController,
  SupervisorCancelResult,
  SupervisorWorkerAttachResult,
  SupervisorWorkerCancelResult,
  SupervisorWorkerSteerResult,
} from '../adapters/runtime/supervisor-control.js'
import type {
  RuntimeSupervisorSnapshotPort,
  SupervisorWatchOptions,
  TopSnapshot,
} from '../adapters/runtime/supervisor-watch.js'
import type { AnalysisApplicationHost } from './analysis-types.js'
import { commitRemoteSupervisorProjection } from './remote-supervisor-projection.js'
import {
  commitSupervisorProjection,
  type SupervisionRecords,
  type SupervisorProjection,
  type SupervisorSnapshotRequest,
  type SupervisorWatchRequest,
} from './supervisor-projection.js'

export class SupervisorService {
  readonly #host: AnalysisApplicationHost
  #watcher: RuntimeSupervisorSnapshotPort | undefined
  #controller: RuntimeSupervisorController | undefined
  #watcherLoad: Promise<RuntimeSupervisorSnapshotPort> | undefined
  #controllerLoad: Promise<RuntimeSupervisorController> | undefined
  #projectionQueue: Promise<void> = Promise.resolve()
  #remote: RemoteSupervisorWatcher | undefined
  #activeRemote:
    | { readonly rootDir: string; readonly conversationId: string; readonly endpointEnv: string }
    | undefined

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

  async snapshot(input: SupervisorSnapshotRequest): Promise<SupervisionRecords> {
    const remote = this.#remoteEndpoint(input)
    if (remote !== undefined) return this.#remoteSnapshot(input, remote)
    const watcher = await this.#loadWatcher()
    const raw =
      input.runDir === undefined
        ? watcher.snapshot(input.rootDir)
        : await watcher.snapshot(input.rootDir, { runDir: input.runDir })
    return this.#commit(input, raw)
  }

  reconnect(input: SupervisorSnapshotRequest): Promise<SupervisionRecords> {
    return this.snapshot(input)
  }

  #remoteEndpoint(input: SupervisorSnapshotRequest): string | undefined {
    if (input.runDir !== undefined) {
      if (input.remoteEndpointEnv !== undefined)
        throw new Error('A durable runDir cannot be combined with a remote endpoint')
      return undefined
    }
    const state = this.#host.currentState()
    const selected = state.workers.find((worker) => String(worker.id) === input.workerId)
    const owner =
      selected === undefined
        ? undefined
        : state.supervisors.find((record) => record.id === selected.supervisorId)
    const selectedEndpoint =
      owner?.conversationId === state.conversationId && owner?.runtimeRoot === input.rootDir
        ? owner.remoteEndpointEnv
        : undefined
    const active = this.#activeRemote
    return (
      input.remoteEndpointEnv ??
      selectedEndpoint ??
      (active?.rootDir === input.rootDir && active.conversationId === state.conversationId
        ? active.endpointEnv
        : undefined) ??
      state.supervisors.find(
        (record) =>
          record.runtimeRoot === input.rootDir &&
          record.conversationId === state.conversationId &&
          record.remoteEndpointEnv !== undefined,
      )?.remoteEndpointEnv
    )
  }

  async #remoteSnapshot(
    input: SupervisorSnapshotRequest,
    remoteEndpointEnv: string,
  ): Promise<SupervisionRecords> {
    const state = this.#host.currentState()
    const conversationId = state.conversationId
    if (conversationId === null)
      throw new Error('Open a conversation before reading a remote Runtime tree')
    const selected = state.workers.find((worker) => String(worker.id) === input.workerId)
    const owner =
      selected === undefined
        ? undefined
        : state.supervisors.find((record) => record.id === selected.supervisorId)
    const workerId =
      owner?.remoteEndpointEnv === remoteEndpointEnv && owner.conversationId === conversationId
        ? selected?.runtimeId
        : undefined
    const run = this.#projectionQueue.then(async () => {
      if (this.#remote === undefined) {
        const { RemoteSupervisorWatcher } = await import('../adapters/runtime/remote-supervisor.js')
        this.#remote = new RemoteSupervisorWatcher()
      }
      const observation = await this.#remote.snapshot(remoteEndpointEnv, workerId)
      if (this.#host.currentState().conversationId !== conversationId)
        throw new Error('The conversation changed during the remote read; open its graph again')
      const projection = await commitRemoteSupervisorProjection(
        this.#host,
        { ...input, remoteEndpointEnv },
        observation,
      )
      this.#activeRemote = {
        rootDir: input.rootDir,
        conversationId,
        endpointEnv: remoteEndpointEnv,
      }
      return projection
    })
    this.#projectionQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async *watch(input: SupervisorWatchRequest): AsyncGenerator<SupervisorProjection, void, void> {
    if (input.runDir !== undefined) this.#remoteEndpoint(input)
    const watcher = await this.#loadWatcher()
    const options: SupervisorWatchOptions = {
      ...(input.runDir === undefined ? {} : { runDir: input.runDir }),
      ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }
    for await (const raw of watcher.watch(input.rootDir, options)) {
      yield await this.#commit(input, raw)
    }
  }

  #commit(input: SupervisorSnapshotRequest, raw: TopSnapshot): Promise<SupervisorProjection> {
    const result = this.#projectionQueue.then(() =>
      commitSupervisorProjection(this.#host, input, raw),
    )
    this.#projectionQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async steerWorker(
    rootDir: string,
    supervisorId: string,
    workerId: string,
    operationId: string,
    message: string,
    source?: string,
    interrupt?: boolean,
  ): Promise<SupervisorWorkerSteerResult> {
    const controller = await this.#loadController()
    return controller.steerWorker(
      rootDir,
      supervisorId,
      workerId,
      operationId,
      message,
      source,
      interrupt,
    )
  }

  async cancelWorker(
    rootDir: string,
    supervisorId: string,
    workerId: string,
    operationId: string,
    reason?: string,
    source?: string,
  ): Promise<SupervisorWorkerCancelResult> {
    const controller = await this.#loadController()
    return controller.cancelWorker(rootDir, supervisorId, workerId, operationId, reason, source)
  }

  async cancelSupervisor(
    rootDir: string,
    supervisorId: string,
    operationId: string,
    reason?: string,
    source?: string,
  ): Promise<SupervisorCancelResult> {
    const controller = await this.#loadController()
    return controller.cancelSupervisor(rootDir, supervisorId, operationId, reason, source)
  }

  async attachWorker(
    rootDir: string,
    supervisorId: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<SupervisorWorkerAttachResult> {
    const controller = await this.#loadController()
    return controller.attachWorker(rootDir, supervisorId, workerId, signal)
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

export type {
  SupervisorProjection,
  SupervisorRunBinding,
  SupervisorSnapshotRequest,
  SupervisorWatchRequest,
} from './supervisor-projection.js'
export type {
  SupervisorCancelResult,
  SupervisorWorkerAttachResult,
  SupervisorWorkerCancelResult,
  SupervisorWorkerSteerResult,
}
