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
import type { AnalysisApplicationHost } from './analysis-types.js'
import {
  commitSupervisorProjection,
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
    return this.#commit(input, raw)
  }

  async reconnect(input: SupervisorSnapshotRequest): Promise<SupervisorProjection> {
    const watcher = await this.#loadWatcher()
    const raw = watcher.reconnect(input.rootDir)
    return this.#commit(input, raw)
  }

  async *watch(input: SupervisorWatchRequest): AsyncGenerator<SupervisorProjection, void, void> {
    const watcher = await this.#loadWatcher()
    const options: SupervisorWatchOptions = {
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
export type {
  SupervisorProjection,
  SupervisorRunBinding,
  SupervisorSnapshotRequest,
  SupervisorWatchRequest,
} from './supervisor-projection.js'
