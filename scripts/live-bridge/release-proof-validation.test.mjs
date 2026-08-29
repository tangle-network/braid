import assert from 'node:assert/strict'
import test from 'node:test'
import { bridgeLaunchEnvironment } from './bridge.mjs'
import { StreamingRedactor } from './capture.mjs'
import {
  assertObservedIdentity,
  eventSummary,
  observedProviderAndModel,
  parseSseEvents,
} from './native-continuation.mjs'
import {
  interactionFromResponse,
  retainedCancellationAdvertised,
  runWithAdmissionReceipt,
} from './protocol.mjs'
import {
  evidenceValue,
  secretValues,
  withoutBraidLiveSecrets,
  withoutBridgeSecrets,
} from './redaction.mjs'
import {
  assertContextTransfer,
  assertObservedUsage,
  assertRetainedInteraction,
  assertRetainedRestartProof,
  assertTargetRunIdentity,
  assertUniqueRunIds,
  terminalReceipts,
} from './release-proof-validation.mjs'
import { assertTargetSemantics, verifyInteraction } from './target-actions.mjs'
import { operationRequest, operationState } from './target-flow.mjs'

const target = {
  key: 'pi-test',
  modelId: 'pi/provider/model',
  definition: { backend: 'pi' },
}

test('retained cancellation proof reads the environment capability contract', () => {
  assert.equal(retainedCancellationAdvertised({}), false)
  assert.equal(
    retainedCancellationAdvertised({
      retainedControl: {
        exactRunIdentity: true,
        resultIdentity: true,
        eventIdentity: true,
        cancellationIdempotency: true,
      },
    }),
    true,
  )
})

test('native continuation proof reads provider identity from retained Bridge envelopes', () => {
  const [frame] = parseSseEvents(
    [
      'event: raw',
      'data: {"runId":"run-1","event":{"type":"raw","backend":"pi","event":{"type":"message_start","message":{"provider":"tangle-router","model":"glm-5.2"}}}}',
      '',
    ].join('\n'),
  )
  const summary = eventSummary(frame)
  assert.deepEqual(summary, {
    type: 'raw',
    backend: 'pi',
    provider: 'tangle-router',
    model: 'glm-5.2',
  })
  assert.deepEqual(observedProviderAndModel([summary], 'pi/tangle-router/glm-5.2'), {
    backends: ['pi'],
    providers: ['tangle-router'],
    models: ['glm-5.2'],
    backend: 'pi',
    provider: 'tangle-router',
    model: 'glm-5.2',
  })
})

test('native continuation identity stays bound to the retained session route', () => {
  const session = { backend: 'pi', model: 'pi/tangle-router/glm-5.2' }
  assert.doesNotThrow(() =>
    assertObservedIdentity(
      observedProviderAndModel([{ type: 'status', backend: 'pi' }], session.model),
      session,
    ),
  )
  assert.throws(
    () =>
      assertObservedIdentity(
        observedProviderAndModel(
          [{ type: 'raw', backend: 'pi', provider: 'other', model: 'glm-5.2' }],
          session.model,
        ),
        session,
      ),
    /did not match the retained session route/u,
  )
  assert.throws(
    () =>
      assertObservedIdentity(
        observedProviderAndModel(
          [{ type: 'raw', backend: 'pi', provider: 'tangle-router', model: 'glm-5.3' }],
          session.model,
        ),
        session,
      ),
    /did not match the retained session route/u,
  )
  assert.throws(
    () =>
      assertObservedIdentity(
        observedProviderAndModel(
          [
            { type: 'raw', backend: 'pi', provider: 'tangle-router', model: 'glm-5.2' },
            { type: 'raw', backend: 'pi', provider: 'tangle-router', model: 'glm-5.3' },
          ],
          session.model,
        ),
        session,
      ),
    /did not match the retained session route/u,
  )

  const alternateSession = { backend: 'pi', model: 'pi/tangle-router/gpt-5.4-mini' }
  assert.doesNotThrow(() =>
    assertObservedIdentity(
      observedProviderAndModel(
        [
          {
            type: 'raw',
            backend: 'pi',
            provider: 'tangle-router',
            model: 'gpt-5.4-mini',
          },
        ],
        alternateSession.model,
      ),
      alternateSession,
    ),
  )
})

