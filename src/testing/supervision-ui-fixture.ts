import { RuntimeSupervisorController } from '../adapters/runtime/supervisor-control.js'
import { RuntimeSupervisorWatcher } from '../adapters/runtime/supervisor-watch.js'
import type { IntelligenceActionsOptions } from '../app/intelligence-actions.js'
import { createSupervisionSnapshot } from './supervision-fixture.js'

const FIXTURE_TIME = Date.parse('2026-08-28T20:00:00.000Z')

/** Compose the normal Runtime projection path with stable data for terminal captures. */
export function createSupervisionUiFixture(): IntelligenceActionsOptions {
  const watcher = new RuntimeSupervisorWatcher((rootDir) =>
    createSupervisionSnapshot({
      root: rootDir,
      generatedAt: FIXTURE_TIME,
      supervisors: [
        {
          id: 'runtime-supervisor-release',
          status: 'running',
          task: 'prove the Braid release',
          budget: 3,
          workers: [
            {
              id: 'runtime-worker-stream',
              label: 'stream and replay',
              latencyMs: 1_840,
              spend: {
                iterations: 1,
                tokensInput: 1_104,
                tokensOutput: 736,
                usd: 0.021,
                ms: 1_840,
              },
              liveTail: ['stream and replay: working'],
            },
            {
              id: 'runtime-worker-ui',
              label: 'terminal proof',
              latencyMs: 2_310,
              spend: {
                iterations: 2,
                tokensInput: 1_386,
                tokensOutput: 924,
                usd: 0.028,
                ms: 2_310,
              },
              liveTail: ['terminal proof: working'],
            },
            {
              id: 'runtime-worker-review',
              label: 'release review',
              parent: 'terminal proof',
              latencyMs: 940,
              spend: { iterations: 3, tokensInput: 564, tokensOutput: 376, usd: 0.012, ms: 940 },
              liveTail: ['release review: working'],
            },
          ],
          driverSpend: {
            iterations: 3,
            tokensInput: 3_054,
            tokensOutput: 2_036,
            usd: 0.061,
            ms: 5_090,
          },
        },
      ],
    }),
  )
  return {
    supervisorWatcher: watcher,
    supervisorController: new RuntimeSupervisorController({ watcher }),
  }
}
