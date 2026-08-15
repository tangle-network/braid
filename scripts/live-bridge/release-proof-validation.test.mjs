import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamingRedactor } from './capture.mjs'
import { evidenceValue, withoutBridgeSecrets } from './redaction.mjs'
import {
  assertContextTransfer,
  assertObservedUsage,
  assertRetainedInteraction,
  assertRetainedRestartProof,
  assertTargetRunIdentity,
  assertUniqueRunIds,
  terminalReceipts,
} from './release-proof-validation.mjs'
import { assertTargetSemantics } from './target-actions.mjs'

const target = {
  key: 'pi-test',
  modelId: 'pi/provider/model',
  definition: { backend: 'pi' },
}

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

test('usage, replay, and cancellation unavailable states cannot pass strict conformance', () => {
  assert.throws(() => assertObservedUsage(run({ tokensKnown: false })), /known token usage/u)
  assert.throws(() => assertObservedUsage(run({ llmCalls: 0 })), /model-call usage/u)
  const unavailable = {
    cancel: { status: 'reported-unavailable', advertised: false },
    interaction: { status: 'reported-unavailable', advertised: false },
  }
  assert.throws(() => assertTargetSemantics(unavailable, { strict: true }), /verified live proof/u)
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
      runId: 'run-1',
      status: 'completed',
      provider: { eventId: 'provider-finished', providerSequence: 3, cursor: '3:0' },
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

test('interaction proof requires durable declined or resolved state', () => {
  const retained = {
    request: { id: 'interaction-1' },
    status: 'declined',
    responseOperation: { outcome: 'declined' },
  }
  assert.deepEqual(
    assertRetainedInteraction({ interactions: [retained] }, 'interaction-1', { type: 'ack' }),
    retained,
  )
  for (const interaction of [
    undefined,
    { request: { id: 'interaction-1' }, status: 'unknown' },
    { request: { id: 'interaction-1' }, status: 'pending' },
    {
      request: { id: 'interaction-1' },
      status: 'resolved',
      responseOperation: { outcome: 'accepted' },
    },
  ]) {
    assert.throws(
      () =>
        assertRetainedInteraction(
          { interactions: interaction === undefined ? [] : [interaction] },
          'interaction-1',
          { type: 'ack' },
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
