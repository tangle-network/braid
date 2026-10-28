import {
  loadTopSnapshot,
  type SupervisorView,
  type TopSnapshot,
  type WorkerView,
} from '@tangle-network/agent-runtime/tui'

export interface SupervisorWatchOptions {
  readonly runDir?: string
  readonly intervalMs?: number
  readonly signal?: AbortSignal
  readonly now?: () => number
}

export interface RuntimeSupervisorSnapshotPort {
  snapshot(rootDir: string, now?: number): TopSnapshot
  snapshot(
    rootDir: string,
    options: { readonly runDir: string; readonly now?: number },
  ): Promise<TopSnapshot>
  readonly watch: (
    rootDir: string,
    options?: SupervisorWatchOptions,
  ) => AsyncGenerator<TopSnapshot, void, void>
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

  snapshot(rootDir: string, now?: number): TopSnapshot
  snapshot(
    rootDir: string,
    options: { readonly runDir: string; readonly now?: number },
  ): Promise<TopSnapshot>
  snapshot(
    rootDir: string,
    input?: number | { readonly runDir: string; readonly now?: number },
  ): TopSnapshot | Promise<TopSnapshot> {
    return typeof input === 'object' ? loadTopSnapshot(rootDir, input) : this.#load(rootDir, input)
  }

  async *watch(
    rootDir: string,
    options: SupervisorWatchOptions = {},
  ): AsyncGenerator<TopSnapshot, void, void> {
    const intervalMs = Math.max(25, options.intervalMs ?? 250)
    while (!options.signal?.aborted) {
      const now = options.now?.()
      yield options.runDir === undefined
        ? this.snapshot(rootDir, now)
        : await this.snapshot(rootDir, {
            runDir: options.runDir,
            ...(now === undefined ? {} : { now }),
          })
      if (!(await waitForNextSnapshot(intervalMs, options.signal))) return
    }
  }
}

export type { SupervisorView, TopSnapshot, WorkerView }
