import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChildTaskEvent } from '@tangle-network/agent-interface'
import { createBraidApplication } from '../src/app/composition.js'
import { providerEventFor } from '../src/app/run-event-mapper.js'
import { createEventId } from '../src/domain/ids.js'
import {
  createMaterializedStateSnapshot,
  restoreMaterializedState,
} from '../src/domain/materialized-state-snapshot.js'
import { MAX_NATIVE_CHILD_EVENTS, MAX_NATIVE_CHILDREN } from '../src/domain/native-children.js'
import { reduceEvent } from '../src/domain/reducer.js'
import type { BraidState } from '../src/domain/state.js'
import { DEFAULT_RUN_CAPABILITIES, type ExecutionPort } from '../src/ports/execution.js'
import { queryActivity } from '../src/views/shared/semantic-activity.js'

const at = Date.parse('2026-10-08T12:00:00.000Z')
const observed: ChildTaskEvent = {
  type: 'child-task',
  childId: 'native-review',
  sourceEventId: 'source-running',
  status: 'running',
  title: 'Review the patch',
  time: { started: at, updated: at + 10 },
}

const execution: ExecutionPort = {
  capabilities: () => DEFAULT_RUN_CAPABILITIES,
  async *streamTurn(input) {
    yield observed
    yield {
      type: 'final',
      status: 'completed',
      reason: 'completed',
      text: 'Fixture complete.',
      metadata: {},
      task: { id: input.runId, intent: input.text },
      timestamp: new Date(at + 20).toISOString(),
    }
  },
}

async function fixture() {
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  await app.send({ operationId: 'op-native-ordering', text: 'Review the patch.' }).completion
  return app
}

type Projection = NonNullable<BraidState['runs'][number]['nativeChildren']>

function ingest(state: BraidState, event: ChildTaskEvent): BraidState {
  const run = state.runs[0]
  assert.ok(run)
  return reduceEvent(state, {
    sequence: state.sequence + 1,
    revision: state.revision + 1,
    occurredAt: new Date(at + 100).toISOString(),
    event: providerEventFor(run.id, event, {
      eventId: `provider-${event.sourceEventId}`,
      providerSequence: run.lastProviderSequence + 1,
      receivedAt: new Date(at + 100).toISOString(),
    }),
  })
}

function snapshotState(state: BraidState, projection: Projection): BraidState {
  const snapshot = createMaterializedStateSnapshot({
    scopeId: 'native-child-ordering',
    generation: 1,
    eventId: createEventId('event-native-child-snapshot'),
    state: {
      ...state,
      runs: state.runs.map((run) => ({ ...run, nativeChildren: projection })),
    },
  })
  return restoreMaterializedState(snapshot)
}

test('native child observations cannot regress lifecycle or replace an established parent', async () => {
  let state = (await fixture()).state()
  for (const event of [
    {
      ...observed,
      sourceEventId: 'late-start',
      status: 'started' as const,
      time: { started: at, updated: at + 30 },
    },
    {
      ...observed,
      sourceEventId: 'older-running',
      title: 'Stale title',
      time: { started: at, updated: at + 1 },
    },
    {
      ...observed,
      sourceEventId: 'new-parent',
      parentChildId: 'another-parent',
      time: { started: at, updated: at + 30 },
    },
    { ...observed, sourceEventId: 'new-start-time', time: { started: at + 1, updated: at + 30 } },
  ]) {
    state = ingest(state, event)
    assert.deepEqual(state.runs[0]?.nativeChildren?.children, [observed])
  }
  const completed: ChildTaskEvent = {
    ...observed,
    sourceEventId: 'completed',
    status: 'completed',
    time: { started: at, updated: at + 40, ended: at + 40 },
  }
  state = ingest(state, completed)
  state = ingest(state, {
    ...observed,
    sourceEventId: 'running-after-completed',
    time: { started: at, updated: at + 50 },
  })
  assert.deepEqual(state.runs[0]?.nativeChildren?.children, [completed])
  assert.equal(state.runs[0]?.nativeChildren?.appliedEventIds.length, 7)
})

test('native child count and source history limits retain a bounded, explicitly incomplete projection', async () => {
  const base = (await fixture()).state()
  const children = Array.from({ length: MAX_NATIVE_CHILDREN }, (_, index) => ({
    ...observed,
    childId: `child-${index}`,
    sourceEventId: `source-${index}`,
  }))
  const cases: Array<{ projection: Projection; event: ChildTaskEvent }> = [
    {
      projection: {
        children,
        appliedEventIds: children.map((item) => item.sourceEventId),
        truncated: false,
      },
      event: { ...observed, childId: 'child-over-limit', sourceEventId: 'child-over-limit' },
    },
    {
      projection: {
        children: [observed],
        appliedEventIds: [
          observed.sourceEventId,
          ...Array.from({ length: MAX_NATIVE_CHILD_EVENTS - 1 }, (_, index) => `old-${index}`),
        ],
        truncated: false,
      },
      event: { ...observed, sourceEventId: 'source-over-limit' },
    },
  ]
  for (const { projection, event } of cases) {
    let state = snapshotState(base, projection)
    state = ingest(state, event)
    const capped = state.runs[0]?.nativeChildren
    assert.deepEqual(capped, { ...projection, truncated: true })
    const first = projection.children[0]
    assert.ok(first)
    state = ingest(state, {
      ...first,
      sourceEventId: 'terminal-after-truncation',
      status: 'completed',
      time: { started: at, updated: at + 60, ended: at + 60 },
    })
    assert.deepEqual(state.runs[0]?.nativeChildren, capped, 'incomplete evidence stays frozen')
    const activity = queryActivity(state).activity.filter((item) => item.kind === 'native-child')
    assert.equal(activity.length, projection.children.length)
    assert.ok(
      activity.every((item) => item.detail?.includes('Native child history is incomplete.')),
    )
    assert.deepEqual(
      snapshotState(base, { ...projection, truncated: true }).runs[0]?.nativeChildren,
      capped,
    )
  }
})

test('native child snapshots reject missing source identity and excessive retained state', async () => {
  const state = (await fixture()).state()
  assert.throws(
    () =>
      snapshotState(state, {
        children: [observed],
        appliedEventIds: [],
        truncated: false,
      }),
    /native/u,
  )
  assert.throws(
    () =>
      snapshotState(state, {
        children: Array.from({ length: MAX_NATIVE_CHILDREN + 1 }, (_, index) => ({
          ...observed,
          childId: `child-${index}`,
          sourceEventId: `source-${index}`,
        })),
        appliedEventIds: Array.from(
          { length: MAX_NATIVE_CHILDREN + 1 },
          (_, index) => `source-${index}`,
        ),
        truncated: true,
      }),
    /native/u,
  )
  assert.throws(
    () =>
      snapshotState(state, {
        children: [observed],
        appliedEventIds: [
          observed.sourceEventId,
          ...Array.from({ length: MAX_NATIVE_CHILD_EVENTS }, (_, index) => `source-${index}`),
        ],
        truncated: true,
      }),
    /native/u,
  )
})
