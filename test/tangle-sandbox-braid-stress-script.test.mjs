import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cloudFailureEventTimeline,
  continuityDigestMatches,
  hasSingleMarkerLine,
  runIdForOperation,
  sandboxWorkspaceRelativePath,
  spendDisclosure,
} from '../scripts/live-required/tangle-sandbox-braid-stress.mjs'

import {
  assertEnvironmentIdentity,
  assertExclusiveResume,
  assertNonTerminalRun,
  assertNonVacuousVisibleEvents,
  assertProviderResumeProgress,
  assertSameCloudSession,
  assertSameControlRef,
  assertUniqueVisibleEvents,
  environmentForRun,
  latestCursorFromResponses,
  MissingIntegrationError,
  observationFromResponses,
  providerEventsForRun,
  resourceDelta,
  runObservations,
  stateRoundTrip,
  visibleEventKeys,
  waitForControlIdentity,
  waitForRequestState,
  waitForVisibleEvents,
  waitForWorkspaceToolEvents,
} from '../scripts/live-required/tangle-sandbox-braid-stress-support.mjs'

const controlRef = {
  provider: 'tangle-sandbox',
  environmentId: 'sandbox-1',
  sessionId: 'session-1',
  executionId: 'execution-1',
  runId: 'provider-run-1',
  requestDigest: `sha256:${'a'.repeat(64)}`,
}

test('workspace continuity accepts one exact digest with an optional final newline', () => {
  const digest = 'a'.repeat(64)
  assert.equal(continuityDigestMatches(digest, digest), true)
  assert.equal(continuityDigestMatches(`${digest}\n`, digest), true)
  assert.equal(continuityDigestMatches(`${digest}\n\n`, digest), false)
  assert.equal(continuityDigestMatches(` ${digest}`, digest), false)
})

function event(kind, payload) {
  const { provider, ...rest } = payload
  return {
    type: 'event',
    event: {
      kind,
      payload: { ...rest, ...(provider === undefined ? {} : { source: provider }) },
    },
  }
}

test('get_state waits for the state response instead of an acknowledgement', async () => {
  let sent
  const session = {
    responses: [],
    send(request) {
      sent = request
    },
    async waitFor(_label, predicate) {
      const response = { type: 'state', requestId: sent.requestId, state: { runs: [] } }
      assert.equal(predicate(response), true)
      return response
    },
  }

  const result = await stateRoundTrip(session)
  assert.deepEqual(result.state, { runs: [] })
})

test('model proof permits prose but requires exactly one isolated nonce line', () => {
  assert.equal(hasSingleMarkerLine('MARKER', 'MARKER'), true)
  assert.equal(hasSingleMarkerLine('Task complete.\n\nMARKER\n', 'MARKER'), true)
  assert.equal(hasSingleMarkerLine('Task complete: MARKER', 'MARKER'), false)
  assert.equal(hasSingleMarkerLine('MARKER\nMARKER', 'MARKER'), false)
})

test('control completion waits for its correlated state after transient terminal output', async () => {
  const transient = {
    type: 'state',
    requestId: 'provider-event',
    state: { runs: [{ id: 'run-cancel', status: 'failed' }] },
  }
  const completed = {
    type: 'state',
    requestId: 'cancel-request',
    state: { runs: [{ id: 'run-cancel', status: 'cancelled' }] },
  }
  const session = {
    responses: [transient],
    async waitFor(_label, predicate) {
      assert.equal(predicate(transient), false)
      assert.equal(predicate(completed), true)
      return completed
    },
  }

  assert.deepEqual(await waitForRequestState(session, 'cancel-request', 'run-cancel', 100), {
    response: completed,
    run: completed.state.runs[0],
  })
})

test('cleanup recovers exactly one durable run after a lost send acknowledgement', () => {
  const state = {
    runs: [
      { id: 'run-other', operationId: 'operation-other' },
      { id: 'run-proof', operationId: 'operation-proof' },
    ],
  }
  assert.equal(runIdForOperation(state, 'operation-proof'), 'run-proof')
  assert.equal(runIdForOperation(state, 'operation-missing'), undefined)
  assert.throws(
    () =>
      runIdForOperation(
        {
          runs: [
            { id: 'run-1', operationId: 'operation-duplicate' },
            { id: 'run-2', operationId: 'operation-duplicate' },
          ],
        },
        'operation-duplicate',
      ),
    /more than one Braid run/u,
  )
})