function run(overrides = {}) {
  return {
    id: 'run-1',
    status: 'completed',
    complete: true,
    inputTokens: 2,
    outputTokens: 3,
    llmCalls: 1,
    model: 'model',
    receipt: {
      runId: 'run-1',
      profileDigest: 'profile-digest',
      materializationDigest: 'materialization-digest',
      provider: 'cli-bridge',
      requested: {
        runner: 'pi',
        model: 'model',
        profile: { harness: 'pi', model: { provider: 'provider', default: 'model' } },
      },
      materializationReceipt: {
        provider: 'cli-bridge',
        runner: 'pi',
        model: 'model',
        route: 'pi/provider/model',
      },
    },
    ...overrides,
  }
}

test('identity validation rejects configured-label false positives', () => {
  assert.doesNotThrow(() => assertTargetRunIdentity(run(), target))
  for (const broken of [
    { requested: { runner: 'codex' } },
    { requested: { model: 'other' } },
    { profile: { harness: 'codex' } },
    { materializationReceipt: undefined },
    { materializationReceipt: { route: 'pi/provider/other' } },
  ]) {
    const candidate = run({
      receipt: {
        ...run().receipt,
        requested: { ...run().receipt.requested, ...(broken.requested ?? {}) },
        ...(broken.profile === undefined
          ? {}
          : {
              requested: {
                ...run().receipt.requested,
                profile: { ...run().receipt.requested.profile, ...broken.profile },
              },
            }),
        ...('materializationReceipt' in broken
          ? {
              materializationReceipt:
                broken.materializationReceipt === undefined
                  ? undefined
                  : {
                      ...run().receipt.materializationReceipt,
                      ...broken.materializationReceipt,
                    },
            }
          : {}),
      },
    })
    assert.throws(() => assertTargetRunIdentity(candidate, target), /does not match|omitted/u)
  }
})

test('identity validation retains nested and runner-only model routes', () => {
  const nestedTarget = {
    key: 'pi-nested',
    modelId: 'pi/tangle-router/openai/gpt-5.6-luna',
    definition: { backend: 'pi' },
  }
  const nestedRun = run({
    model: 'openai/gpt-5.6-luna',
    receipt: {
      ...run().receipt,
      requested: {
        runner: 'pi',
        model: 'openai/gpt-5.6-luna',
        profile: {
          harness: 'pi',
          model: { provider: 'tangle-router', default: 'openai/gpt-5.6-luna' },
        },
      },
      materializationReceipt: {
        provider: 'cli-bridge',
        runner: 'pi',
        model: 'openai/gpt-5.6-luna',
        route: nestedTarget.modelId,
      },
    },
  })
  assert.deepEqual(assertTargetRunIdentity(nestedRun, nestedTarget).provider, 'tangle-router')

  const defaultTarget = {
    key: 'codex-default',
    modelId: 'codex/default',
    definition: { backend: 'codex' },
  }
  const defaultRun = run({
    model: 'default',
    receipt: {
      ...run().receipt,
      requested: {
        runner: 'codex',
        model: 'default',
        profile: { harness: 'codex', model: { default: 'default' } },
      },
      materializationReceipt: {
        provider: 'cli-bridge',
        runner: 'codex',
        model: 'default',
        route: defaultTarget.modelId,
      },
    },
  })
  assert.equal(assertTargetRunIdentity(defaultRun, defaultTarget).provider, undefined)
})

test('usage and cancellation unavailable states cannot pass strict conformance', () => {
  assert.throws(() => assertObservedUsage(run({ tokensKnown: false })), /known token usage/u)
  assert.throws(() => assertObservedUsage(run({ llmCalls: 0 })), /model-call usage/u)
  const cancellationUnavailable = {
    cancel: { status: 'reported-unavailable', advertised: false },
    interaction: { status: 'reported-unavailable', advertised: false },
  }
  assert.throws(
    () => assertTargetSemantics(cancellationUnavailable, { strict: true }),
    /verified live proof/u,
  )
  assert.doesNotThrow(() =>
    assertTargetSemantics(
      {
        cancel: { status: 'verified', advertised: true },
        interaction: { status: 'reported-unavailable', advertised: false },
      },
      { strict: true },
    ),
  )
  assert.throws(
    () =>
      assertTargetSemantics(
        {
          cancel: { status: 'advertised-but-not-active', advertised: true },
          interaction: { status: 'reported-unavailable', advertised: false },
        },
        { strict: true },
      ),
    /cancel/u,
  )
})

