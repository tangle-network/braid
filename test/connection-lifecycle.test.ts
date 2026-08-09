import assert from 'node:assert/strict'
import test from 'node:test'
import type { ConnectionCapabilityReport } from '../src/adapters/connections/production-connection-types.js'
import { ConnectionActionService } from '../src/app/connection-actions.js'
import { ConnectionError, ConnectionRemovalError } from '../src/app/connection-errors.js'
import { AppError } from '../src/app/errors.js'
import { createBraidApplication, DETERMINISTIC_PROFILE } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import { connectionRemovalBlockers } from '../src/domain/connection-removal.js'
import type { ConnectionRecord } from '../src/domain/entities.js'
import { DomainInvariantError } from '../src/domain/invariants.js'
import { createConnectionId, createOperationId } from '../src/domain/ids.js'
import { reduceEvent } from '../src/domain/reducer.js'
import type { BraidState } from '../src/domain/state.js'
import { FixedClock } from '../src/ports/clock.js'

const at = '2026-08-09T00:00:00.000Z'

function connection(id: string, name = id): ConnectionRecord {
  return {
    id: createConnectionId(id),
    kind: 'cli-bridge',
    name,
    endpoint: 'http://127.0.0.1:3344',
    providerOptions: { transport: 'local' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

function application(journal: MemoryJournal) {
  return createBraidApplication({
    fixture: 'deterministic',
    profile: DETERMINISTIC_PROFILE,
    clock: new FixedClock(at),
    journal,
    effectStorage: journal,
  })
}

function service(app: ReturnType<typeof application>, connections?: readonly ConnectionRecord[]) {
  return new ConnectionActionService({
    host: {
      state: () => app.state(),
      configuration: app.configuration,
      runtime: app.runtimeSelection,
    },
    ...(connections === undefined ? {} : { connections }),
    now: () => at,
  })
}

function capabilities(connectionId: ConnectionRecord['id']): ConnectionCapabilityReport {
  return {
    connectionId,
    kind: 'cli-bridge',
    runtime: {
      backend: 'chat',
      streaming: { live: true, replay: true, detach: false, turnIdempotency: true },
      sessions: { continue: true, list: false, messages: false },
      interactions: { originate: false, respond: false },
    },
    providerMethods: { create: true, get: false, list: false, respondToInteraction: false },
    actions: {
      stream: true,
      replay: true,
      detach: false,
      'continue-session': true,
      'list-sessions': false,
      'session-messages': false,
      checkpoint: false,
      fork: false,
      placement: true,
      usage: true,
      'respond-interaction': false,
    },
  }
}

test('upsert creates, updates, replays, and rejects operation reuse with different input', async () => {
  const journal = new MemoryJournal(new FixedClock(at))
  const app = application(journal)
  const actions = service(app)
  const record = connection('connection-lifecycle-create', 'created bridge')

  const created = await actions.upsert({
    operationId: 'operation-connection-create',
    record,
  })
  assert.equal(created.replayed, false)
  assert.equal(created.connection.id, record.id)
  assert.equal(app.state().connections[0]?.id, record.id)
  assert.equal(
    app.events().some(({ event }) => event.kind === 'connection.upserted'),
    true,
  )

  const replayed = await actions.upsert({
    operationId: 'operation-connection-create',
    record,
  })
  assert.equal(replayed.replayed, true)
  assert.deepEqual(replayed.connection, created.connection)
  assert.equal(app.state().revision, created.revision)

  await assert.rejects(
    actions.upsert({
      operationId: 'operation-connection-create',
      record: connection('connection-lifecycle-create', 'changed input'),
    }),
    (error: unknown) => error instanceof AppError && error.code === 'OPERATION_ID_CONFLICT',
  )

  const updated = await actions.upsert({
    operationId: 'operation-connection-update',
    record: { ...record, name: 'updated bridge', updatedAt: '2026-08-09T00:01:00.000Z' },
  })
  assert.equal(updated.replayed, false)
  assert.equal(app.state().connections[0]?.name, 'updated bridge')

  const restarted = application(journal)
  const restartReplay = await service(restarted).upsert({
    operationId: 'operation-connection-update',
    record: { ...record, name: 'updated bridge', updatedAt: '2026-08-09T00:01:00.000Z' },
  })
  assert.equal(restartReplay.replayed, true)
  assert.equal(restarted.state().connections[0]?.name, 'updated bridge')
  assert.equal(
    restarted
      .state()
      .operations.some((operation) => operation.id === 'operation-connection-update'),
    true,
  )

  await assert.rejects(
    actions.upsert({
      operationId: 'operation-connection-secret',
      record: { ...record, apiKey: 'must-not-persist' } as ConnectionRecord,
    }),
    (error: unknown) =>
      error instanceof ConnectionError && error.code === 'SECRET_IN_CONNECTION_RECORD',
  )
})

test('list, select, and test retain their local and idempotent behavior', async () => {
  const journal = new MemoryJournal(new FixedClock(at))
  const app = application(journal)
  const record = connection('connection-list-select-test', 'test bridge')
  let healthCalls = 0
  let capabilityCalls = 0
  let modelCalls = 0
  const actions = new ConnectionActionService({
    host: {
      state: () => app.state(),
      configuration: app.configuration,
      runtime: app.runtimeSelection,
    },
    connections: [record],
    probeFor: () => ({
      health: async () => {
        healthCalls += 1
        return { status: 'healthy' as const, checkedAt: at }
      },
      capabilities: async () => {
        capabilityCalls += 1
        return capabilities(record.id)
      },
      verifyModel: async (model) => {
        modelCalls += 1
        return { model, status: 'verified' as const, checkedAt: at }
      },
    }),
    now: () => at,
  })

  const listed = await actions.list()
  assert.equal(listed.connections.length, 1)
  assert.equal(listed.connections[0]?.id, record.id)
  assert.equal(healthCalls, 0)
  assert.equal(capabilityCalls, 0)
  assert.equal(modelCalls, 0)

  const selected = await actions.select({
    operationId: 'operation-connection-select',
    connectionId: record.id,
  })
  assert.equal(selected.replayed, false)
  const selectedReplay = await actions.select({
    operationId: 'operation-connection-select',
    connectionId: record.id,
  })
  assert.equal(selectedReplay.replayed, true)

  const tested = await actions.test({
    operationId: 'operation-connection-test',
    connectionId: record.id,
  })
  const testedReplay = await actions.test({
    operationId: 'operation-connection-test',
    connectionId: record.id,
  })
  assert.equal(tested.replayed, false)
  assert.equal(testedReplay.replayed, true)
  assert.deepEqual(testedReplay.connection, tested.connection)
  assert.equal(healthCalls, 1)
  assert.equal(capabilityCalls, 1)
  assert.equal(modelCalls, 1)
  assert.equal(JSON.stringify(app.state().operations).includes('credentialRef'), false)
})

test('safe removal is durable, restartable, and idempotent', async () => {
  const journal = new MemoryJournal(new FixedClock(at))
  const app = application(journal)
  const actions = service(app)
  const target = connection('connection-lifecycle-remove', 'removable bridge')
  const selectedElsewhere = connection('connection-lifecycle-keep', 'kept bridge')
  await actions.upsert({ operationId: 'operation-remove-create', record: target })
  await actions.upsert({ operationId: 'operation-keep-create', record: selectedElsewhere })
  await actions.select({
    operationId: 'operation-keep-select',
    connectionId: selectedElsewhere.id,
  })

  const removed = await actions.remove({
    operationId: 'operation-connection-remove',
    connectionId: target.id,
  })
  assert.equal(removed.replayed, false)
  assert.equal(removed.removed, true)
  assert.equal(
    app.state().connections.some((candidate) => candidate.id === target.id),
    false,
  )
  assert.equal(
    app.events().some(({ event }) => event.kind === 'connection.removed'),
    true,
  )
  const eventCount = app.events().length

  const replayed = await actions.remove({
    operationId: 'operation-connection-remove',
    connectionId: target.id,
  })
  assert.equal(replayed.replayed, true)
  assert.deepEqual(replayed.connection, removed.connection)
  assert.equal(app.events().length, eventCount)

  const restarted = application(journal)
  const restartReplay = await service(restarted).remove({
    operationId: 'operation-connection-remove',
    connectionId: target.id,
  })
  assert.equal(restartReplay.replayed, true)
  assert.equal(
    restarted.state().connections.some((candidate) => candidate.id === target.id),
    false,
  )
  assert.equal(
    restarted
      .state()
      .operations.some((operation) => operation.id === 'operation-connection-remove'),
    true,
  )
})

test('removal can retire an unselected catalog record that was never materialized in state', async () => {
  const journal = new MemoryJournal(new FixedClock(at))
  const app = application(journal)
  const selected = connection('connection-catalog-selected', 'selected bridge')
  const target = connection('connection-catalog-only', 'catalog-only bridge')
  const actions = service(app, [selected, target])
  await actions.select({
    operationId: 'operation-catalog-selected',
    connectionId: selected.id,
  })
  assert.equal(
    app.state().connections.some((candidate) => candidate.id === target.id),
    false,
  )

  const removed = await actions.remove({
    operationId: 'operation-catalog-only-remove',
    connectionId: target.id,
  })
  assert.equal(removed.removed, true)
  assert.equal(
    app.state().connections.some((candidate) => candidate.id === target.id),
    false,
  )
  const events = app.events().map(({ event }) => event)
  const upsertIndex = events.findIndex(
    (event) => event.kind === 'connection.upserted' && event.connection.id === target.id,
  )
  const removalIndex = events.findIndex(
    (event) => event.kind === 'connection.removed' && event.connectionId === target.id,
  )
  assert.ok(upsertIndex >= 0)
  assert.ok(removalIndex > upsertIndex)
})

test('unsafe removal returns typed blockers and the reducer fails closed', async () => {
  const journal = new MemoryJournal(new FixedClock(at))
  const app = application(journal)
  const actions = service(app)
  const target = connection('connection-lifecycle-blocked', 'blocked bridge')
  await actions.upsert({ operationId: 'operation-blocked-create', record: target })
  await actions.select({
    operationId: 'operation-blocked-select',
    connectionId: target.id,
  })

  const before = app.events().length
  await assert.rejects(
    actions.remove({
      operationId: 'operation-blocked-remove',
      connectionId: target.id,
    }),
    (error: unknown) => {
      if (!(error instanceof ConnectionRemovalError)) return false
      assert.equal(error.code, 'CONNECTION_REMOVAL_BLOCKED')
      assert.equal(error.connectionId, target.id)
      assert.equal(
        error.blockers.some((blocker) => blocker.kind === 'selected'),
        true,
      )
      assert.match(error.message, /Select a different connection/u)
      return true
    },
  )
  assert.equal(app.events().length, before)
  assert.equal(
    app.state().connections.some((candidate) => candidate.id === target.id),
    true,
  )

  const operation = {
    id: createOperationId('operation-reducer-blocked'),
    kind: 'connection-change' as const,
    requestDigest: canonicalDigest({ command: 'remove_connection', connectionId: target.id }),
    status: 'acknowledged' as const,
    target: { kind: 'connection' as const, id: target.id },
    result: {},
    createdAt: at,
    updatedAt: at,
    acknowledgedAt: at,
  }
  const state = app.state()
  assert.throws(
    () =>
      reduceEvent(state, {
        sequence: state.sequence + 1,
        revision: state.revision + 1,
        occurredAt: at,
        event: { kind: 'connection.removed', connectionId: target.id, operation },
      }),
    (error: unknown) => error instanceof DomainInvariantError,
  )

  const blockerState: BraidState = {
    ...state,
    selectedConnectionId: null,
    branches: [
      {
        id: 'branch-blocker',
        connectionId: target.id,
        status: 'active',
      } as BraidState['branches'][number],
    ],
    runs: [
      {
        id: 'run-direct-blocker',
        connectionId: target.id,
        status: 'running',
        complete: false,
      } as BraidState['runs'][number],
      {
        id: 'run-receipt-blocker',
        status: 'unknown',
        complete: false,
        receipt: { requested: { connectionId: target.id } },
      } as BraidState['runs'][number],
    ],
    environments: [
      {
        id: 'environment-blocker',
        connectionId: target.id,
        lifecycle: 'ready',
      } as BraidState['environments'][number],
    ],
    bindings: [
      {
        id: 'binding-blocker',
        connectionId: target.id,
        status: 'bound',
      } as BraidState['bindings'][number],
    ],
    rules: [
      {
        id: 'rule-blocker',
        enabled: true,
        matcher: { connectionId: target.id },
      } as BraidState['rules'][number],
    ],
  }
  const blockers = connectionRemovalBlockers(blockerState, target.id)
  assert.deepEqual([...new Set(blockers.map((blocker) => blocker.kind))].sort(), [
    'automation-rule',
    'binding',
    'branch',
    'environment',
    'run',
  ])
  assert.equal(
    blockers.every((blocker) => blocker.action.length > 0),
    true,
  )

  const historicalState: BraidState = {
    ...blockerState,
    branches: [
      {
        id: 'branch-archived',
        connectionId: target.id,
        status: 'archived',
      } as BraidState['branches'][number],
    ],
    runs: [
      {
        id: 'run-complete',
        connectionId: target.id,
        status: 'completed',
        complete: true,
      } as BraidState['runs'][number],
    ],
    environments: [
      {
        id: 'environment-destroyed',
        connectionId: target.id,
        lifecycle: 'destroyed',
      } as BraidState['environments'][number],
    ],
    bindings: [
      {
        id: 'binding-released',
        connectionId: target.id,
        status: 'released',
      } as BraidState['bindings'][number],
    ],
    rules: [
      {
        id: 'rule-disabled',
        enabled: false,
        matcher: { connectionId: target.id },
      } as BraidState['rules'][number],
    ],
  }
  assert.deepEqual(connectionRemovalBlockers(historicalState, target.id), [])
})
