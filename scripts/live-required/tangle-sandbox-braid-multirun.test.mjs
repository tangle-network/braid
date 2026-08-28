import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertFrameHasConcurrentRuns,
  frameEventIds,
  terminalFailureEvidence,
} from './tangle-sandbox-braid-multirun.mjs'
import { assertMultirunProof } from './multirun-contract.mjs'

function frame({ statusA = 'streaming', statusB = 'streaming', duplicate = false } = {}) {
  const eventA = { id: 'activity-a-1', runId: 'run-a', sourceEventId: 'provider-a-1' }
  const eventB = { id: 'activity-b-1', runId: 'run-b', sourceEventId: 'provider-b-1' }
  return {
    state: {
      runs: [
        { id: 'run-a', status: statusA },
        { id: 'run-b', status: statusB },
      ],
    },
    view: {
      runs: [
        { id: 'run-a', conversationId: 'conversation-a', branchId: 'branch-a' },
        { id: 'run-b', conversationId: 'conversation-b', branchId: 'branch-b' },
      ],
      activeRuns: [
        { runId: 'run-a', conversationId: 'conversation-a', branchId: 'branch-a' },
        { runId: 'run-b', conversationId: 'conversation-b', branchId: 'branch-b' },
      ],
      activity: duplicate ? [eventA, eventA, eventB] : [eventA, eventB],
      messages: [],
    },
  }
}

test('multirun frame guard requires two active streamed runs', () => {
  assert.equal(assertFrameHasConcurrentRuns(frame(), ['run-a', 'run-b']), true)
  assert.deepEqual(frameEventIds(frame(), 'run-a'), ['provider-a-1'])
  assert.deepEqual(frameEventIds(frame(), 'run-b'), ['provider-b-1'])
})

test('multirun frame guard rejects a terminal or underpowered run', () => {
  assert.throws(
    () => assertFrameHasConcurrentRuns(frame({ statusB: 'completed' }), ['run-a', 'run-b']),
    /run run-b is not active/u,
  )
  assert.throws(() => assertFrameHasConcurrentRuns(frame(), ['run-a']), /exactly two run ids/u)
})

test('event extraction preserves duplicates for the live replay assertion', () => {
  const duplicated = frame({ duplicate: true })
  assert.deepEqual(frameEventIds(duplicated, 'run-a'), ['provider-a-1', 'provider-a-1'])
})

test('multirun failure evidence retains the latest semantic frame and capture error', () => {
  const latestFrame = { state: { focusedRunId: 'run-b' }, view: { runs: [] } }
  const evidence = terminalFailureEvidence({
    snapshot: () => ({ screen: 'screen', outputBytes: 10 }),
    exited: false,
    output: 'terminal output',
    lastFrame: latestFrame,
    lastFrameError: 'frame file was incomplete',
  })
  assert.deepEqual(evidence.latestFrame, latestFrame)
  assert.equal(evidence.latestFrameError, 'frame file was incomplete')
  assert.equal(evidence.exited, false)
  assert.equal(evidence.outputTail, 'terminal output')
})

test('multirun release contract rejects missing, failed, or unclean evidence', () => {
  assert.throws(() => assertMultirunProof(undefined), /evidence is missing/u)
  assert.throws(
    () => assertMultirunProof({ status: 'failed' }),
    /evidence has an unsupported schema/u,
  )
  assert.throws(
    () =>
      assertMultirunProof({ schemaVersion: 'braid.live-required.multirun.v1', status: 'failed' }),
    /evidence did not pass/u,
  )
})