test('uses the Sandbox file API relative to its declared workspace root', () => {
  assert.equal(
    sandboxWorkspaceRelativePath('./.braid-live/proof/challenge.txt'),
    '.braid-live/proof/challenge.txt',
  )
  assert.equal(
    sandboxWorkspaceRelativePath('.braid-live/proof/challenge.txt'),
    '.braid-live/proof/challenge.txt',
  )
  assert.throws(
    () => sandboxWorkspaceRelativePath('/workspace/challenge.txt'),
    /contained relative path/u,
  )
  assert.throws(() => sandboxWorkspaceRelativePath('../challenge.txt'), /contained relative path/u)
  assert.throws(() => sandboxWorkspaceRelativePath(''), /contained relative path/u)
})

test('extracts exact control identity and an explicit provider cursor', () => {
  const responses = [
    {
      type: 'event',
      event: {
        kind: 'run.environment.observed',
        payload: {
          runId: 'local-run-1',
          value: {
            kind: 'run.environment.observed',
            runId: 'local-run-1',
            controlRef,
            provider: { eventId: 'environment-event-1', providerSequence: 1 },
          },
        },
      },
    },
    event('run.text.delta', {
      runId: 'local-run-1',
      provider: {
        cursor: 'cursor-7',
        eventId: 'provider-event-7',
        providerSequence: 2,
      },
    }),
  ]

  assert.deepEqual(observationFromResponses(responses, 'local-run-1'), {
    controlRef,
    cursor: 'cursor-7',
    event: responses[0],
  })
  assert.equal(latestCursorFromResponses(responses, 'local-run-1'), 'cursor-7')
})

test('recovers durable control identity without replaying a pre-cursor observation event', async () => {
  const responses = [
    {
      type: 'state',
      state: {
        runs: [{ id: 'local-run-1', status: 'completed', controlRef }],
      },
    },
    event('run.text.delta', {
      runId: 'local-run-1',
      provider: {
        cursor: 'cursor-after-restart',
        eventId: 'provider-event-after-restart',
        providerSequence: 8,
        runId: controlRef.runId,
        executionId: controlRef.executionId,
      },
    }),
  ]
  const session = { responses }

  assert.deepEqual(await waitForControlIdentity(session, 'local-run-1', 100), {
    controlRef,
    cursor: 'cursor-after-restart',
    event: responses[1],
  })
  assert.deepEqual(assertUniqueVisibleEvents(responses, 'local-run-1', 'restart'), {
    count: 1,
    keys: ['provider-event-after-restart'],
    events: [
      {
        kind: 'run.text.delta',
        eventId: 'provider-event-after-restart',
        providerSequence: 8,
        cursor: 'cursor-after-restart',
      },
    ],
  })
})

test('rejects visible events without stable provider identity and catches duplicates', () => {
  assert.throws(
    () => assertUniqueVisibleEvents([event('run.text.delta', { runId: 'run-1' })], 'run-1', 'test'),
    MissingIntegrationError,
  )

  const responses = [
    event('run.text.delta', {
      runId: 'run-1',
      provider: { eventId: 'event-1', providerSequence: 1, cursor: 'cursor-1' },
    }),
    event('run.text.delta', {
      runId: 'run-1',
      provider: { eventId: 'event-1', providerSequence: 2, cursor: 'cursor-2' },
    }),
  ]
  assert.throws(() => assertUniqueVisibleEvents(responses, 'run-1', 'test'), /duplicate visible/iu)
})

test('ignores attributable local lifecycle events without weakening visible event checks', () => {
  const local = event('run.requested', { runId: 'run-1', status: 'admitted' })
  assert.deepEqual(providerEventsForRun([local], 'run-1'), [])
  assert.throws(
    () =>
      providerEventsForRun(
        [local, event('run.text.delta', { runId: 'run-1', text: 'provider output' })],
        'run-1',
      ),
    /without provider metadata/iu,
  )
})