test('interaction conformance ignores a pending interaction from another run', async () => {
  const result = { targetKey: 'pi-test', requests: [] }
  const session = {
    send() {
      assert.fail('foreign interaction must not be answered')
    },
  }
  await verifyInteraction(
    session,
    result,
    { interactions: { available: true } },
    {
      type: 'state',
      view: {
        capabilities: { 'interaction.respond': true },
        interactions: [
          {
            runId: 'foreign-run',
            interactionId: 'foreign-interaction',
          },
        ],
      },
      state: { runs: [] },
    },
    { runId: 'target-run' },
  )
  assert.equal(result.interaction.status, 'advertised-but-not-emitted')
  assert.equal(result.requests.length, 0)
})

test('restart proof rejects process, timing, reconnect, replay, and terminal false positives', () => {
  const identity = {
    id: 'run-1',
    providerSessionId: 'session-1',
    lastCursor: '1:0',
    lastProviderSequence: 1,
    controlRef: {
      runId: 'provider-run-1',
      provider: 'cli-bridge',
      environmentId: 'environment-1',
      sessionId: 'session-1',
      executionId: 'execution-1',
      requestDigest: 'sha256:request',
    },
  }
  const oldProcess = { instanceId: 'process-old', pid: 1001, startedAt: 100 }
  const newProcess = { instanceId: 'process-new', pid: 1002, startedAt: 200 }
  const reconnectRequest = {
    requestId: 'reconnect-request',
    operationId: 'op-reconnect',
    command: 'reconnect',
  }
  const proof = {
    runId: 'run-1',
    savedCursor: '1:0',
    savedProviderSequence: 1,
    beforeDetach: { ...identity, status: 'streaming' },
    detached: { ...identity, status: 'detached' },
    reopened: { ...identity, status: 'detached' },
    final: { ...identity, status: 'completed', complete: true },
    oldProcess,
    newProcess,
    forcedProcess: {
      processIdentity: oldProcess,
      termination: {
        initialExited: false,
        initialTree: { supported: true, gone: false },
        termSent: true,
        killSent: false,
        exited: true,
        descendantsExited: true,
        descendantsVerified: true,
        cleanupStatus: 'term',
      },
      exit: { code: 0, signal: 'SIGTERM' },
    },
    activeModel: {
      admission: {
        runId: 'run-1',
        requestId: 'send-request',
        operationId: 'op-send',
        responseIndex: 1,
        revision: 5,
      },
      state: {
        runId: 'run-1',
        activeRunId: 'run-1',
        status: 'streaming',
        responseIndex: 3,
        revision: 6,
      },
      progress: {
        runId: 'run-1',
        kind: 'run.text.delta',
        responseIndex: 4,
        sequence: 7,
        revision: 7,
        providerSequence: 2,
        cursor: '2:0',
      },
    },
    reopenedRevision: 12,
    reconnectRequest,
    reconnectResponse: {
      type: 'ack',
      requestId: reconnectRequest.requestId,
      operationId: reconnectRequest.operationId,
      command: 'reconnect',
      revision: 16,
    },
    reconnectBoundary: {
      runId: 'run-1',
      kind: 'run.reconnecting',
      responseIndex: 20,
      sequence: 13,
      revision: 13,
      savedCursor: '1:0',
    },
    replayEvent: {
      kind: 'run.text.delta',
      responseIndex: 21,
      sequence: 14,
      revision: 14,
      event: {
        kind: 'run.text.delta',
        runId: 'run-1',
        provider: { providerSequence: 2, cursor: '2:0' },
      },
    },
    terminalReceipts: [
      {
        session: newProcess.instanceId,
        responseIndex: 30,
        runId: 'run-1',
        sequence: 15,
        revision: 15,
        status: 'completed',
        providerEventId: 'provider-finished',
        providerSequence: 3,
        cursor: '3:0',
      },
    ],
    finalState: {
      revision: 16,
      state: {
        revision: 16,
        runs: [{ id: 'run-1', status: 'completed', complete: true }],
      },
    },
    terminalSession: newProcess.instanceId,
  }
  assert.equal(assertRetainedRestartProof(proof).terminal.deliveryCount, 1)

  const adversarial = [
    {
      name: 'already exited process',
      proof: {
        ...proof,
        forcedProcess: {
          ...proof.forcedProcess,
          termination: { ...proof.forcedProcess.termination, initialExited: true },
        },
      },
    },
    {
      name: 'no termination signal',
      proof: {
        ...proof,
        forcedProcess: {
          ...proof.forcedProcess,
          termination: {
            ...proof.forcedProcess.termination,
            termSent: false,
            killSent: false,
            cleanupStatus: 'already-exited',
          },
        },
      },
    },
    {
      name: 'same process identity',
      proof: { ...proof, newProcess: { ...proof.newProcess, pid: proof.oldProcess.pid } },
    },
    {
      name: 'stale active run id',
      proof: {
        ...proof,
        activeModel: {
          ...proof.activeModel,
          state: { ...proof.activeModel.state, activeRunId: 'other-run' },
        },
      },
    },
    {
      name: 'pre-admission progress',
      proof: {
        ...proof,
        activeModel: {
          ...proof.activeModel,
          progress: { ...proof.activeModel.progress, responseIndex: 1 },
        },
      },
    },
    {
      name: 'non-progress event',
      proof: {
        ...proof,
        activeModel: {
          ...proof.activeModel,
          progress: { ...proof.activeModel.progress, kind: 'run.usage' },
        },
      },
    },
    {
      name: 'rejected reconnect acknowledgement',
      proof: {
        ...proof,
        reconnectResponse: { ...proof.reconnectResponse, outcome: 'rejected' },
      },
    },
    {
      name: 'replay before reconnect boundary',
      proof: {
        ...proof,
        replayEvent: { ...proof.replayEvent, responseIndex: proof.reconnectBoundary.responseIndex },
      },
    },
    {
      name: 'reconnect boundary uses a different saved cursor',
      proof: {
        ...proof,
        reconnectBoundary: { ...proof.reconnectBoundary, savedCursor: '0:0' },
      },
    },
    {
      name: 'replay sequence gap after saved cursor',
      proof: {
        ...proof,
        replayEvent: {
          ...proof.replayEvent,
          event: {
            ...proof.replayEvent.event,
            provider: { providerSequence: 99, cursor: '99:0' },
          },
        },
      },
    },
    {
      name: 'duplicate terminal across sessions',
      proof: {
        ...proof,
        terminalReceipts: [
          ...proof.terminalReceipts,
          { ...proof.terminalReceipts[0], session: 'old-session' },
        ],
      },
    },
    {
      name: 'terminal delivered only by old session',
      proof: {
        ...proof,
        terminalReceipts: [{ ...proof.terminalReceipts[0], session: proof.oldProcess.instanceId }],
      },
    },
    {
      name: 'terminal not durable',
      proof: { ...proof, finalState: { revision: 14, state: { revision: 14 } } },
    },
    {
      name: 'terminal completion missing',
      proof: { ...proof, terminalReceipts: [] },
    },
    {
      name: 'retained run not completed',
      proof: { ...proof, final: { ...proof.final, status: 'failed' } },
    },
  ]
  for (const { name, proof: broken } of adversarial) {
    assert.throws(() => assertRetainedRestartProof(broken), name)
  }

  const terminalResponse = {
    type: 'event',
    sequence: 4,
    revision: 4,
    event: {
      kind: 'run.finished',
      payload: {
        runId: 'run-1',
        status: 'completed',
        source: { eventId: 'provider-finished', providerSequence: 3, cursor: '3:0' },
      },
    },
  }
  assert.deepEqual(terminalReceipts([terminalResponse], 'restarted-session', 'run-1'), [
    {
      session: 'restarted-session',
      responseIndex: 0,
      runId: 'run-1',
      sequence: 4,
      revision: 4,
      status: 'completed',
      providerEventId: 'provider-finished',
      providerSequence: 3,
      cursor: '3:0',
    },
  ])
})

