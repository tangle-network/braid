import assert from 'node:assert/strict'
import test from 'node:test'

import { STARTER_PROFILE } from '../src/app/composition.js'
import type { BraidEvent, JournalEventEnvelope } from '../src/domain/events.js'
import {
  createEventId,
  createGraphEdgeId,
  createGraphNodeId,
  createWorkspaceId,
} from '../src/domain/ids.js'
import { DuplicateEventConflictError, reduceEvent, replayEvents } from '../src/domain/reducer.js'
import { initialState } from '../src/domain/state.js'
import { layoutFor } from '../src/views/tui/layout.js'

const occurredAt = '2026-08-09T00:00:00.000Z'
const unicodeSamples = [
  'plain text',
  '组合文字',
  '한글 입력',
  'اَلْعَرَبِيَّةُ',
  'e\u0301 and 👩🏽‍💻',
  'flag 🇺🇳 variation ✈️',
] as const

function integerEnvironment(name: string, fallback: number, maximum: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`${name} must be an integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum)
    throw new Error(`${name} is outside its supported range`)
  return parsed
}

function randomFor(seed: number): () => number {
  let state = (seed ^ 0x9e37_79b9) >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return state >>> 0
  }
}

function envelope(
  seed: number,
  sequence: number,
  event: BraidEvent,
  label = String(sequence),
): JournalEventEnvelope {
  return {
    eventId: createEventId(`event-property-${seed}-${label}`),
    sequence,
    revision: sequence,
    occurredAt,
    event,
  }
}

function replayProperty(seed: number, random: () => number): void {
  const text = `${unicodeSamples[random() % unicodeSamples.length]}-${random()}`
  const events = [
    envelope(seed, 1, { kind: 'workspace.opened', workspace: `/workspace/property-${seed}` }),
    envelope(seed, 2, { kind: 'draft.changed', text }),
  ]
  const initial = initialState(STARTER_PROFILE)
  assert.deepEqual(events.reduce(reduceEvent, initial), replayEvents(initial, events))
}

function duplicateProperty(seed: number): void {
  const event = envelope(seed, 1, {
    kind: 'workspace.opened',
    workspace: `/workspace/property-${seed}`,
  })
  const state = reduceEvent(initialState(STARTER_PROFILE), event)
  assert.strictEqual(reduceEvent(state, event), state)
  assert.throws(
    () =>
      reduceEvent(state, {
        ...event,
        event: { kind: 'workspace.opened', workspace: `/workspace/changed-${seed}` },
      }),
    (error: unknown) => error instanceof DuplicateEventConflictError,
  )
}

function graphProperty(seed: number): void {
  const nodeA = createGraphNodeId(`node-property-${seed}-a`)
  const nodeB = createGraphNodeId(`node-property-${seed}-b`)
  const workspaceId = createWorkspaceId(`workspace-property-${seed}`)
  const node = (id: typeof nodeA) => ({
    id,
    reference: { kind: 'workspace' as const, id: workspaceId },
    createdAt: occurredAt,
    updatedAt: occurredAt,
  })
  let state = initialState(STARTER_PROFILE)
  state = reduceEvent(
    state,
    envelope(seed, 1, { kind: 'graph.node.upserted', node: node(nodeA) }, 'node-a'),
  )
  state = reduceEvent(
    state,
    envelope(seed, 2, { kind: 'graph.node.upserted', node: node(nodeB) }, 'node-b'),
  )
  state = reduceEvent(
    state,
    envelope(
      seed,
      3,
      {
        kind: 'graph.edge.upserted',
        edge: {
          id: createGraphEdgeId(`edge-property-${seed}-forward`),
          kind: 'continued',
          source: nodeA,
          destination: nodeB,
          provenance: {},
          createdAt: occurredAt,
        },
      },
      'edge-forward',
    ),
  )
  assert.throws(
    () =>
      reduceEvent(
        state,
        envelope(
          seed,
          4,
          {
            kind: 'graph.edge.upserted',
            edge: {
              id: createGraphEdgeId(`edge-property-${seed}-cycle`),
              kind: 'continued',
              source: nodeB,
              destination: nodeA,
              provenance: {},
              createdAt: occurredAt,
            },
          },
          'edge-cycle',
        ),
      ),
    /cycle/u,
  )
}

function layoutProperty(random: () => number): void {
  const columns = 1 + (random() % 500)
  const rows = 1 + (random() % 200)
  const activityVisible = (random() & 1) === 1
  const layout = layoutFor(columns, rows, activityVisible)
  assert.equal(layout.columns, columns)
  assert.equal(layout.rows, rows)
  assert(layout.transcriptWidth >= 1)
  assert(layout.activityWidth >= 0)
  assert.equal(layout.transcriptWidth + layout.gap + layout.activityWidth, columns)
  assert.equal(layout.activityWidth > 0, layout.mode === 'wide' && activityVisible)
}

function runSeed(seed: number): void {
  const random = randomFor(seed)
  switch (random() % 4) {
    case 0:
      replayProperty(seed, random)
      break
    case 1:
      duplicateProperty(seed)
      break
    case 2:
      graphProperty(seed)
      break
    default:
      layoutProperty(random)
  }
}

const runCount = integerEnvironment('BRAID_PROPERTY_RUNS', 1_000, 1_000_000)
const firstSeed = integerEnvironment('BRAID_PROPERTY_FIRST_SEED', 1, 0xffff_ffff)
if (firstSeed + runCount - 1 > 0xffff_ffff)
  throw new Error('Property seed range exceeds unsigned 32-bit integers')

test(`${runCount.toLocaleString('en-US')} deterministic product-property seeds pass`, () => {
  for (let offset = 0; offset < runCount; offset += 1) {
    const seed = firstSeed + offset
    try {
      runSeed(seed)
    } catch (error) {
      throw new Error(`Property seed ${seed} failed`, { cause: error })
    }
  }
})