test('rejects foreign provider run and execution identities in visible events', () => {
  const observed = event('run.environment.observed', {
    runId: 'run-1',
    controlRef,
    provider: { eventId: 'environment-event-1', providerSequence: 1 },
  })
  const visible = (identity) =>
    event('run.text.delta', {
      runId: 'run-1',
      provider: {
        eventId: 'event-2',
        providerSequence: 2,
        cursor: 'cursor-2',
        ...identity,
      },
    })

  assert.doesNotThrow(() =>
    assertUniqueVisibleEvents(
      [observed, visible({ runId: controlRef.runId, executionId: controlRef.executionId })],
      'run-1',
      'identity',
    ),
  )
  assert.throws(
    () =>
      assertUniqueVisibleEvents(
        [observed, visible({ runId: 'foreign-provider-run' })],
        'run-1',
        'identity',
      ),
    /foreign provider runId/iu,
  )
  assert.throws(
    () =>
      assertUniqueVisibleEvents(
        [observed, visible({ executionId: 'foreign-provider-execution' })],
        'run-1',
        'identity',
      ),
    /foreign provider executionId/iu,
  )
})

test('never attributes an unscoped provider event to a run', () => {
  const responses = [
    event('run.environment.observed', { value: { runId: 'run-1' } }),
    event('run.environment.observed', { value: { runId: 'run-2' } }),
    event('run.text.delta', { source: { eventId: 'ambiguous-event' } }),
  ]
  assert.deepEqual(visibleEventKeys(responses, 'run-1'), [])
  assert.deepEqual(
    visibleEventKeys(
      [
        event('run.environment.observed', { runId: 'run-1' }),
        event('run.text.delta', {
          provider: { eventId: 'ambiguous-event', providerSequence: 1, cursor: 'cursor-1' },
        }),
      ],
      'run-1',
    ),
    [],
  )
})

test('requires an exclusive resume set and preserves local environment identity', () => {
  assert.deepEqual(assertExclusiveResume(['ack-1'], ['fresh-2']), [])
  assert.throws(() => assertExclusiveResume(['ack-1'], ['ack-1']), /acknowledged/iu)

  const environment = {
    id: 'environment-local-1',
    providerEnvironmentId: 'sandbox-1',
  }
  const state = { environments: [environment] }
  const run = { environmentId: environment.id }
  assert.equal(environmentForRun(state, run), environment)
  assert.equal(
    assertEnvironmentIdentity(run, state, { environmentId: 'sandbox-1' }, 'test'),
    environment,
  )
})

test('distinguishes same-run replay identity from a new cloud turn', () => {
  assert.doesNotThrow(() => assertSameControlRef(controlRef, { ...controlRef }, 'reconnect'))
  assert.doesNotThrow(() =>
    assertSameCloudSession(
      controlRef,
      {
        ...controlRef,
        executionId: 'execution-2',
        runId: 'provider-run-2',
        requestDigest: `sha256:${'b'.repeat(64)}`,
      },
      'follow-up',
    ),
  )
})

test('preserves unknown resource values instead of treating them as zero', () => {
  assert.deepEqual(
    resourceDelta(
      { activeSandboxes: 2, computeMinutes: 4 },
      { activeSandboxes: 2, computeMinutes: undefined },
    ),
    {
      activeSandboxes: 0,
      totalSandboxes: null,
      computeMinutes: null,
      gpuSeconds: null,
      gpuCostUsd: null,
      unknownFields: ['totalSandboxes', 'computeMinutes', 'gpuSeconds', 'gpuCostUsd'],
    },
  )
})

