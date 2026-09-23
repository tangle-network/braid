import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  WorkerSteerAcknowledgement,
  WorkerSteerRequest,
  WorkerInteractiveProviderSource,
} from '@tangle-network/agent-runtime/kernel'
import type { RetainedInteractiveRunHandle } from '@tangle-network/agent-runtime/kernel'
import {
  RuntimeSupervisorController,
  type SupervisorWorkerProviderSource,
} from '../src/adapters/runtime/supervisor-control.js'
import {
  RuntimeSupervisorWatcher,
  type TopSnapshot,
} from '../src/adapters/runtime/supervisor-watch.js'

const NOW = '2026-08-28T00:00:00.000Z'

type SupervisorWrite = Exclude<
  NonNullable<ConstructorParameters<typeof RuntimeSupervisorController>[0]>['write'],
  undefined
>

function snapshot(): TopSnapshot {
  return {
    root: '/workspace',
    generatedAt: Date.parse(NOW),
    supervisors: [
      {
        id: 'runtime-supervisor',
        status: 'running',
        task: 'test worker controls',
        workspaceDir: '/workspace',
        budget: 1,
        stateDir: '/workspace/.agent',
        workers: [
          {
            id: 'runtime-worker',
            label: 'worker',
            status: 'running',
            latencyMs: 1,
            spend: { iterations: 1, tokensInput: 1, tokensOutput: 1, usd: 0, ms: 1 },
            metered: { iterations: 1, tokensInput: 1, tokensOutput: 1, usd: 0, ms: 1 },
            liveTail: [],
          },
        ],
        progressTail: [],
        journalTail: [],
        driverSpend: { iterations: 1, tokensInput: 1, tokensOutput: 1, usd: 0, ms: 1 },
        totals: {
          workers: 1,
          running: 1,
          done: 0,
          down: 0,
          cancelled: 0,
          inFlight: 1,
          settled: 0,
          tokensInput: 1,
          tokensOutput: 1,
          tokensTotal: 2,
          usd: 0,
          latencyMs: 1,
          workerLatency: { n: 1, min: 1, median: 1, p90: 1, max: 1 },
        },
      },
    ],
  } as unknown as TopSnapshot
}

function requestFor(
  worker: string,
  options: { readonly operationId: string; readonly message: string; readonly source?: string },
): WorkerSteerRequest {
  return {
    schemaVersion: 1,
    operationId: options.operationId,
    requestDigest: `sha256:${'1'.repeat(64)}` as WorkerSteerRequest['requestDigest'],
    at: NOW,
    source: options.source ?? 'braid',
    worker,
    message: options.message,
    interrupt: true,
  }
}

function acknowledgementFor(request: WorkerSteerRequest): WorkerSteerAcknowledgement {
  return {
    schemaVersion: 1,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    worker: request.worker,
    effect: 'delivered',
    requestedAt: request.at,
    observedAt: NOW,
    detail: 'worker received the steer',
  }
}

