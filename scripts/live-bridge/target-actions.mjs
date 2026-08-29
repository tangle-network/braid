import { exitCodes, livePrompts } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { sleep } from './process.mjs'
import {
  assertSemanticOutcome,
  cancelSemanticStatus,
  capabilityAdvertised,
  capabilityAvailability,
  exactMarker,
  interactionFromResponse,
  requestBase,
  responseForRequest,
  retainedCancellationAdvertised,
  runFromState,
  runWithAdmissionReceipt,
  semanticCommandStatus,
  stateForRequest,
  stateForRun,
  targetCapabilities,
  terminalMessage,
} from './protocol.mjs'
import { evidenceValue, redactString } from './redaction.mjs'

export async function initializeTarget(
  session,
  result,
  classifyStartup,
  { operationPrefix = 'live' } = {},
) {
  const initialize = {
    ...requestBase(
      operationPrefix === 'live'
        ? `init-${result.targetKey}`
        : `${operationPrefix}-init-${result.targetKey}`,
      'initialize',
    ),
    params: { workspace: result.workspace, subscribe: true },
  }
  result.requests.push(evidenceValue(initialize))
  session.send(initialize)
  const initializeResponse = await session.waitFor(
    'initialize acknowledgement',
    responseForRequest(initialize.requestId),
  )
  result.initialize = evidenceValue(initializeResponse)
  if (initializeResponse.type === 'error') {
    throw classifyStartup(initializeResponse, session.stderr)
  }
  const initialState = await session.waitFor(
    'initialize state',
    (response) => response.type === 'state' && response.requestId === initialize.requestId,
    15_000,
  )
  if (
    typeof initialState.state?.conversationId !== 'string' ||
    typeof initialState.state?.branchId !== 'string'
  ) {
    throw new LiveBridgeError(
      'LIVE_INITIAL_STATE_INVALID',
      'Packed Braid did not return an active conversation and branch',
      exitCodes.failed,
      { state: initialState },
    )
  }
  result.conversationId = initialState.state.conversationId
  result.branchId = initialState.state.branchId
  result.initialCapabilities = evidenceValue(targetCapabilities(initialState, initialState.state))
}

function requestIdFor(operationPrefix, action, targetKey) {
  return operationPrefix === 'live'
    ? `${action}-${targetKey}`
    : `${operationPrefix}-${action}-${targetKey}`
}

function operationIdFor(operationPrefix, action, targetKey) {
  return `op-${operationPrefix}-${action}-${targetKey}`
}

export async function runNormalTurn(
  session,
  result,
  target,
  timeoutMs,
  { operationPrefix = 'live', prompt, marker } = {},
) {
  const normalPrompt = prompt ?? livePrompts.normal(target.key)
  const expectedMarker = marker ?? `LIVE_BRAID_${target.key.toUpperCase().replaceAll('.', '_')}_OK`
  const send = {
    ...requestBase(
      requestIdFor(operationPrefix, 'send', target.key),
      'send',
      operationIdFor(operationPrefix, 'send', target.key),
    ),
    params: {
      conversationId: result.conversationId,
      branchId: result.branchId,
      text: normalPrompt,
    },
  }
  result.requests.push(evidenceValue(send))
  session.send(send)
  const sendResponse = await session.waitFor(
    'normal send acknowledgement',
    responseForRequest(send.requestId),
  )
  result.send = evidenceValue(sendResponse)
  if (sendResponse.type === 'error' || typeof sendResponse.runId !== 'string') {
    throw new LiveBridgeError(
      'LIVE_SEND_FAILED',
      `Packed Braid did not admit a live ${target.definition.label} turn`,
      exitCodes.failed,
      { response: sendResponse },
    )
  }
  const runId = sendResponse.runId
  const activeState = await session
    .waitFor(
      'active run state',
      (response) =>
        response.type === 'state' &&
        response.requestId === send.requestId &&
        response.state?.activeRunId === runId,
      15_000,
    )
    .catch(() => undefined)
  result.activeCapabilities =
    activeState === undefined
      ? undefined
      : evidenceValue(targetCapabilities(activeState, activeState.state))
  const terminal = await session.waitFor(
    'normal final state',
    (response) => response.requestId === send.requestId && stateForRun(response, runId),
    timeoutMs,
  )
  const finalRun = runWithAdmissionReceipt(
    runFromState(terminal.state, runId),
    sendResponse.admission,
  )
  const finalMessage = terminalMessage(terminal.state, runId)
  const markerObserved = exactMarker(finalMessage?.text, expectedMarker)
  result.normal = {
    status: finalRun?.status,
    runId,
    run: evidenceValue(finalRun),
    assistant: evidenceValue(finalMessage),
    finalText: finalMessage?.text === undefined ? undefined : redactString(finalMessage.text),
    marker: expectedMarker,
    markerObserved,
    prompt: normalPrompt,
  }
  if (
    finalRun?.status !== 'completed' ||
    typeof finalMessage?.text !== 'string' ||
    finalMessage.text.trim() === '' ||
    !markerObserved
  ) {
    throw new LiveBridgeError(
      markerObserved ? 'LIVE_FINAL_OUTPUT_MISSING' : 'LIVE_FINAL_OUTPUT_MISMATCH',
      markerObserved
        ? `Packed Braid ${target.definition.label} turn did not produce a completed assistant message`
        : `Packed Braid ${target.definition.label} turn completed without the expected response marker`,
      exitCodes.failed,
      { run: finalRun, assistant: finalMessage },
    )
  }
  return { finalRun, runId, terminal }
}

