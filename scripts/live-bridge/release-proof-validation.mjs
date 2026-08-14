import { exitCodes } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'

const ACTIVE_RUN_STATUSES = new Set(['running', 'waiting', 'streaming'])
const ACTIVE_PROGRESS_KINDS = new Set([
  'run.text.delta',
  'run.part.updated',
  'run.reasoning.delta',
  'run.tool.call',
  'run.tool.result',
  'run.artifact',
  'run.proposal',
  'run.interaction',
])

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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

export function terminalReceipts(responses, session, runId) {
  if (!Array.isArray(responses)) return []
  return responses.flatMap((response, responseIndex) => {
    if (
      response?.type !== 'event' ||
      response.event?.kind !== 'run.finished' ||
      response.event?.runId !== runId
    )
      return []
    const provider = response.event.provider
    return [
      {
        session,
        responseIndex,
        runId,
        sequence: response.sequence ?? null,
        revision: response.revision ?? null,
        status: response.event.status ?? null,
        providerEventId: provider?.eventId ?? null,
        providerSequence: provider?.providerSequence ?? null,
        cursor: provider?.cursor ?? null,
      },
    ]
  })
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

function assertForcedRestartProcess({ oldProcess, newProcess, forcedProcess }) {
  const oldPid = oldProcess?.pid
  const newPid = newProcess?.pid
  const forcedIdentity = forcedProcess?.processIdentity
  const termination = forcedProcess?.termination
  if (
    !text(oldProcess?.instanceId) ||
    !text(newProcess?.instanceId) ||
    oldProcess.instanceId === newProcess.instanceId ||
    !positiveInteger(oldPid) ||
    !positiveInteger(newPid) ||
    oldPid === newPid ||
    !positiveInteger(oldProcess?.startedAt) ||
    !positiveInteger(newProcess?.startedAt)
  )
    fail(
      'LIVE_RELEASE_RESTART_PROCESS_IDENTITY_INVALID',
      'The forced restart did not prove that a different RPC process was created',
      { oldProcess, newProcess },
    )
  if (forcedIdentity?.instanceId !== oldProcess.instanceId || forcedIdentity?.pid !== oldPid)
    fail(
      'LIVE_RELEASE_RESTART_PROCESS_IDENTITY_INVALID',
      'The termination receipt does not identify the process that was restarted',
      { oldProcess, forcedProcess },
    )
  if (termination?.initialExited !== false)
    fail(
      'LIVE_RELEASE_RESTART_PROCESS_NOT_LIVE',
      'The forced restart began after the original RPC process had already exited',
      { oldProcess, forcedProcess },
    )
  if (termination?.initialTree?.supported !== true || termination.initialTree.gone !== false)
    fail(
      'LIVE_RELEASE_RESTART_PROCESS_NOT_LIVE',
      'The forced restart did not observe the original process tree alive',
      { oldProcess, forcedProcess },
    )
  if (termination.termSent !== true && termination.killSent !== true)
    fail(
      'LIVE_RELEASE_RESTART_SIGNAL_MISSING',
      'The forced restart did not send a termination signal',
      { forcedProcess },
    )
  if (
    forcedProcess?.exit === undefined ||
    forcedProcess.exit.timeout === true ||
    (!Number.isSafeInteger(forcedProcess.exit.code) && !text(forcedProcess.exit.signal))
  )
    fail(
      'LIVE_RELEASE_RESTART_EXIT_UNCONFIRMED',
      'The forced restart did not observe the terminated RPC process exit',
      { forcedProcess },
    )
  if (
    termination.exited !== true ||
    termination.descendantsExited !== true ||
    termination.descendantsVerified !== true ||
    termination.cleanupStatus === 'already-exited'
  )
    fail(
      'LIVE_RELEASE_RESTART_CONTAINMENT_FAILED',
      'The forced restart did not prove signal-driven process-tree termination',
      { forcedProcess },
    )
  return {
    oldPid,
    newPid,
    oldProcessInstanceId: oldProcess.instanceId ?? null,
    newProcessInstanceId: newProcess.instanceId ?? null,
    signal: termination.killSent === true ? 'SIGKILL' : 'SIGTERM',
    initialExited: termination.initialExited,
    initialTree: termination.initialTree,
    cleanupStatus: termination.cleanupStatus,
  }
}

function assertActiveModelTiming(activeModel, runId) {
  const admission = activeModel?.admission
  const state = activeModel?.state
  const progress = activeModel?.progress
  if (
    admission?.runId !== runId ||
    typeof admission.requestId !== 'string' ||
    typeof admission.operationId !== 'string' ||
    !nonNegativeInteger(admission.responseIndex) ||
    !positiveInteger(admission.revision)
  )
    fail(
      'LIVE_RELEASE_RESTART_ACTIVE_ADMISSION_INVALID',
      'The restart proof omitted a canonical send acknowledgement boundary',
      { activeModel },
    )
  if (
    state?.runId !== runId ||
    state.activeRunId !== runId ||
    !ACTIVE_RUN_STATUSES.has(state.status) ||
    !nonNegativeInteger(state.responseIndex) ||
    state.responseIndex <= admission.responseIndex ||
    !positiveInteger(state.revision) ||
    state.revision < admission.revision
  )
    fail(
      'LIVE_RELEASE_RESTART_NOT_ACTIVE',
      'The restart proof did not observe the admitted run active after acknowledgement',
      { activeModel },
    )
  if (
    progress?.runId !== runId ||
    !ACTIVE_PROGRESS_KINDS.has(progress.kind) ||
    !nonNegativeInteger(progress.responseIndex) ||
    progress.responseIndex <= admission.responseIndex ||
    !positiveInteger(progress.providerSequence) ||
    !positiveInteger(progress.sequence) ||
    !positiveInteger(progress.revision)
  )
    fail(
      'LIVE_RELEASE_RESTART_ACTIVE_PROGRESS_INVALID',
      'The restart proof did not observe post-admission model progress',
      { activeModel },
    )
  return {
    admission: {
      runId,
      requestId: admission.requestId,
      operationId: admission.operationId,
      responseIndex: admission.responseIndex,
      revision: admission.revision,
    },
    state: {
      runId,
      activeRunId: state.activeRunId,
      status: state.status,
      responseIndex: state.responseIndex,
      revision: state.revision,
    },
    progress: {
      runId,
      kind: progress.kind,
      responseIndex: progress.responseIndex,
      sequence: progress.sequence,
      revision: progress.revision,
      providerSequence: progress.providerSequence,
      cursor: progress.cursor ?? null,
    },
  }
}

function assertReconnectBoundary({
  runId,
  savedCursor,
  savedProviderSequence,
  reopenedRevision,
  reconnectRequest,
  reconnectResponse,
  reconnectBoundary,
  replayEvent,
}) {
  if (
    reconnectRequest?.command !== 'reconnect' ||
    !text(reconnectRequest.requestId) ||
    !text(reconnectRequest.operationId) ||
    !positiveInteger(reopenedRevision) ||
    reconnectResponse?.type !== 'ack' ||
    reconnectResponse.requestId !== reconnectRequest.requestId ||
    reconnectResponse.command !== 'reconnect' ||
    reconnectResponse.operationId !== reconnectRequest.operationId ||
    (reconnectResponse.outcome !== undefined &&
      !['accepted', 'already-applied'].includes(reconnectResponse.outcome)) ||
    !positiveInteger(reconnectResponse.revision) ||
    reconnectResponse.revision <= reopenedRevision
  )
    fail(
      'LIVE_RELEASE_RECONNECT_FAILED',
      'The restart proof did not retain a causal reconnect acknowledgement',
      { reconnectRequest, reconnectResponse, reopenedRevision },
    )
  if (
    reconnectBoundary?.runId !== runId ||
    reconnectBoundary.kind !== 'run.reconnecting' ||
    !nonNegativeInteger(reconnectBoundary.responseIndex) ||
    !positiveInteger(reconnectBoundary.sequence) ||
    !positiveInteger(reconnectBoundary.revision) ||
    reconnectBoundary.savedCursor !== savedCursor ||
    reconnectBoundary.revision <= reopenedRevision ||
    reconnectBoundary.sequence > reconnectResponse.revision ||
    reconnectBoundary.revision > reconnectResponse.revision
  )
    fail(
      'LIVE_RELEASE_RECONNECT_BOUNDARY_MISSING',
      'The restart proof did not retain the durable reconnect boundary',
      { reconnectBoundary, reconnectResponse },
    )
  const provider = replayEvent?.event?.provider
  const nextProviderSequence = savedProviderSequence + 1
  if (
    replayEvent?.event?.runId !== runId ||
    replayEvent.kind !== replayEvent.event.kind ||
    replayEvent.kind === 'run.reconnecting' ||
    !nonNegativeInteger(replayEvent.responseIndex) ||
    replayEvent.responseIndex <= reconnectBoundary.responseIndex ||
    !positiveInteger(replayEvent.sequence) ||
    !positiveInteger(replayEvent.revision) ||
    replayEvent.sequence <= reconnectBoundary.sequence ||
    replayEvent.revision <= reconnectBoundary.revision ||
    replayEvent.sequence > reconnectResponse.revision ||
    replayEvent.revision > reconnectResponse.revision ||
    typeof provider?.cursor !== 'string' ||
    provider.cursor.length === 0 ||
    provider.cursor === reconnectBoundary.savedCursor ||
    !positiveInteger(provider.providerSequence) ||
    !Number.isSafeInteger(nextProviderSequence) ||
    provider.providerSequence !== nextProviderSequence
  )
    fail(
      'LIVE_RELEASE_REPLAY_MISSING',
      'The restart proof did not retain a provider event after the reconnect boundary',
      { reconnectBoundary, replayEvent, reconnectResponse },
    )
  return {
    requestId: reconnectRequest.requestId,
    operationId: reconnectRequest.operationId,
    ackRevision: reconnectResponse.revision,
    boundary: {
      runId,
      kind: reconnectBoundary.kind,
      responseIndex: reconnectBoundary.responseIndex,
      sequence: reconnectBoundary.sequence,
      revision: reconnectBoundary.revision,
      savedCursor: reconnectBoundary.savedCursor ?? null,
    },
    replay: {
      runId,
      kind: replayEvent.kind,
      responseIndex: replayEvent.responseIndex,
      sequence: replayEvent.sequence,
      revision: replayEvent.revision,
      providerSequence: provider.providerSequence,
      cursor: provider.cursor,
    },
  }
}

function assertTerminalUniqueness(terminalReceiptsValue, finalState, runId, terminalSession) {
  if (!Array.isArray(terminalReceiptsValue) || terminalReceiptsValue.length !== 1)
    fail(
      'LIVE_RELEASE_RESTART_COMPLETION_DUPLICATED',
      'The retained run did not have exactly one terminal event delivery across sessions',
      { terminalReceipts: terminalReceiptsValue },
    )
  const receipt = terminalReceiptsValue[0]
  const finalRun = finalState?.state?.runs?.find((run) => run?.id === runId)
  if (
    receipt.runId !== runId ||
    (terminalSession !== undefined && receipt.session !== terminalSession) ||
    receipt.status !== 'completed' ||
    !text(receipt.providerEventId) ||
    !positiveInteger(receipt.providerSequence) ||
    !text(receipt.cursor) ||
    !positiveInteger(receipt.sequence) ||
    !positiveInteger(receipt.revision) ||
    !positiveInteger(finalState?.revision) ||
    !positiveInteger(finalState?.state?.revision) ||
    finalRun?.status !== 'completed' ||
    finalRun.complete !== true ||
    receipt.sequence > finalState.state.revision ||
    receipt.revision > finalState.state.revision
  )
    fail(
      'LIVE_RELEASE_RESTART_TERMINAL_NOT_DURABLE',
      'The terminal event receipt is not represented by the durable final state',
      { receipt, finalState },
    )
  return {
    deliveryCount: terminalReceiptsValue.length,
    receipt,
    durableRevision: finalState.state.revision,
  }
}

export function assertRetainedRestartProof({
  runId,
  savedCursor,
  savedProviderSequence,
  beforeDetach,
  detached,
  reopened,
  final,
  oldProcess,
  newProcess,
  forcedProcess,
  activeModel,
  reopenedRevision,
  reconnectRequest,
  reconnectResponse,
  reconnectBoundary,
  replayEvent,
  terminalReceipts: terminalReceiptsValue,
  finalState,
  terminalSession,
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
  if (!text(terminalSession))
    fail(
      'LIVE_RELEASE_RESTART_TERMINAL_SESSION_MISSING',
      'The restart proof omitted the session that must deliver the terminal event',
      { terminalSession },
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
  const activeEvidence = assertActiveModelTiming(activeModel, runId)
  if (beforeDetach?.status === undefined || !ACTIVE_RUN_STATUSES.has(beforeDetach.status))
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
  const processEvidence = assertForcedRestartProcess({
    oldProcess,
    newProcess,
    forcedProcess,
  })
  assertRecoveryIdentity(beforeDetach, detached, 'detach')
  assertRecoveryIdentity(beforeDetach, reopened, 'restart')
  assertRecoveryIdentity(beforeDetach, final, 'reconnect')
  assertSavedCursor(beforeDetach, savedCursor, savedProviderSequence, 'active stream')
  assertSavedCursor(detached, savedCursor, savedProviderSequence, 'detached state')
  assertSavedCursor(reopened, savedCursor, savedProviderSequence, 'reopened state')
  const reconnectEvidence = assertReconnectBoundary({
    runId,
    savedCursor,
    savedProviderSequence,
    reopenedRevision,
    reconnectRequest,
    reconnectResponse,
    reconnectBoundary,
    replayEvent,
  })
  if (reconnectEvidence.replay.providerSequence <= savedProviderSequence)
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
  const terminalEvidence = assertTerminalUniqueness(
    terminalReceiptsValue,
    finalState,
    runId,
    terminalSession,
  )
  return {
    runId,
    savedCursor,
    savedProviderSequence,
    providerSessionId: providerSessionId(final),
    controlRef: final.controlRef,
    process: processEvidence,
    activeModel: activeEvidence,
    reconnect: reconnectEvidence,
    terminal: terminalEvidence,
  }
}
