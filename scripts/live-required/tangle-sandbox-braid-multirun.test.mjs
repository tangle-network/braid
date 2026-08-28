import assert from 'node:assert/strict'
import test from 'node:test'
import { assertMultirunProof } from './multirun-contract.mjs'
import {
  activityBrowserOpen,
  cancellationDispatchVisible,
  assertFrameHasConcurrentRuns,
  assertSuccessfulTerminalExit,
  frameCancellationDispatch,
  frameEventIds,
  renderedWorkStripCount,
  sendCancellationAfterActivityBrowserDismissal,
  terminalRecordPath,
  terminalFailureEvidence,
  transcriptSurfaceReady,
  waitForActivityBrowserDismissal,
} from './tangle-sandbox-braid-multirun.mjs'

const activityBrowserScreen = [
  'Braid',
  'runs › run run-b',
  '↑↓ select · PgUp/PgDn detail · home/end jump · ←/esc close · tab filter · r refresh',
].join('\n')
const transcriptScreen = 'Braid\n──────────────── type / for commands · Alt+Enter newline'

function frame({ statusA = 'streaming', statusB = 'streaming', duplicate = false } = {}) {
  const eventA = { id: 'activity-a-1', runId: 'run-a', sourceEventId: 'provider-a-1' }
  const eventB = { id: 'activity-b-1', runId: 'run-b', sourceEventId: 'provider-b-1' }
  return {
    state: {
      runs: [
        { id: 'run-a', status: statusA },
        { id: 'run-b', status: statusB },
      ],
      activeRuns: [
        { runId: 'run-a', conversationId: 'conversation-a', branchId: 'branch-a' },
        { runId: 'run-b', conversationId: 'conversation-b', branchId: 'branch-b' },
      ],
    },
    view: {
      runs: [
        { id: 'run-a', conversationId: 'conversation-a', branchId: 'branch-a' },
        { id: 'run-b', conversationId: 'conversation-b', branchId: 'branch-b' },
      ],
      workStrip: [
        { runId: 'run-a', branchId: 'branch-a' },
        { runId: 'run-b', branchId: 'branch-b' },
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

test('activity browser dismissal is an explicit waitable terminal state', async () => {
  assert.equal(activityBrowserOpen(activityBrowserScreen), true)
  assert.equal(transcriptSurfaceReady(activityBrowserScreen), false)
  assert.equal(activityBrowserOpen('Braid\nruns › run run-b\ntype / for commands ·'), true)
  assert.equal(transcriptSurfaceReady('Braid\nruns › run run-b\ntype / for commands ·'), false)
  assert.equal(activityBrowserOpen(transcriptScreen), false)
  assert.equal(transcriptSurfaceReady(transcriptScreen), true)

  let screen = activityBrowserScreen
  let settled = false
  const runtime = { screen: () => screen }
  const dismissal = waitForActivityBrowserDismissal(runtime, 'focus branch B', 1_000).then(() => {
    settled = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  screen = transcriptScreen
  await dismissal
  assert.equal(settled, true)
})

test('cancellation sends Ctrl-C only after the activity browser is closed', async () => {
  let screen = activityBrowserScreen
  const inputs = []
  const runtime = {
    screen: () => screen,
    input(value) {
      inputs.push(value)
      if (value === '\u001b') screen = transcriptScreen
    },
  }
  await sendCancellationAfterActivityBrowserDismissal(runtime, 'branch B', 1_000)
  assert.deepEqual(inputs, ['\u001b', '\u0003'])
})

test('cancellation dispatch extraction requires canonical cancel event and operation identity', () => {
  const frame = {
    events: [
      {
        sequence: 4,
        kind: 'run.control.requested',
        payload: {
          runId: 'run-b',
          control: {
            operationId: 'op-cancel-b',
            runId: 'run-b',
            control: 'cancel',
            status: 'requested',
          },
        },
      },
    ],
  }
  assert.deepEqual(frameCancellationDispatch(frame, 'run-b'), {
    eventKind: 'run.control.requested',
    control: 'cancel',
    runId: 'run-b',
    operationId: 'op-cancel-b',
    sequence: 4,
  })
  assert.equal(frameCancellationDispatch(frame, 'run-a'), undefined)
  assert.equal(
    frameCancellationDispatch(
      { events: [{ kind: 'run.cancel.requested', payload: { runId: 'run-b' } }] },
      'run-b',
    ),
    undefined,
  )
})

test('cancellation dispatch accepts a fast acknowledgement after an active proof frame', () => {
  const acknowledged = frame({ statusB: 'cancelled' })
  acknowledged.events = [
    {
      sequence: 4,
      kind: 'run.control.requested',
      payload: {
        runId: 'run-b',
        control: {
          operationId: 'op-cancel-b',
          runId: 'run-b',
          control: 'cancel',
          status: 'requested',
        },
      },
    },
  ]
  assert.equal(cancellationDispatchVisible(acknowledged, 'run-a', 'run-b'), true)
})

test('restart close rejects a nonzero terminal exit code', () => {
  assert.doesNotThrow(() => assertSuccessfulTerminalExit({ exitCode: 0 }, 'restarted'))
  assert.throws(
    () => assertSuccessfulTerminalExit({ exitCode: 1 }, 'restarted'),
    /restarted Braid terminal process exited with a non-zero status/u,
  )
})

test('each terminal process owns one final state evidence path', () => {
  assert.equal(terminalRecordPath('/tmp/multirun-state.json', 0), '/tmp/multirun-state.json')
  assert.equal(
    terminalRecordPath('/tmp/multirun-state.json', 1),
    '/tmp/multirun-state.json.restart-1',
  )
  assert.notEqual(
    terminalRecordPath('/tmp/multirun-state.json', 1),
    terminalRecordPath('/tmp/multirun-state.json', 2),
  )
  assert.throws(() => terminalRecordPath('/tmp/multirun-state.json', -1), /non-negative/u)
})

test('rendered work-strip guard counts only actionable ownership rows', () => {
  assert.equal(
    renderedWorkStripCount(
      [
        '· branch-a · streaming · opencode/model · 1 interaction · actions switch/!ask/!steer/cancel',
        'status text mentioning work',
        '› branch-b · streaming · opencode/model · 0 interactions · actions swi…',
      ].join('\n'),
    ),
    2,
  )
})

test('multirun frame guard rejects a terminal or underpowered run', () => {
  assert.throws(
    () => assertFrameHasConcurrentRuns(frame({ statusB: 'completed' }), ['run-a', 'run-b']),
    /run run-b is not active/u,
  )
  assert.throws(() => assertFrameHasConcurrentRuns(frame(), ['run-a']), /exactly two run ids/u)
  const missingOwnership = frame()
  missingOwnership.state.activeRuns = missingOwnership.state.activeRuns.slice(0, 1)
  assert.throws(
    () => assertFrameHasConcurrentRuns(missingOwnership, ['run-a', 'run-b']),
    /active run ownership/u,
  )
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
