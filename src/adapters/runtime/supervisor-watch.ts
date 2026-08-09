import {
  loadTopSnapshot,
  type SupervisorView,
  type TopSnapshot,
  type WorkerView,
} from '@tangle-network/agent-runtime/tui'

export interface SupervisorWatchOptions {
  readonly intervalMs?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface RuntimeSupervisorSnapshotPort {
  readonly snapshot: (rootDir: string, now?: number) => TopSnapshot
  readonly watch: (
    rootDir: string,
    options?: SupervisorWatchOptions,
  ) => AsyncGenerator<TopSnapshot, void, void>
  readonly reconnect: (rootDir: string, now?: number) => TopSnapshot
}

function waitForNextSnapshot(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export class RuntimeSupervisorWatcher implements RuntimeSupervisorSnapshotPort {
  readonly #load: (rootDir: string, now?: number) => TopSnapshot

  constructor(load: (rootDir: string, now?: number) => TopSnapshot = loadTopSnapshot) {
    this.#load = load
  }

  snapshot(rootDir: string, now?: number): TopSnapshot {
    return this.#load(rootDir, now)
  }

  reconnect(rootDir: string, now?: number): TopSnapshot {
    return this.snapshot(rootDir, now)
  }

  async *watch(
    rootDir: string,
    options: SupervisorWatchOptions = {},
  ): AsyncGenerator<TopSnapshot, void, void> {
    const intervalMs = Math.max(25, options.intervalMs ?? 250)
    while (!options.signal?.aborted) {
      yield this.snapshot(rootDir, options.now?.())
      if (!(await waitForNextSnapshot(intervalMs, options.signal))) return
    }
  }
}

export type { SupervisorView, TopSnapshot, WorkerView }
