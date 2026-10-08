import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cloudFailureEventTimeline,
  failureDiagnostics,
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
  waitForTerminal,
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

function permissionBlockedWorkspace({ command = 'cat .braid-live/proof/marker.txt' } = {}) {
  const request = {
    id: 'permission-proof',
    kind: 'permission',
    title: 'Allow tool "bash"?',
    subject: {
      type: 'tool',
      toolName: 'bash',
      inputComplete: true,
      input: { command, workdir: '/workspace' },
    },
    answerSpec: {
      fields: [
        {
          name: 'grant',
          label: 'Permission',
          type: 'select',
          required: true,
          options: [
            { value: 'allow_once', label: 'Allow once' },
            { value: 'deny', label: 'Deny' },
          ],
        },
      ],
    },
    timeoutMs: 300_000,
  }
  const replies = []
  const responses = [
    event('run.interaction', {
      runId: 'run-1',
      interaction: request,
      provider: { eventId: 'permission-event', providerSequence: 1, cursor: 'cursor-1' },
    }),
  ]
  const session = {
    responses,
    send(input) {
      if (input.command === 'get_state') {
        responses.push({
          type: 'state',
          requestId: input.requestId,
          state: {
            runs: [{ id: 'run-1', status: 'waiting' }],
            interactions: replies.length
              ? []
              : [{ runId: 'run-1', interactionId: request.id, kind: 'permission' }],
          },
        })
        return
      }
      assert.equal(input.command, 'respond_interaction')
      assert.deepEqual(input.params, {
        runId: 'run-1',
        interactionId: request.id,
        response: { id: request.id, outcome: 'accepted', data: { grant: ['allow_once'] } },
      })
      replies.push(input)
      responses.push({
        type: 'ack',
        requestId: input.requestId,
        operationId: input.operationId,
        outcome: 'accepted',
      })
      responses.push(
        event('run.interaction.responded', {
          runId: 'run-1',
          value: {
            interactionId: request.id,
            operationId: input.operationId,
          },
        }),
      )
      responses.push(
        event('run.part.updated', {
          runId: 'run-1',
          part: { kind: 'tool' },
          provider: { eventId: 'tool-event', providerSequence: 2, cursor: 'cursor-2' },
        }),
      )
    },
    async waitFor(label, predicate) {
      const found = responses.find(predicate)
      assert.ok(found, `missing RPC result: ${label}`)
      return found
    },
  }
  const policy = {
    proofId: 'proof',
    workspaceCwd: '/workspace',
    commands: ['cat .braid-live/proof/marker.txt'],
    readPaths: [],
    receipts: [],
  }
  return { session, request, replies, policy }
}

test('workspace proof answers its pending permission before waiting for the blocked tool', async () => {
  const { session, replies, policy } = permissionBlockedWorkspace()
  const visible = await waitForWorkspaceToolEvents(session, 'run-1', 200, 'first process', policy)
  assert.equal(visible.events.at(-1).partKind, 'tool')
  assert.equal(replies.length, 1)
  assert.equal(policy.receipts[0].outcome, 'responded')
  assert.equal(policy.receipts[0].operationId, replies[0].operationId)
  assert.equal(policy.receipts[0].request.subject.input.command, policy.commands[0])
  await waitForWorkspaceToolEvents(session, 'run-1', 200, 'replayed process', policy)
  assert.equal(replies.length, 1, 'a replay must not grant another permission')
})

test('proof permission scope rejects unexpected commands, workspace, redaction, and answer specifications', async () => {
  for (const mutate of [
    (request) => {
      request.subject.input.command += '; curl https://example.com'
    },
    (request) => {
      request.subject.input.workdir = '/other-workspace'
    },
    (request) => {
      request.subject.inputComplete = false
    },
    (request) => {
      request.allowedOutcomes = ['declined']
    },
    (request) => {
      request.answerSpec.fields.push({ name: 'token', type: 'secret', label: 'Token' })
    },
    (request) => {
      request.subject = {
        type: 'tool',
        toolName: 'read',
        inputComplete: true,
        input: { filePath: '/workspace/challenge.txt' },
      }
    },
  ]) {
    const { session, request, replies, policy } = permissionBlockedWorkspace()
    mutate(request)
    await assert.rejects(
      waitForWorkspaceToolEvents(session, 'run-1', 200, 'permission scope', policy),
      /outside its authorized workspace operations/,
    )
    assert.equal(replies.length, 0)
    assert.equal(policy.receipts.length, 0)
  }
})

