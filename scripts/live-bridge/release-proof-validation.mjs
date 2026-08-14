import { exitCodes } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'

function fail(code, message, details = {}) {
  throw new LiveBridgeError(code, message, exitCodes.failed, details)
}

function text(value) {
  return typeof value === 'string' && value.length > 0
}

function routeParts(route) {
  if (!text(route)) return undefined
  const parts = route.split('/')
  return parts.length === 3 && parts.every((part) => part.length > 0)
    ? { runner: parts[0], provider: parts[1], model: parts[2] }
    : undefined
}

function same(value, expected, label, details) {
  if (value !== expected)
    fail('LIVE_RELEASE_TARGET_IDENTITY_INVALID', `${label} does not match`, details)
}

export function assertTargetRunIdentity(run, target) {
  const receipt = run?.receipt
  const requested = receipt?.requested
  const profile = requested?.profile
  const materialization = receipt?.materializationReceipt
  const expected = routeParts(target?.modelId)
  if (!text(run?.id) || !text(receipt?.runId) || run.id !== receipt.runId)
    fail('LIVE_RELEASE_TARGET_RECEIPT_MISSING', 'The run did not retain its durable run receipt', {
      run,
    })
  if (expected === undefined || target?.definition?.backend !== expected.runner)
    fail('LIVE_RELEASE_TARGET_IDENTITY_INVALID', 'The selected target route is not canonical', {
      target,
    })
  if (!text(receipt.profileDigest) || !text(receipt.materializationDigest))
    fail(
      'LIVE_RELEASE_PROFILE_MATERIALIZATION_MISSING',
      'The run receipt omitted profile materialization digests',
      { receipt },
    )
  if (!requested || !profile || !materialization)
    fail(
      'LIVE_RELEASE_TARGET_RECEIPT_MISSING',
      'The run omitted requested profile or materialization evidence',
      { run },
    )

  same(requested.runner, expected.runner, 'requested runner', { requested, expected })
  same(requested.model, expected.model, 'requested model', { requested, expected })
  same(profile.harness, expected.runner, 'materialized profile runner', { profile, expected })
  same(profile.model?.provider, expected.provider, 'materialized profile provider', {
    profile,
    expected,
  })
  same(profile.model?.default, expected.model, 'materialized profile model', { profile, expected })

  const effective = materialization.effective ?? materialization
  const effectiveRoute = effective.route
  const actual = routeParts(effectiveRoute)
  if (actual === undefined)
    fail(
      'LIVE_RELEASE_TARGET_IDENTITY_INVALID',
      'The materialization receipt omitted its effective route',
      { materialization },
    )
  same(effectiveRoute, target.modelId, 'effective route', { actual, expected, materialization })
  same(actual.runner, expected.runner, 'effective runner', { actual, expected })
  same(actual.provider, expected.provider, 'effective provider', { actual, expected })
  same(actual.model, expected.model, 'effective model', { actual, expected })
  same(effective.runner, expected.runner, 'materialization runner', { effective, expected })
  same(effective.model, expected.model, 'materialization model', { effective, expected })
  if (text(effective.modelProvider))
    same(effective.modelProvider, expected.provider, 'materialization provider', {
      effective,
      expected,
    })
  if (text(effective.providerName))
    same(effective.providerName, expected.provider, 'materialization provider', {
      effective,
      expected,
    })
  if (text(effective.profileDigest))
    same(effective.profileDigest, receipt.profileDigest, 'materialization profile digest', {
      effective,
      receipt,
    })
  if (text(effective.effectiveProfileDigest))
    same(effective.effectiveProfileDigest, receipt.profileDigest, 'effective profile digest', {
      effective,
      receipt,
    })
  if (text(receipt.provider))
    same(receipt.provider, materialization.provider, 'provider materialization', {
      receipt,
      materialization,
    })
  if (text(run.model)) same(run.model, expected.model, 'run model', { run, expected })

  return {
    key: target.key,
    harness: actual.runner,
    provider: actual.provider,
    model: actual.model,
    route: effectiveRoute,
    runId: run.id,
    profileDigest: receipt.profileDigest,
    materializationDigest: receipt.materializationDigest,
  }
}