export async function verifyCancel(
  session,
  result,
  target,
  finalRun,
  providerCapabilities,
  { operationPrefix = 'live', timeoutMs = 30_000 } = {},
) {
  const advertisedByNormalAdmission =
    result.send?.admission?.capabilities?.controls?.cancel === true
  const advertisedByNormalRun = finalRun?.capabilities?.controls?.cancel === true
  const advertisedByProvider = retainedCancellationAdvertised(providerCapabilities)
  if (!advertisedByProvider && !advertisedByNormalAdmission && !advertisedByNormalRun) {
    const availability = capabilityAvailability(advertisedByProvider, false)
    const cancel = {
      ...requestBase(
        requestIdFor(operationPrefix, 'cancel', target.key),
        'cancel_run',
        operationIdFor(operationPrefix, 'cancel', target.key),
      ),
      params: { runId: finalRun.id, reason: 'live packed smoke cancellation' },
    }
    result.requests.push(evidenceValue(cancel))
    session.send(cancel)
    const cancelResponse = await session.waitFor(
      'unavailable cancel result',
      responseForRequest(cancel.requestId),
      timeoutMs,
    )
    result.cancel = {
      attemptedRun: false,
      response: evidenceValue(cancelResponse),
      advertisedByProvider: availability.advertisedByProvider,
      advertisedByNormalAdmission,
      advertisedByNormalRun,
      advertisedByRun: false,
      advertised: false,
      status: cancelSemanticStatus(cancelResponse, finalRun, false),
    }
    return
  }
  const cancelPrompt = livePrompts.cancel(target.key)
  const cancelSend = {
    ...requestBase(
      requestIdFor(operationPrefix, 'cancel-send', target.key),
      'send',
      operationIdFor(operationPrefix, 'cancel-send', target.key),
    ),
    params: {
      conversationId: result.conversationId,
      branchId: result.branchId,
      text: cancelPrompt,
    },
  }
  result.requests.push(evidenceValue(cancelSend))
  session.send(cancelSend)
  const cancelSendResponse = await session.waitFor(
    'cancel test send acknowledgement',
    responseForRequest(cancelSend.requestId),
  )
  result.cancel = { prompt: cancelPrompt, send: evidenceValue(cancelSendResponse) }
  if (cancelSendResponse.type !== 'ack' || typeof cancelSendResponse.runId !== 'string') {
    result.cancel.advertisedByProvider = advertisedByProvider
    result.cancel.advertisedByNormalAdmission = advertisedByNormalAdmission
    result.cancel.advertisedByNormalRun = advertisedByNormalRun
    result.cancel.advertised =
      advertisedByProvider || advertisedByNormalAdmission || advertisedByNormalRun
    result.cancel.status = 'not-admitted'
    return
  }
  const advertisedByRun = cancelSendResponse.admission?.capabilities?.controls?.cancel === true
  const availability = capabilityAvailability(advertisedByProvider, advertisedByRun)
  result.cancel.advertisedByProvider = availability.advertisedByProvider
  result.cancel.advertisedByNormalAdmission = advertisedByNormalAdmission
  result.cancel.advertisedByNormalRun = advertisedByNormalRun
  result.cancel.advertisedByRun = advertisedByRun
  result.cancel.advertised = availability.advertised
  result.cancel.runId = cancelSendResponse.runId
  const activeStateResponse = await session
    .waitFor(
      'active cancel test state',
      (response) => {
        if (response.type !== 'state') return false
        const run = runFromState(response.state, cancelSendResponse.runId)
        return ['running', 'waiting', 'streaming'].includes(run?.status)
      },
      timeoutMs,
    )
    .catch(() => undefined)
  const activeCancelRun = runFromState(activeStateResponse?.state, cancelSendResponse.runId)
  result.cancel.activeRun = evidenceValue(activeCancelRun)
  if (availability.advertised && activeCancelRun === undefined) {
    result.cancel.attemptedRun = true
    result.cancel.status = 'advertised-but-not-active'
    return
  }
  await sleep(25)
  const cancel = {
    ...requestBase(
      requestIdFor(operationPrefix, 'cancel', target.key),
      'cancel_run',
      operationIdFor(operationPrefix, 'cancel', target.key),
    ),
    params: { runId: cancelSendResponse.runId, reason: 'live packed smoke cancellation' },
  }
  result.requests.push(evidenceValue(cancel))
  session.send(cancel)
  const cancelResponse = await session.waitFor(
    'cancel acknowledgement',
    responseForRequest(cancel.requestId),
    30_000,
  )
  result.cancel.response = evidenceValue(cancelResponse)
  if (!availability.advertised) {
    result.cancel.attemptedRun = true
    result.cancel.status = cancelSemanticStatus(cancelResponse, undefined, false)
    return
  }
  const cancelStateResponse = await session
    .waitFor(
      'confirmed cancel terminal state',
      (response) => {
        if (response.type !== 'state') return false
        const run = runFromState(response.state, cancelSendResponse.runId)
        return run?.status === 'cancelled' || run?.status === 'aborted'
      },
      timeoutMs,
    )
    .catch(() => undefined)
  const cancelledRun = runFromState(cancelStateResponse?.state, cancelSendResponse.runId)
  result.cancel.run = evidenceValue(cancelledRun)
  result.cancel.attemptedRun = true
  result.cancel.status = cancelSemanticStatus(cancelResponse, cancelledRun, availability.advertised)
}