test('preserves observed zero, unavailable null, and missing telemetry projections', () => {
  const environment = {
    id: 'environment-local-1',
    providerEnvironmentId: 'sandbox-1',
    lifecycle: 'ready',
    placement: { provider: 'tangle', region: 'us-west-2' },
    accountUsage: { activeSandboxes: 0 },
    unavailableTelemetry: ['gpu'],
  }
  const observations = runObservations(
    {
      id: 'run-1',
      environmentId: environment.id,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    },
    { environments: [environment] },
  )

  assert.deepEqual(observations.run.inputTokens, { status: 'observed', value: 0 })
  assert.deepEqual(observations.run.costUsd, { status: 'unavailable', value: null })
  assert.deepEqual(observations.run.latencyMs, { status: 'missing' })
  assert.deepEqual(observations.environment.accountUsage, {
    status: 'observed',
    value: { activeSandboxes: 0 },
  })
  assert.deepEqual(observations.environment.gpu, { status: 'unavailable', value: null })
  assert.deepEqual(observations.environment.machineId, { status: 'missing' })
})

test('summarizes every unique cloud run without converting unknown spend to zero', () => {
  const spend = spendDisclosure({
    resumed: {
      id: 'run-first',
      status: 'completed',
      inputTokens: 0,
      outputTokens: 7,
      tokensKnown: true,
      costUsd: 0,
      usdKnown: true,
      costStatus: 'reported',
      startedAt: '2026-08-12T00:00:00.000Z',
      terminalAt: '2026-08-12T00:00:01.000Z',
    },
    followUp: {
      id: 'run-follow-up',
      status: 'completed',
      tokensKnown: false,
      usdKnown: false,
    },
    cancelled: { id: 'run-cancelled', status: 'cancelled' },
  })

  assert.deepEqual(spend.totals.tokens, {
    observedRuns: 1,
    unavailableRuns: 1,
    missingRuns: 1,
    input: 0,
    output: 7,
  })
  assert.deepEqual(spend.totals.cost, {
    observedRuns: 1,
    unavailableRuns: 1,
    missingRuns: 1,
    usd: 0,
  })
  assert.deepEqual(spend.rows[0].duration, { status: 'observed', milliseconds: 1000 })
  assert.equal(spend.rows[1].tokens.status, 'unavailable')
  assert.equal(spend.rows[2].tokens.status, 'missing')
})

test('failure diagnostics retain the run boundary without exposing credentials', () => {
  const timeline = cloudFailureEventTimeline(
    [
      {
        type: 'event',
        sequence: 7,
        event: {
          kind: 'run.unknown',
          runId: 'run-1',
          detail: 'HTTP 404 authorization: Bearer should-not-leak',
          error: 'Invalid API key: sk-live-sentinel-123',
        },
      },
      event('run.unknown', { runId: 'run-2', detail: 'unrelated' }),
    ],
    'run-1',
  )

  assert.deepEqual(timeline, [
    {
      sequence: 7,
      kind: 'run.unknown',
      runId: 'run-1',
      detail: 'HTTP 404 authorization=[redacted]',
      error: 'Invalid API key=[redacted]',
    },
  ])
  assert.equal(JSON.stringify(timeline).includes('should-not-leak'), false)
  assert.equal(JSON.stringify(timeline).includes('sk-live-sentinel-123'), false)
  assert.equal(JSON.stringify(timeline).includes('unrelated'), false)
})

test('rejects vacuous replay evidence and every terminal pre-kill state', () => {
  assert.doesNotThrow(() => assertNonTerminalRun({ status: 'running' }, 'first run'))
  for (const status of [
    'completed',
    'failed',
    'aborted',
    'cancelled',
    'expired',
    'blocked',
    'unknown',
  ]) {
    assert.throws(
      () => assertNonTerminalRun({ status }, 'first run'),
      /terminal before the forced restart/iu,
    )
  }
  assert.throws(
    () => assertNonVacuousVisibleEvents({ count: 0 }, 'pre-kill replay'),
    /no stable visible provider events/iu,
  )
  assert.doesNotThrow(() => assertNonVacuousVisibleEvents({ count: 1 }, 'pre-kill replay'))
})

