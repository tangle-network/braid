import assert from 'node:assert/strict'
import test from 'node:test'

import { cancelRun as realCancelRun } from '@tangle-network/agent-runtime/kernel'

import { RuntimeSupervisorController } from '../src/adapters/runtime/supervisor-control.js'
import type {
  RuntimeSupervisorSnapshotPort,
  SupervisorView,
  TopSnapshot,
} from '../src/adapters/runtime/supervisor-watch.js'

const supervisor = {
  id: 'sup-1',
  stateDir: '/tmp/unused-state-dir',
  workers: [],
} as unknown as SupervisorView

function controllerWith(observed: { cancelRunOptions?: Record<string, unknown> } = {}) {
  return new RuntimeSupervisorController({
    watcher: {
      snapshot: ((_rootDir: string, _now?: number) =>
        ({
          root: '/root',
          generatedAt: 0,
          supervisors: [supervisor],
          completeness: 'complete',
          issues: [],
        }) as unknown as TopSnapshot) as unknown as RuntimeSupervisorSnapshotPort['snapshot'],
      watch: () => (async function* () {})(),
    },
    cancelRun: (_stateDir, _operationId, options = {}) => {
      observed.cancelRunOptions = { ...options }
      return {
        operationId: _operationId,
        effect: 'cancelled',
        requestedAt: '2026-10-30T00:00:00.000Z',
        observedAt: '2026-10-30T00:00:00.000Z',
      }
    },
  })
}

test('a supervisor cancel names its operator so the runtime accepts the request', () => {
  const observed: { cancelRunOptions?: Record<string, unknown> } = {}
  const controller = controllerWith(observed)
  const result = controller.cancelSupervisor(
    '/root',
    'sup-1',
    'op-cancel-1',
    'cancelled by user',
    'braid',
  )
  assert.equal(result.status, 'acknowledged')
  assert.ok(observed.cancelRunOptions)
  assert.equal(observed.cancelRunOptions.reason, 'cancelled by user')
  assert.equal(observed.cancelRunOptions.source, 'braid')
  assert.equal(
    observed.cancelRunOptions.operator,
    'braid.user',
    'the runtime rejects new cancelRun requests without a named operator',
  )
})

test('an explicit operator from the caller reaches the runtime request', () => {
  const observed: { cancelRunOptions?: Record<string, unknown> } = {}
  controllerWith(observed).cancelSupervisor(
    '/root',
    'sup-1',
    'op-cancel-2',
    'automation stop',
    'braid.automation',
    'braid.automation',
  )
  assert.equal(observed.cancelRunOptions?.operator, 'braid.automation')
})

test('the default operator satisfies the real runtime cancelRun contract', () => {
  const observed: { cancelRunOptions?: Record<string, unknown> } = {}
  controllerWith(observed).cancelSupervisor('/root', 'sup-1', 'op-cancel-3')
  const operator = observed.cancelRunOptions?.operator
  assert.equal(typeof operator, 'string')
  assert.notEqual((operator as string).trim(), '')
  // The shipped runtime must still be the kind that requires an operator: this
  // call against an absent event dir must fail, never silently accept.
  assert.throws(() => realCancelRun('/tmp/braid-no-such-state-dir', 'op-x', {}))
})