test('release RPC reads state and interaction frames from the public envelope', async () => {
  const stateFrame = {
    version: 1,
    type: 'state',
    requestId: 'interactive-proof-execution-a-state-active-pi-test',
    state: { runs: [{ id: 'run-1', status: 'streaming' }] },
  }
  const sent = []
  const session = {
    send(request) {
      sent.push(request)
    },
    async waitFor(label, predicate, timeoutMs) {
      assert.equal(label, 'release operation state')
      assert.equal(timeoutMs, 15_000)
      assert.equal(predicate(stateFrame), true)
      return stateFrame
    },
  }
  const result = { operationNamespace: 'proof-execution-a', targetKey: 'pi-test', requests: [] }
  assert.equal(await operationState(session, result, 'interactive', 'active', 120_000), stateFrame)
  assert.deepEqual(sent, result.requests)

  const requestInput = ['interactive', 'respond', 'respond_interaction', { runId: 'run-1' }]
  const first = operationRequest(result, ...requestInput)
  const retry = operationRequest(result, ...requestInput)
  const independent = operationRequest(
    { ...result, operationNamespace: 'proof-execution-b' },
    ...requestInput,
  )
  assert.deepEqual(retry, first)
  assert.notEqual(independent.operationId, first.operationId)

  const projectedRun = { id: 'run-1', status: 'completed' }
  const admission = { runId: 'run-1', profileDigest: 'profile-digest' }
  assert.deepEqual(runWithAdmissionReceipt(projectedRun, admission), {
    ...projectedRun,
    receipt: admission,
  })
  assert.equal(
    runWithAdmissionReceipt(projectedRun, { ...admission, runId: 'run-2' }),
    projectedRun,
  )

  const interactionFrame = {
    version: 1,
    type: 'event',
    sequence: 10,
    revision: 10,
    event: {
      kind: 'run.interaction',
      payload: {
        runId: 'run-1',
        interaction: {
          id: 'interaction-local-1',
          kind: 'permission',
          title: 'Permission: bash',
        },
      },
    },
  }
  assert.deepEqual(interactionFromResponse(interactionFrame, 'run-1'), {
    runId: 'run-1',
    interactionId: 'interaction-local-1',
    request: interactionFrame.event.payload.interaction,
  })
})

