import assert from 'node:assert/strict'
import test from 'node:test'
import { StreamingRedactor } from './capture.mjs'
import { evidenceValue, withoutBridgeSecrets } from './redaction.mjs'
import {
  assertContextTransfer,
  assertObservedUsage,
  assertRetainedInteraction,
  assertTargetRunIdentity,
  assertUniqueRunIds,
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

test('usage, replay, and cancellation unavailable states cannot pass strict conformance', () => {
  assert.throws(() => assertObservedUsage(run({ tokensKnown: false })), /known token usage/u)
  assert.throws(() => assertObservedUsage(run({ llmCalls: 0 })), /model-call usage/u)
  const unavailable = {
    reconnect: { status: 'reported-unavailable', advertised: false },
    cancel: { status: 'reported-unavailable', advertised: false },
    interaction: { status: 'reported-unavailable', advertised: false },
  }
  assert.throws(() => assertTargetSemantics(unavailable, { strict: true }), /verified live proof/u)
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