test('steer forwards one caller operation id across retries and preserves exact acknowledgement', () => {
  const writes: Array<{
    readonly worker: string
    readonly operationId: string
    readonly message: string
  }> = []
  const requests = new Map<string, WorkerSteerRequest>()
  const watcher = new RuntimeSupervisorWatcher(() => snapshot())
  const controller = new RuntimeSupervisorController({
    watcher,
    write: (_rootDir, _supervisorId, worker, options) => {
      const request = requestFor(worker, options)
      const prior = requests.get(options.operationId)
      if (prior !== undefined && prior.message !== request.message) {
        throw new Error(`operation '${options.operationId}' conflicts with its admitted request`)
      }
      writes.push({ worker, operationId: options.operationId, message: options.message })
      requests.set(options.operationId, request)
      return {
        worker,
        file: `/workspace/.agent/steers/${options.operationId}.json`,
        request,
        ...(prior === undefined ? {} : { acknowledgement: acknowledgementFor(prior) }),
        replayed: prior !== undefined,
      }
    },
  })

  const first = controller.steerWorker(
    '/workspace',
    'runtime-supervisor',
    'worker',
    'inspect the failing test',
    'operation-steer-1',
  )
  assert.equal(first.status, 'queued')
  assert.equal(first.operationId, 'operation-steer-1')
  assert.equal(first.replayed, false)

  const restarted = new RuntimeSupervisorController({
    watcher,
    write: controllerWriteWithSharedRequests(requests, writes),
  })
  const replay = restarted.steerWorker(
    '/workspace',
    'runtime-supervisor',
    'runtime-worker',
    'inspect the failing test',
    'operation-steer-1',
  )
  assert.equal(replay.status, 'acknowledged')
  assert.equal(replay.effect, 'delivered')
  assert.equal(replay.detail, 'worker received the steer')
  assert.equal(replay.replayed, true)
  assert.deepEqual(writes, [
    { worker: 'runtime-worker', operationId: 'operation-steer-1', message: 'inspect the failing test' },
    { worker: 'runtime-worker', operationId: 'operation-steer-1', message: 'inspect the failing test' },
  ])

  assert.throws(
    () =>
      restarted.steerWorker(
        '/workspace',
        'runtime-supervisor',
        'runtime-worker',
        'change the admitted operation',
        'operation-steer-1',
      ),
    /conflicts with its admitted request/u,
  )
})

function controllerWriteWithSharedRequests(
  requests: Map<string, WorkerSteerRequest>,
  writes: Array<{
    readonly worker: string
    readonly operationId: string
    readonly message: string
  }>,
): SupervisorWrite {
  return (_rootDir, _supervisorId, worker, options) => {
    const request = requestFor(worker, options)
    const prior = requests.get(options.operationId)
    if (prior !== undefined && prior.message !== request.message) {
      throw new Error(`operation '${options.operationId}' conflicts with its admitted request`)
    }
    writes.push({ worker, operationId: options.operationId, message: options.message })
    requests.set(options.operationId, request)
    return {
      worker,
      file: `/workspace/.agent/steers/${options.operationId}.json`,
      request,
      ...(prior === undefined ? {} : { acknowledgement: acknowledgementFor(prior) }),
      replayed: prior !== undefined,
    }
  }
}

test('attach returns the opaque Runtime handle and preserves named unavailable outcomes', async () => {
  const watcher = new RuntimeSupervisorWatcher(() => snapshot())
  const provider = {} as WorkerInteractiveProviderSource
  const handle = {} as RetainedInteractiveRunHandle
  const calls: string[] = []
  const controller = new RuntimeSupervisorController({
    watcher,
    providers: provider,
    attach: async (eventDir, worker, options) => {
      calls.push(`${eventDir}:${worker}:${options.providers === provider}`)
      return { status: 'available', handle }
    },
  })
  const attached = await controller.attachWorker(
    '/workspace',
    'runtime-supervisor',
    'runtime-worker',
  )
  assert.equal(attached.status, 'attached')
  assert.equal(attached.handle, handle)
  assert.deepEqual(calls, ['/workspace/.agent:runtime-worker:true'])

  const unavailable = new RuntimeSupervisorController({
    watcher,
    providers: provider,
    attach: async () => ({ status: 'unavailable', reason: 'interactive-provider-not-registered' }),
  })
  const result = await unavailable.attachWorker(
    '/workspace',
    'runtime-supervisor',
    'runtime-worker',
  )
  assert.equal(result.status, 'unavailable')
  assert.match(result.issue?.reason ?? '', /interactive-provider-not-registered/u)
})

test('attach fails closed when no provider source is registered', async () => {
  const controller = new RuntimeSupervisorController({
    watcher: new RuntimeSupervisorWatcher(() => snapshot()),
  })
  const result = await controller.attachWorker('/workspace', 'runtime-supervisor', 'runtime-worker')
  assert.equal(result.status, 'unavailable')
  assert.match(result.issue?.reason ?? '', /provider/u)
})