test('interaction proof requires ordered durable response events', () => {
  const operationId = 'operation-interaction-1'
  const event = (sequence, kind, outcome = 'declined') => ({
    type: 'event',
    sequence,
    revision: sequence,
    event: {
      kind,
      payload: {
        runId: 'run-1',
        value: { interactionId: 'interaction-1', operationId, outcome },
      },
    },
  })
  const requested = event(1, 'run.interaction.response.requested')
  const responded = event(2, 'run.interaction.responded')
  const acknowledgement = { type: 'ack', operationId, outcome: 'accepted' }
  assert.deepEqual(
    assertRetainedInteraction(
      [requested, responded],
      'run-1',
      'interaction-1',
      operationId,
      acknowledgement,
    ),
    {
      status: 'declined',
      responseOperation: responded.event.payload.value,
      requestedSequence: 1,
      respondedSequence: 2,
    },
  )
  for (const input of [
    { responses: [], acknowledgement },
    { responses: [responded, requested], acknowledgement },
    {
      responses: [requested, event(2, 'run.interaction.responded', 'unknown')],
      acknowledgement,
    },
    {
      responses: [requested, responded],
      acknowledgement: { ...acknowledgement, outcome: 'rejected' },
    },
  ]) {
    assert.throws(
      () =>
        assertRetainedInteraction(
          input.responses,
          'run-1',
          'interaction-1',
          operationId,
          input.acknowledgement,
        ),
      /interaction/u,
    )
  }
})

test('context transfer binds boundary, source run, digest, and destination receipt', () => {
  const plan = {
    throughMessageId: 'message-1',
    digest: 'plan-digest',
    context: {
      sourceRunId: 'source-run',
      sourceBoundary: 'message-1',
      digest: 'context-digest',
      messages: [{ id: 'message-1' }],
    },
  }
  const destination = run({
    id: 'destination-run',
    receipt: {
      ...run().receipt,
      runId: 'destination-run',
      requested: { ...run().receipt.requested, contextPlanDigest: 'context-digest' },
      contextTransfer: {
        planDigest: 'context-digest',
        sourceRunId: 'source-run',
        destinationRunId: 'destination-run',
        acceptedAt: '2026-08-10T00:00:00.000Z',
      },
    },
  })
  assert.doesNotThrow(() =>
    assertContextTransfer({
      sourceRunId: 'source-run',
      sourceMessageId: 'message-1',
      plan,
      destinationRun: destination,
    }),
  )
  for (const broken of [
    { plan: { ...plan, throughMessageId: 'other' } },
    { plan: { ...plan, context: { ...plan.context, sourceRunId: 'other' } } },
    {
      destinationRun: run({
        id: 'destination-run',
        receipt: { ...destination.receipt, contextTransfer: undefined },
      }),
    },
  ]) {
    assert.throws(
      () =>
        assertContextTransfer({
          sourceRunId: 'source-run',
          sourceMessageId: 'message-1',
          plan: broken.plan ?? plan,
          destinationRun: broken.destinationRun ?? destination,
        }),
      /message|context|boundary/u,
    )
  }
})

