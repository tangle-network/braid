import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildTaskEvent } from '@tangle-network/agent-interface'
import {
  createBraidApplication,
  createDurableBraidApplication,
  DETERMINISTIC_PROFILE,
} from '../src/app/composition.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { MemoryJournal } from '../src/app/journal.js'
import { StorageJournal } from '../src/app/storage-journal.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import { createEventId } from '../src/domain/ids.js'
import { replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { restoreMaterializedState } from '../src/domain/materialized-state-snapshot.js'
import { FixedClock } from '../src/ports/clock.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { DEFAULT_RUN_CAPABILITIES } from '../src/ports/execution.js'

const at = Date.parse('2026-10-08T12:00:00.000Z')
const child: ChildTaskEvent = {
  type: 'child-task',
  childId: 'native-review',
  sourceEventId: 'child-start',
  status: 'running',
  title: 'Review the patch',
  runner: 'codex',
  time: { started: at, updated: at },
}

test('native children retain their own lifecycle, hierarchy and usage without becoming Runtime workers', async () => {
  const execution: ExecutionPort = {
    capabilities: () => DEFAULT_RUN_CAPABILITIES,
    async *streamTurn() {
      yield child
      yield {
        ...child,
        childId: 'native-check',
        parentChildId: child.childId,
        sourceEventId: 'grandchild-start',
        title: 'Check the result',
      }
      yield {
        ...child,
        status: 'completed' as const,
        sourceEventId: 'child-done',
        time: { started: at, updated: at + 10, ended: at + 10 },
        usage: { inputTokens: 17, outputTokens: 4 },
      }
      yield child
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = createBraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-native', text: 'Review this change' }).completion
  const run = app.state().runs[0]
  assert(run)
  assert.equal(run.nativeChildren?.children.length, 2)
  assert.equal(run.nativeChildren?.children[0]?.status, 'completed')
  assert.equal(run.nativeChildren?.children[1]?.parentChildId, 'native-review')
  assert.equal(run.nativeChildren?.children[0]?.usage?.inputTokens, 17)
  assert.deepEqual(run.nativeChildren?.appliedEventIds, [
    'child-start',
    'grandchild-start',
    'child-done',
  ])
  assert.equal(app.state().workers.length, 0)
  assert.equal(run.inputTokens, 0)
})

test('native children survive encrypted snapshots and legacy journal migration, with run-scoped dedupe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-native-'))
  const options = {
    path: join(root, 'state.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn(input: Parameters<ExecutionPort['streamTurn']>[0]) {
        yield child
        yield {
          type: 'final' as const,
          status: 'completed' as const,
          reason: 'completed',
          text: 'Done',
          metadata: {},
          task: { id: input.runId, intent: input.text },
          timestamp: new Date(at + 20).toISOString(),
        }
      },
    },
  }
  let durable = await createDurableBraidApplication(options)
  try {
    durable.app.initialize(root)
    await durable.app.whenDurable()
    const first = durable.app.send({ operationId: 'op-first', text: 'First review' })
    await first.completion
    await durable.app.send({ operationId: 'op-second', text: 'Second review' }).completion
    await durable.app.whenDurable()
    const expected = durable.app.state().runs.map((run) => run.nativeChildren)
    assert.equal(expected.length, 2)
    assert.equal(expected[0]?.children[0]?.childId, child.childId)
    assert.deepEqual(expected[0], expected[1])
    const snapshot = await durable.storage.latestStateSnapshot?.()
    assert(snapshot)
    const { projectionVersion: _version, ...oldFields } = snapshot.state
    const legacyState = {
      ...oldFields,
      runs: snapshot.state.runs.map(({ nativeChildren: _children, ...run }) => run),
    }
    const legacy = {
      ...snapshot,
      schemaVersion: 1,
      state: legacyState,
      stateChecksum: canonicalDigest(legacyState),
    }
    const historicalStorage = new Proxy(durable.storage, {
      get(target, property) {
        if (property === 'latestStateSnapshot') return async () => legacy
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const journal = await StorageJournal.fromStorage(historicalStorage, new FixedClock())
    assert.equal(
      journal.initialState(),
      undefined,
      'old snapshots must replay the retained canonical events',
    )
    const migrated = replayEvents(initialState(DETERMINISTIC_PROFILE), journal.replay())
    assert.deepEqual(
      migrated.runs.map((run) => run.nativeChildren),
      expected,
    )
    await durable.storage.close()
    durable = await createDurableBraidApplication(options)
    assert.deepEqual(
      durable.app.state().runs.map((run) => run.nativeChildren),
      expected,
    )
    const run = durable.app.state().runs.find((run) => run.id === first.runId)
    assert(run)
    const restored = durable.app.state()
    const replayed = replayEvents(restored, [
      {
        eventId: createEventId('event-replayed-after-snapshot'),
        sequence: restored.sequence + 1,
        revision: restored.revision + 1,
        occurredAt: new Date(at).toISOString(),
        event: {
          kind: 'run.provider.event',
          runId: run.id,
          provider: {
            eventId: 'replayed-provider-event',
            providerSequence: run.lastProviderSequence + 1,
          },
          envelope: {
            runId: run.id,
            eventId: 'replayed-provider-event',
            sequence: run.lastProviderSequence + 1,
            receivedAt: new Date(at).toISOString(),
            event: { ...child, title: 'A duplicate cannot rewrite the original' },
          },
        },
      },
    ])
    assert.deepEqual(replayed.runs.find((item) => item.id === run.id)?.nativeChildren, expected[0])
    const badState = {
      ...snapshot.state,
      runs: snapshot.state.runs.map((item) => ({
        ...item,
        nativeChildren: {
          children: [child, child],
          appliedEventIds: ['child-start'],
          truncated: false,
        },
      })),
    }
    assert.throws(
      () =>
        restoreMaterializedState({
          ...snapshot,
          state: badState,
          stateChecksum: canonicalDigest(badState),
        }),
      /native/u,
    )
  } finally {
    await durable.storage.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('native child observations reconnect without duplicates and parent cancellation does not fabricate child cancellation', async () => {
  const capabilities = {
    ...DEFAULT_RUN_CAPABILITIES,
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    events: { stableIdentity: true, sequence: true, cursor: true },
  }
  const execution: ExecutionPort = {
    capabilities: () => capabilities,
    async *streamTurn(input) {
      yield {
        runId: input.runId,
        eventId: 'first',
        sequence: 1,
        receivedAt: new Date(at).toISOString(),
        event: child,
      }
      throw new Error('disconnected')
    },
    async *reconnect(input) {
      yield {
        runId: input.runId,
        eventId: 'replayed',
        sequence: 2,
        receivedAt: new Date(at).toISOString(),
        event: child,
      }
      yield {
        runId: input.runId,
        eventId: 'cancelled',
        sequence: 3,
        receivedAt: new Date(at).toISOString(),
        event: { type: 'status', status: 'cancelled' },
      }
    },
  }
  const journal = new MemoryJournal(new FixedClock())
  const app = createBraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    journal,
    effectStorage: journal,
  })
  app.initialize('/workspace')
  const state = await app.send({ operationId: 'op-reconnect-native', text: 'Review' }).completion
  assert.equal(state.runs[0]?.status, 'cancelled')
  assert.equal(state.runs[0]?.nativeChildren?.children.length, 1)
  assert.equal(state.runs[0]?.nativeChildren?.children[0]?.status, 'running')
})

test('native child boundary rejects unsafe identity and malformed state and omits private provider payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-native-safety-'))
  const durable = await createDurableBraidApplication({
    path: join(root, 'state.sqlite'),
    workspaceRoot: root,
    credentialStore: new MemoryCredentialStore(),
    profile: DETERMINISTIC_PROFILE,
    execution: {
      async *streamTurn() {
        yield {
          ...child,
          raw: { private: 'NATIVE_PRIVATE_CANARY' },
          title: 'Review token=NATIVE_SECRET_CANARY',
        }
        yield { ...child, childId: 'token=NATIVE_ID_CANARY', sourceEventId: 'unsafe' }
        yield {
          ...child,
          childId: 'bad-time',
          sourceEventId: 'bad',
          time: { started: at, updated: at - 1 },
        }
        yield {
          ...child,
          childId: 'unrenderable-time',
          sourceEventId: 'huge-time',
          time: { started: at, updated: 1e20 },
        }
      },
    },
  })
  try {
    durable.app.initialize(root)
    await durable.app.whenDurable()
    await durable.app.send({ operationId: 'op-safe-native', text: 'Review' }).completion
    await durable.app.whenDurable()
    assert.equal(durable.app.state().runs[0]?.nativeChildren?.children.length, 1)
    const serialized = JSON.stringify({
      state: durable.app.state(),
      events: await durable.storage.events(),
    })
    assert.doesNotMatch(serialized, /NATIVE_PRIVATE_CANARY|NATIVE_SECRET_CANARY|NATIVE_ID_CANARY/u)
    assert.match(serialized, /NATIVE_CHILD_EVENT_INVALID/u)
    assert(!(await readFile(join(root, 'state.sqlite'))).includes(Buffer.from('Review')))
  } finally {
    await durable.storage.close()
    await rm(root, { recursive: true, force: true })
  }
})