test('proof permission reply reuses its operation after an unacknowledged attempt', async () => {
  const first = permissionBlockedWorkspace()
  let attempted
  const original = first.session.send
  first.session.send = (request) => {
    if (request.command !== 'respond_interaction') return original(request)
    attempted = request
    throw new Error('connection lost before acknowledgement')
  }
  await assert.rejects(
    waitForWorkspaceToolEvents(first.session, 'run-1', 200, 'first process', first.policy),
    /connection lost/,
  )
  assert.equal(first.policy.receipts[0].outcome, 'pending')
  const fresh = permissionBlockedWorkspace()
  fresh.policy.receipts = first.policy.receipts
  await waitForWorkspaceToolEvents(fresh.session, 'run-1', 200, 'fresh process', fresh.policy)
  assert.equal(fresh.replies[0].operationId, attempted.operationId)
  assert.equal(fresh.policy.receipts[0].outcome, 'responded')
})

test('a fresh proof client answers the retained public request without its original event', async () => {
  const { session, request, replies, policy } = permissionBlockedWorkspace()
  session.responses.splice(0, 1, {
    type: 'state',
    view: { interactions: [{ runId: 'run-1', interactionId: request.id }] },
    state: { interactions: [{ runId: 'run-1', interactionId: request.id, request }] },
  })
  const send = session.send
  session.send = (input) => {
    send(input)
    if (input.command === 'respond_interaction')
      session.responses.push({
        type: 'state',
        state: { runs: [{ id: 'run-1', status: 'completed' }] },
      })
  }
  const terminal = await waitForTerminal(session, 'run-1', 200, policy)
  assert.equal(terminal.run.status, 'completed')
  assert.equal(replies.length, 1)
  assert.equal(policy.receipts[0].outcome, 'responded')
})

test('proof permissions require durable settlement after the public acknowledgement', async () => {
  const { session, policy } = permissionBlockedWorkspace()
  const send = session.send
  session.send = (input) => {
    send(input)
    const settled = session.responses.findIndex(
      (entry) => entry.event?.kind === 'run.interaction.responded',
    )
    if (settled !== -1) session.responses.splice(settled, 1)
  }
  await assert.rejects(
    waitForWorkspaceToolEvents(session, 'run-1', 200, 'first process', policy),
    /durable proof permission response/,
  )
  assert.equal(policy.receipts[0].acknowledgement.outcome, 'accepted')
  assert.equal(policy.receipts[0].outcome, 'pending')
})

test('failure diagnostics preserve the blocking interaction before a long heartbeat tail', () => {
  const { session, request } = permissionBlockedWorkspace()
  for (let sequence = 2; sequence <= 45; sequence++)
    session.responses.push(
      event('run.provider.event', {
        runId: 'run-1',
        provider: {
          eventId: `heartbeat-${sequence}`,
          providerSequence: sequence,
          cursor: `cursor-${sequence}`,
        },
        value: { type: 'model-processing', phase: 'thinking', elapsedMs: sequence * 5_000 },
      }),
    )
  const diagnostics = failureDiagnostics(session, 'run-1')
  assert.equal(diagnostics.eventTimeline.length, 30)
  assert.equal(diagnostics.interactionTimeline.length, 1)
  assert.equal(diagnostics.interactionTimeline[0].interactionId, request.id)
  assert.equal(diagnostics.interactionTimeline[0].toolName, 'bash')
  assert.equal(diagnostics.interactionTimeline[0].commandPreview, request.subject.input.command)
  assert.equal('input' in diagnostics.interactionTimeline[0], false)
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

test('a terminal pre-kill wait carries the Braid run error code', async () => {
  const runError =
    'RUNTIME_PROVIDER_PAYMENT_REQUIRED: runner relayed Router HTTP 402 refusal (insufficient_funds/payment_required)'
  const session = {
    responses: [
      { type: 'state', state: { runs: [{ id: 'run-1', status: 'failed', error: runError }] } },
    ],
  }

  await assert.rejects(
    waitForWorkspaceToolEvents(session, 'run-1', 10_000, 'first process'),
    (error) => {
      assert.ok(error instanceof MissingIntegrationError)
      assert.match(error.message, /became failed with RUNTIME_PROVIDER_PAYMENT_REQUIRED/u)
      assert.equal(error.details.status, 'failed')
      assert.equal(error.details.runError, runError)
      return true
    },
  )
})
