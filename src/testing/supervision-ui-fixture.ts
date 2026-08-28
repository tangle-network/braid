import { RuntimeSupervisorController } from '../adapters/runtime/supervisor-control.js'
import { RuntimeSupervisorWatcher, type TopSnapshot } from '../adapters/runtime/supervisor-watch.js'
import type { IntelligenceActionsOptions } from '../app/intelligence-actions.js'

const FIXTURE_TIME = Date.parse('2026-08-28T20:00:00.000Z')

function supervisionSnapshot(rootDir: string): TopSnapshot {
  return Object.freeze({
    root: rootDir,
    generatedAt: FIXTURE_TIME,
    supervisors: Object.freeze([
      Object.freeze({
        id: 'runtime-supervisor-release',
        status: 'running',
        task: 'prove the Braid release',
        workspaceDir: rootDir,
        budget: 3,
        stateDir: `${rootDir}/.agent`,
        workers: Object.freeze([
          worker('runtime-worker-stream', 'stream and replay', 1, undefined, 1_840, 0.021),
          worker('runtime-worker-ui', 'terminal proof', 2, undefined, 2_310, 0.028),
          worker('runtime-worker-review', 'release review', 3, 'terminal proof', 940, 0.012),
        ]),
        progressTail: Object.freeze([]),
        journalTail: Object.freeze([]),
        driverSpend: spend(3, 5_090, 0.061),
        totals: Object.freeze({
          workers: 3,
          running: 3,
          done: 0,
          down: 0,
          cancelled: 0,
          inFlight: 3,
          settled: 0,
          tokensInput: 3_054,
          tokensOutput: 2_036,
          tokensTotal: 5_090,
          usd: 0.061,
          latencyMs: 5_090,
          workerLatency: Object.freeze({ n: 3, min: 940, median: 1_840, p90: 2_310, max: 2_310 }),
        }),
      }),
    ]),
  }) as unknown as TopSnapshot
}

function spend(iterations: number, tokens: number, usd: number) {
  return Object.freeze({
    iterations,
    tokensInput: Math.ceil(tokens * 0.6),
    tokensOutput: Math.floor(tokens * 0.4),
    usd,
    ms: tokens,
  })
}

function worker(
  id: string,
  label: string,
  iterations: number,
  parent: string | undefined,
  tokens: number,
  usd: number,
) {
  const measured = spend(iterations, tokens, usd)
  return Object.freeze({
    id,
    label,
    status: 'running',
    ...(parent === undefined ? {} : { parent }),
    latencyMs: tokens,
    spend: measured,
    metered: measured,
    liveTail: Object.freeze([`${label}: working`]),
  })
}

/** Compose the normal Runtime projection path with stable data for terminal captures. */
export function createSupervisionUiFixture(): IntelligenceActionsOptions {
  const watcher = new RuntimeSupervisorWatcher((rootDir) => supervisionSnapshot(rootDir))
  return {
    supervisorWatcher: watcher,
    supervisorController: new RuntimeSupervisorController({ watcher }),
  }
}