export function assertObservedUsage(run) {
  if (run?.status !== 'completed' || run.complete !== true)
    fail('LIVE_RELEASE_USAGE_MISSING', 'The release run did not complete', { run })
  if (
    run.tokensKnown === false ||
    !Number.isFinite(run.inputTokens) ||
    !Number.isFinite(run.outputTokens)
  )
    fail('LIVE_RELEASE_USAGE_MISSING', 'The release run omitted known token usage', { run })
  if (!Number.isInteger(run.llmCalls) || run.llmCalls < 1)
    fail('LIVE_RELEASE_USAGE_MISSING', 'The release run omitted observed model-call usage', { run })
  return { inputTokens: run.inputTokens, outputTokens: run.outputTokens, llmCalls: run.llmCalls }
}

export function assertRetainedInteraction(run, interactionId, responseAck) {
  if (responseAck?.type !== 'ack')
    fail('LIVE_RELEASE_INTERACTION_NOT_RETAINED', 'The interaction response was not acknowledged', {
      responseAck,
    })
  const interaction = run?.interactions?.find((item) => item?.request?.id === interactionId)
  if (interaction === undefined || interaction.status === 'unknown')
    fail('LIVE_RELEASE_INTERACTION_UNKNOWN', 'The interaction outcome is unknown or absent', {
      run,
      interactionId,
    })
  if (!['declined', 'resolved'].includes(interaction.status))
    fail(
      'LIVE_RELEASE_INTERACTION_NOT_RETAINED',
      'The interaction did not retain a declined or resolved outcome',
      { interaction },
    )
  if (interaction.responseOperation?.outcome !== 'declined')
    fail(
      'LIVE_RELEASE_INTERACTION_NOT_RETAINED',
      'The durable interaction receipt did not retain the declined response',
      { interaction },
    )
  return interaction
}

export function assertContextTransfer({ sourceRunId, sourceMessageId, plan, destinationRun }) {
  const context = plan?.context
  const transfer = destinationRun?.receipt?.contextTransfer
  if (!text(sourceRunId) || !text(sourceMessageId) || !context || !transfer)
    fail(
      'LIVE_RELEASE_CONTEXT_TRANSFER_MISSING',
      'The handoff omitted durable context transfer evidence',
      { plan, destinationRun },
    )
  same(plan.throughMessageId, sourceMessageId, 'fork source message', { plan, sourceMessageId })
  same(context.sourceRunId, sourceRunId, 'context source run', { context, sourceRunId })
  same(context.sourceBoundary, sourceMessageId, 'context source boundary', {
    context,
    sourceMessageId,
  })
  if (!text(context.digest) || !text(plan.digest))
    fail(
      'LIVE_RELEASE_CONTEXT_TRANSFER_INVALID',
      'The handoff omitted a context or fork-plan digest',
      { plan },
    )
  same(transfer.planDigest, context.digest, 'destination context digest', { transfer, context })
  same(transfer.sourceRunId, sourceRunId, 'destination source run', { transfer, sourceRunId })
  same(transfer.destinationRunId, destinationRun.id, 'destination run', {
    transfer,
    destinationRun,
  })
  same(
    destinationRun.receipt.requested?.contextPlanDigest,
    context.digest,
    'destination requested context digest',
    { destinationRun, context },
  )
  if (text(transfer.sourceBoundary))
    same(transfer.sourceBoundary, sourceMessageId, 'destination source boundary', {
      transfer,
      sourceMessageId,
    })
  return {
    sourceRunId,
    sourceMessageId,
    contextDigest: context.digest,
    planDigest: plan.digest,
    transfer,
  }
}

export function assertUniqueRunIds(
  runIds,
  usedRunIds = new Set(),
  operation = 'release operation',
) {
  if (!Array.isArray(runIds) || runIds.some((runId) => !text(runId)))
    fail('LIVE_RELEASE_RUN_ID_MISSING', `${operation} omitted a run ID`, { runIds })
  for (const runId of runIds) {
    if (usedRunIds.has(runId))
      fail('LIVE_RELEASE_RUN_ID_REUSED', `${operation} reused a run ID`, { operation, runId })
    usedRunIds.add(runId)
  }
  return runIds
}

function providerSessionId(run) {
  return run?.providerSessionId ?? run?.receipt?.providerSessionId
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    )
  return value
}