test('requires fresh replay to advance beyond the persisted provider cursor', () => {
  const acknowledged = [
    event('run.text.delta', {
      runId: 'run-1',
      provider: { eventId: 'event-1', providerSequence: 4, cursor: 'cursor-4' },
    }),
  ]
  const resumed = [
    event('run.text.delta', {
      runId: 'run-1',
      provider: { eventId: 'event-2', providerSequence: 5, cursor: 'cursor-5' },
    }),
  ]
  assert.deepEqual(assertProviderResumeProgress(acknowledged, resumed, 'run-1', 'cursor-4'), {
    acknowledgedSequence: 4,
    firstFreshSequence: 5,
  })
  assert.throws(
    () => assertProviderResumeProgress(acknowledged, [], 'run-1', 'cursor-4'),
    /no stable visible provider events/iu,
  )
  assert.throws(
    () => assertProviderResumeProgress(acknowledged, resumed, 'run-1', 'wrong-cursor'),
    /did not identify an acknowledged provider event/iu,
  )
})

test('rejects a 4-to-6 replay gap and any reported missing history', () => {
  const acknowledged = [
    event('run.text.delta', {
      runId: 'run-1',
      provider: { eventId: 'event-4', providerSequence: 4, cursor: 'cursor-4' },
    }),
  ]
  const skipped = [
    event('run.text.delta', {
      runId: 'run-1',
      provider: { eventId: 'event-6', providerSequence: 6, cursor: 'cursor-6' },
    }),
  ]

  assert.throws(
    () => assertProviderResumeProgress(acknowledged, skipped, 'run-1', 'cursor-4'),
    /not contiguous/iu,
  )
  assert.throws(
    () =>
      assertProviderResumeProgress(
        [
          ...acknowledged,
          {
            type: 'state',
            state: { runs: [{ id: 'run-1', missingSequence: { from: 5, to: 5 } }] },
          },
        ],
        [...skipped, { type: 'state', state: { missingHistory: [] } }],
        'run-1',
        'cursor-4',
      ),
    /missing provider history/iu,
  )
  assert.throws(
    () =>
      assertProviderResumeProgress(
        acknowledged,
        [
          ...skipped,
          {
            type: 'state',
            state: {
              missingHistory: [{ runId: 'run-1', fromSequence: 5, toSequence: 5 }],
            },
          },
        ],
        'run-1',
        'cursor-4',
      ),
    /missing provider history/iu,
  )
})

test('waits for the first stable visible event before allowing a restart snapshot', async () => {
  const session = { responses: [] }
  setTimeout(() => {
    session.responses.push(
      event('run.text.delta', {
        runId: 'run-1',
        provider: {
          eventId: 'provider-event-1',
          providerSequence: 1,
          cursor: 'cursor-1',
        },
      }),
    )
  }, 15)

  const visible = await waitForVisibleEvents(session, 'run-1', 200, 'first process')
  assert.deepEqual(visible, {
    count: 1,
    keys: ['provider-event-1'],
    events: [
      {
        kind: 'run.text.delta',
        eventId: 'provider-event-1',
        providerSequence: 1,
        cursor: 'cursor-1',
      },
    ],
  })
})

test('waits for workspace tool evidence instead of stopping on session metadata', async () => {
  const session = {
    responses: [
      event('run.provider.event', {
        runId: 'run-1',
        provider: {
          eventId: 'provider-session-1',
          providerSequence: 1,
          cursor: 'cursor-1',
        },
      }),
    ],
  }
  setTimeout(() => {
    session.responses.push(
      event('run.part.updated', {
        runId: 'run-1',
        part: { kind: 'tool' },
        provider: {
          eventId: 'provider-tool-2',
          providerSequence: 2,
          cursor: 'cursor-2',
        },
      }),
    )
  }, 15)

  const visible = await waitForWorkspaceToolEvents(session, 'run-1', 200, 'first process')
  assert.equal(visible.count, 2)
  assert.equal(visible.events[1]?.partKind, 'tool')
})

test('stops pre-kill waits as soon as the run becomes terminal', async () => {
  const session = {
    responses: [
      {
        type: 'state',
        state: { runs: [{ id: 'run-1', status: 'unknown' }] },
      },
    ],
  }

  await assert.rejects(
    waitForControlIdentity(session, 'run-1', 10_000),
    /became unknown before exposing exact provider identity/iu,
  )
  await assert.rejects(
    waitForVisibleEvents(session, 'run-1', 10_000, 'first process'),
    /became unknown before emitting a stable visible provider event/iu,
  )
})
