import type {
  SupervisorView,
  TopSnapshot,
  WorkerView,
} from '../adapters/runtime/supervisor-watch.js'

const DEFAULT_ROOT = '/workspace'
const DEFAULT_GENERATED_AT = Date.parse('2026-08-03T20:00:00.000Z')

type SupervisorMetadata = Partial<
  Omit<
    SupervisorView,
    | 'id'
    | 'status'
    | 'task'
    | 'workspaceDir'
    | 'budget'
    | 'stateDir'
    | 'workers'
    | 'progressTail'
    | 'journalTail'
    | 'driverSpend'
    | 'totals'
  >
>

type WorkerMetadata = Partial<
  Omit<WorkerView, 'id' | 'label' | 'status' | 'latencyMs' | 'spend' | 'metered' | 'liveTail'>
>

type SupervisorTotals = SupervisorView['totals']

export type SupervisionSpendOptions = Partial<WorkerView['spend']>

export type SupervisionWorkerOptions = Pick<WorkerView, 'id' | 'label'> &
  WorkerMetadata & {
    readonly status?: WorkerView['status']
    readonly latencyMs?: number
    readonly spend?: SupervisionSpendOptions
    readonly metered?: SupervisionSpendOptions
    readonly liveTail?: readonly string[]
  }

export type SupervisionSupervisorOptions = SupervisorMetadata & {
  readonly id?: string
  readonly status?: string
  readonly task?: string
  readonly workspaceDir?: string
  readonly budget?: number
  readonly stateDir?: string
  readonly workers?: readonly SupervisionWorkerOptions[]
  readonly progressTail?: readonly string[]
  readonly journalTail?: ReadonlyArray<SupervisorView['journalTail'][number]>
  readonly driverSpend?: SupervisionSpendOptions
}

export interface SupervisionSnapshotOptions {
  readonly root?: string
  readonly generatedAt?: number
  readonly supervisors?: readonly SupervisionSupervisorOptions[]
}

const DEFAULT_SPEND: WorkerView['spend'] = {
  iterations: 1,
  tokensInput: 2,
  tokensOutput: 3,
  usd: 0.01,
  ms: 4,
}

function freeze<T>(value: T): T {
  Object.freeze(value)
  return value
}

function spendStats(
  options: SupervisionSpendOptions = {},
  fallback: WorkerView['spend'] = DEFAULT_SPEND,
): WorkerView['spend'] {
  return freeze({
    iterations: options.iterations ?? fallback.iterations,
    tokensInput: options.tokensInput ?? fallback.tokensInput,
    tokensOutput: options.tokensOutput ?? fallback.tokensOutput,
    usd: options.usd ?? fallback.usd,
    ms: options.ms ?? fallback.ms,
  })
}

function workerView(input: SupervisionWorkerOptions): WorkerView {
  const {
    id,
    label,
    status = 'running',
    latencyMs = 4,
    spend,
    metered,
    liveTail = [`${label} progress`],
    ...metadata
  } = input
  const measured = spendStats(spend)
  return freeze({
    ...metadata,
    id,
    label,
    status,
    latencyMs,
    spend: measured,
    metered: spendStats(metered, measured),
    liveTail: freeze([...liveTail]),
  })
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6))
}

function sumWorkers(workers: readonly WorkerView[]): SupervisorTotals {
  const latencies = workers.map((worker) => worker.latencyMs).sort((a, b) => a - b)
  const running = workers.filter((worker) => worker.status === 'running').length
  const done = workers.filter((worker) => worker.status === 'done').length
  const down = workers.filter((worker) => worker.status === 'down').length
  const cancelled = workers.filter((worker) => worker.status === 'cancelled').length
  const metered = workers.reduce(
    (total, worker) => ({
      iterations: total.iterations + worker.metered.iterations,
      tokensInput: total.tokensInput + worker.metered.tokensInput,
      tokensOutput: total.tokensOutput + worker.metered.tokensOutput,
      usd: total.usd + worker.metered.usd,
      ms: total.ms + worker.metered.ms,
    }),
    { iterations: 0, tokensInput: 0, tokensOutput: 0, usd: 0, ms: 0 },
  )

  return freeze({
    workers: workers.length,
    running,
    done,
    down,
    cancelled,
    inFlight: running,
    settled: done + down + cancelled,
    tokensInput: metered.tokensInput,
    tokensOutput: metered.tokensOutput,
    tokensTotal: metered.tokensInput + metered.tokensOutput,
    usd: roundUsd(metered.usd),
    latencyMs: metered.ms,
    workerLatency: freeze({
      n: latencies.length,
      min: latencies[0] ?? 0,
      median:
        latencies.length === 0
          ? 0
          : latencies.length % 2 === 0
            ? ((latencies[latencies.length / 2 - 1] ?? 0) +
                (latencies[latencies.length / 2] ?? 0)) /
              2
            : (latencies[Math.floor(latencies.length / 2)] ?? 0),
      p90: latencies.length === 0 ? 0 : (latencies[Math.ceil(latencies.length * 0.9) - 1] ?? 0),
      max: latencies.at(-1) ?? 0,
    }),
  })
}

function supervisorView(
  root: string,
  input: SupervisionSupervisorOptions,
  index: number,
): SupervisorView {
  const {
    id = index === 0 ? 'runtime-supervisor-live' : `runtime-supervisor-${index + 1}`,
    status,
    task = 'build Braid',
    workspaceDir = root,
    budget = 1,
    stateDir = `${root}/.agent`,
    workers = [],
    progressTail = [],
    journalTail = [],
    driverSpend,
    ...metadata
  } = input
  const workerViews = workers.map(workerView)
  return freeze({
    ...metadata,
    id,
    status:
      status ??
      (workerViews.some((worker) => worker.status === 'running') ? 'running' : 'completed'),
    task,
    workspaceDir,
    budget,
    stateDir,
    workers: freeze(workerViews),
    progressTail: freeze([...progressTail]),
    journalTail: freeze([...journalTail]),
    driverSpend: spendStats(driverSpend),
    totals: sumWorkers(workerViews),
  })
}

/** Build a complete immutable Runtime supervisor view for deterministic tests and captures. */
export function createSupervisionSnapshot(options: SupervisionSnapshotOptions = {}): TopSnapshot {
  const root = options.root ?? DEFAULT_ROOT
  const supervisorOptions = options.supervisors ?? [{}]
  const supervisors = supervisorOptions.map((supervisor, index) =>
    supervisorView(root, supervisor, index),
  )
  return freeze({
    root,
    generatedAt: options.generatedAt ?? DEFAULT_GENERATED_AT,
    supervisors: freeze(supervisors),
    completeness: 'complete',
    diagnostics: freeze([]),
    discovered: supervisors.length,
    loaded: supervisors.length,
  })
}