function assertRecoveryIdentity(before, after, label) {
  if (!text(before?.id) || !text(after?.id) || before.id !== after.id)
    fail('LIVE_RELEASE_RESTART_IDENTITY_CHANGED', `${label} changed the local run identity`, {
      before,
      after,
    })
  const beforeSession = providerSessionId(before)
  const afterSession = providerSessionId(after)
  if (!text(beforeSession) || beforeSession !== afterSession)
    fail('LIVE_RELEASE_RESTART_SESSION_CHANGED', `${label} changed the provider session identity`, {
      before,
      after,
    })
  if (
    before.controlRef === undefined ||
    after.controlRef === undefined ||
    JSON.stringify(canonicalValue(before.controlRef)) !==
      JSON.stringify(canonicalValue(after.controlRef))
  )
    fail('LIVE_RELEASE_RESTART_CONTROL_CHANGED', `${label} changed the retained control identity`, {
      before,
      after,
    })
}

function assertSavedCursor(run, cursor, providerSequence, label) {
  if (run?.lastCursor !== cursor || run?.lastProviderSequence !== providerSequence)
    fail(
      'LIVE_RELEASE_RESTART_CURSOR_CHANGED',
      `${label} did not retain the saved provider cursor`,
      { cursor, providerSequence, run },
    )
}

export function assertRetainedRestartProof({
  runId,
  savedCursor,
  savedProviderSequence,
  beforeDetach,
  detached,
  reopened,
  final,
  reconnectResponse,
  replayEvent,
  terminalEvents,
}) {
  if (!text(runId) || beforeDetach?.id !== runId || detached?.id !== runId)
    fail(
      'LIVE_RELEASE_RESTART_RUN_ID_MISSING',
      'The restart proof lost the retained run identity',
      {
        runId,
        beforeDetach,
        detached,
      },
    )
  if (
    !text(savedCursor) ||
    !Number.isSafeInteger(savedProviderSequence) ||
    savedProviderSequence < 1
  )
    fail(
      'LIVE_RELEASE_RESTART_CURSOR_MISSING',
      'The restart proof did not save a provider cursor from an active stream',
      { savedCursor, savedProviderSequence, beforeDetach },
    )
  if (
    beforeDetach?.status === undefined ||
    !['running', 'waiting', 'streaming'].includes(beforeDetach.status)
  )
    fail('LIVE_RELEASE_RESTART_NOT_ACTIVE', 'The restart proof did not detach an active run', {
      beforeDetach,
    })
  if (detached?.status !== 'detached')
    fail('LIVE_RELEASE_RESTART_NOT_DETACHED', 'The restart proof did not persist a detached run', {
      detached,
    })
  if (reopened?.status !== 'detached')
    fail('LIVE_RELEASE_RESTART_NOT_REOPENED', 'The restart proof did not reopen the detached run', {
      reopened,
    })
  if (reconnectResponse?.type !== 'ack')
    fail('LIVE_RELEASE_RECONNECT_FAILED', 'The restart proof did not acknowledge reconnection', {
      reconnectResponse,
    })
  assertRecoveryIdentity(beforeDetach, detached, 'detach')
  assertRecoveryIdentity(beforeDetach, reopened, 'restart')
  assertRecoveryIdentity(beforeDetach, final, 'reconnect')
  assertSavedCursor(beforeDetach, savedCursor, savedProviderSequence, 'active stream')
  assertSavedCursor(detached, savedCursor, savedProviderSequence, 'detached state')
  assertSavedCursor(reopened, savedCursor, savedProviderSequence, 'reopened state')
  const replay = replayEvent?.event
  const provider = replay?.provider
  if (
    replay?.runId !== runId ||
    !text(provider?.cursor) ||
    provider.cursor === savedCursor ||
    !Number.isSafeInteger(provider.providerSequence) ||
    provider.providerSequence <= savedProviderSequence
  )
    fail(
      'LIVE_RELEASE_REPLAY_MISSING',
      'The restart proof did not replay a provider event after the saved cursor',
      { savedCursor, savedProviderSequence, replayEvent },
    )
  if (final?.status !== 'completed' || final.complete !== true)
    fail(
      'LIVE_RELEASE_RESTART_NOT_COMPLETED',
      'The retained run did not complete after reconnect',
      {
        final,
      },
    )
  if (terminalEvents !== 1)
    fail(
      'LIVE_RELEASE_RESTART_COMPLETION_DUPLICATED',
      'The retained run did not emit exactly one terminal completion',
      { terminalEvents },
    )
  return {
    runId,
    savedCursor,
    savedProviderSequence,
    providerSessionId: providerSessionId(final),
    controlRef: final.controlRef,
    replay: {
      kind: replay.kind,
      cursor: provider.cursor,
      providerSequence: provider.providerSequence,
    },
    terminalEvents,
  }
}