export async function verifyInteraction(
  session,
  result,
  providerCapabilities,
  terminal,
  { operationPrefix = 'live', runId } = {},
) {
  const interaction = interactionFromResponse(terminal, runId)
  const interactionCapability = terminal.view?.capabilities?.['interaction.respond']
  const advertisedByBraid = capabilityAdvertised(interactionCapability)
  const availability = capabilityAvailability(providerCapabilities.interactions, advertisedByBraid)
  if (interaction === undefined) {
    result.interaction = {
      status: availability.advertised ? 'advertised-but-not-emitted' : 'reported-unavailable',
      advertisedByProvider: availability.advertisedByProvider,
      advertisedByBraid,
      advertised: availability.advertised,
      provider: evidenceValue(providerCapabilities.interactions),
      braid: evidenceValue(interactionCapability),
      attempted: false,
    }
    return
  }
  const response = {
    ...requestBase(
      requestIdFor(operationPrefix, 'interaction', result.targetKey),
      'respond_interaction',
      operationIdFor(operationPrefix, 'interaction', result.targetKey),
    ),
    params: {
      runId: interaction.runId,
      interactionId: interaction.interactionId,
      response: { id: interaction.interactionId, outcome: 'declined' },
    },
  }
  result.requests.push(evidenceValue(response))
  session.send(response)
  const interactionResponse = await session.waitFor(
    'interaction response',
    responseForRequest(response.requestId),
    30_000,
  )
  result.interaction = {
    status: semanticCommandStatus(interactionResponse, availability.advertised),
    advertisedByProvider: availability.advertisedByProvider,
    advertisedByBraid,
    advertised: availability.advertised,
    provider: evidenceValue(providerCapabilities.interactions),
    braid: evidenceValue(interactionCapability),
    attempted: true,
    runId: interaction.runId,
    response: evidenceValue(interactionResponse),
  }
}

export function assertTargetSemantics(result, { strict = false } = {}) {
  for (const [name, capability] of [
    ['cancel', result.cancel],
    ['interaction', result.interaction],
  ]) {
    assertSemanticOutcome(name, capability.status, capability.advertised, { capability })
    if (strict && name === 'cancel' && capability.status !== 'verified')
      throw new LiveBridgeError(
        'LIVE_RELEASE_REQUIRED_PROOF_MISSING',
        `${name} did not produce a verified live proof`,
        exitCodes.failed,
        { capability },
      )
  }
  result.semanticAssertions = {
    cancel: result.cancel.status,
    interaction: result.interaction.status,
  }
}

export async function finishTarget(session, result, { operationPrefix = 'live' } = {}) {
  const finalStateRequest = {
    ...requestBase(requestIdFor(operationPrefix, 'final-state', result.targetKey), 'get_state'),
    params: { projection: 'full' },
  }
  result.requests.push(evidenceValue(finalStateRequest))
  session.send(finalStateRequest)
  result.finalState = evidenceValue(
    await session.waitFor('final state', stateForRequest(finalStateRequest.requestId), 15_000),
  )
  const shutdown = {
    ...requestBase(
      requestIdFor(operationPrefix, 'shutdown', result.targetKey),
      'shutdown',
      operationIdFor(operationPrefix, 'shutdown', result.targetKey),
    ),
    params: { mode: 'wait' },
  }
  result.requests.push(evidenceValue(shutdown))
  session.send(shutdown)
  result.shutdown = evidenceValue(
    await session.waitFor(
      'shutdown acknowledgement',
      responseForRequest(shutdown.requestId),
      15_000,
    ),
  )
}