test('release operations reject reused run IDs and redact bridge bearers', () => {
  const used = new Set(['run-1'])
  assert.throws(() => assertUniqueRunIds(['run-2', 'run-1'], used), /reused/u)
  const secret = 'bridge-bearer-test-secret'
  const stream = new StreamingRedactor(256_000, 512, [secret])
  stream.push(`${'x'.repeat(600)}${secret.slice(0, 10)}`)
  stream.push(`${secret.slice(10)}\n`)
  assert.doesNotMatch(stream.finish(), new RegExp(secret, 'u'))
  assert.doesNotMatch(
    JSON.stringify(evidenceValue({ stdout: secret }, '', 0, [secret])),
    new RegExp(secret, 'u'),
  )
  assert.equal(withoutBridgeSecrets({ BRIDGE_BEARER: secret }).BRIDGE_BEARER, undefined)
})

test('started CLI Bridge keeps local subscription settings but strips Braid live credentials', () => {
  const environment = {
    PATH: '/usr/bin',
    TANGLE_API_KEY: 'tangle-secret-canary',
    BRAID_TANGLE_SANDBOX_API_KEY: 'sandbox-secret-canary',
    BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY: 'cleanup-secret-canary',
    BRAID_TANGLE_CREDENTIAL_REF: 'credential-ref-canary',
    BRAID_CLI_BRIDGE_AUTH: 'braid-bridge-secret-canary',
    BRIDGE_BEARER: 'bridge-server-secret-canary',
    OPENAI_API_KEY: 'local-subscription-canary',
    PI_CODING_AGENT_DIR: '/tmp/pi-agent',
  }
  const child = bridgeLaunchEnvironment([{ backend: 'pi' }], 'http://127.0.0.1:3344', {
    environment,
    platform: 'linux',
  })

  for (const key of [
    'TANGLE_API_KEY',
    'BRAID_TANGLE_SANDBOX_API_KEY',
    'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY',
    'BRAID_TANGLE_CREDENTIAL_REF',
    'BRAID_CLI_BRIDGE_AUTH',
  ]) {
    assert.equal(child[key], undefined, `${key} must not enter the Bridge process`)
  }
  assert.equal(child.BRIDGE_BEARER, environment.BRIDGE_BEARER)
  assert.equal(child.OPENAI_API_KEY, environment.OPENAI_API_KEY)
  assert.equal(child.PI_CODING_AGENT_DIR, environment.PI_CODING_AGENT_DIR)
  assert.equal(child.BRIDGE_BACKENDS, 'pi')
  assert.equal(child.BRIDGE_JAIL_MODE, 'fs-jail')
})

test('Braid live credential filtering does not remove local CLI subscription settings', () => {
  const child = withoutBraidLiveSecrets({
    TANGLE_API_KEY: 'tangle-secret-canary',
    BRAID_TANGLE_API_KEY: 'tangle-secret-canary',
    ANTHROPIC_API_KEY: 'local-subscription-canary',
    CODEX_HOME: '/tmp/codex',
  })
  assert.equal(child.TANGLE_API_KEY, undefined)
  assert.equal(child.BRAID_TANGLE_API_KEY, undefined)
  assert.equal(child.ANTHROPIC_API_KEY, 'local-subscription-canary')
  assert.equal(child.CODEX_HOME, '/tmp/codex')
})

test('captured Bridge evidence redacts preserved local subscription credentials', () => {
  const secret = 'local-subscription-secret-canary'
  const evidence = evidenceValue(
    { stderr: `provider startup printed ${secret}` },
    '',
    0,
    secretValues({ OPENAI_API_KEY: secret }),
  )
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(secret, 'u'))
})
