import { exitCodes, livePrompts } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { sleep } from './process.mjs'
import {
  assertSemanticOutcome,
  cancelSemanticStatus,
  capabilityAdvertised,
  capabilityAvailability,
  exactMarker,
  requestBase,
  responseForRequest,
  runFromState,
  semanticCommandStatus,
  stateForRequest,
  stateForRun,
  targetCapabilities,
  terminalMessage,
} from './protocol.mjs'
import { evidenceValue, redactString } from './redaction.mjs'

export async function initializeTarget(session, result, classifyStartup) {
  const initialize = {
    ...requestBase(`init-${result.targetKey}`, 'initialize'),
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

export async function runNormalTurn(session, result, target, timeoutMs) {
  const normalPrompt = livePrompts.normal(target.key)
  const marker = `LIVE_BRAID_${target.key.toUpperCase().replaceAll('.', '_')}_OK`
  const send = {
    ...requestBase(`send-${target.key}`, 'send', `op-live-send-${target.key}`),
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
  const finalRun = runFromState(terminal.state, runId)
  const finalMessage = terminalMessage(terminal.state, runId)
  const markerObserved = exactMarker(finalMessage?.text, marker)
  result.normal = {
    status: finalRun?.status,
    runId,
    run: evidenceValue(finalRun),
    assistant: evidenceValue(finalMessage),
    finalText: finalMessage?.text === undefined ? undefined : redactString(finalMessage.text),
    marker,
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

export async function verifyReconnect(session, result, runId, finalRun, providerCapabilities) {
  const reconnect = {
    ...requestBase(
      `reconnect-${result.targetKey}`,
      'reconnect',
      `op-live-reconnect-${result.targetKey}`,
    ),
    params: { runId },
  }
  result.requests.push(evidenceValue(reconnect))
  session.send(reconnect)
  const reconnectResponse = await session.waitFor(
    'reconnect result',
    responseForRequest(reconnect.requestId),
    30_000,
  )
  const advertisedByRun = Boolean(
    finalRun?.capabilities?.streaming?.replay && finalRun?.capabilities?.events?.cursor,
  )
  const availability = capabilityAvailability(
    providerCapabilities.streaming?.replay,
    advertisedByRun,
  )
  result.reconnect = {
    advertisedByProvider: availability.advertisedByProvider,
    advertisedByRun,
    advertised: availability.advertised,
    response: evidenceValue(reconnectResponse),
    status: semanticCommandStatus(reconnectResponse, availability.advertised),
  }
}

export async function verifyCancel(session, result, target, finalRun, providerCapabilities) {
  const advertisedByRun = finalRun?.capabilities?.controls?.cancel === true
  const availability = capabilityAvailability(
    providerCapabilities.controls?.cancel,
    advertisedByRun,
  )
  if (!availability.advertised) {
    const cancel = {
      ...requestBase(`cancel-${target.key}`, 'cancel_run', `op-live-cancel-${target.key}`),
      params: { runId: finalRun.id, reason: 'live packed smoke cancellation' },
    }
    result.requests.push(evidenceValue(cancel))
    session.send(cancel)
    const cancelResponse = await session.waitFor(
      'unavailable cancel result',
      responseForRequest(cancel.requestId),
      30_000,
    )
    result.cancel = {
      attemptedRun: false,
      response: evidenceValue(cancelResponse),
      advertisedByProvider: availability.advertisedByProvider,
      advertisedByRun,
      advertised: false,
      status: cancelSemanticStatus(cancelResponse, finalRun, false),
    }
    return
  }
  const cancelPrompt = livePrompts.cancel(target.key)
  const cancelSend = {
    ...requestBase(`cancel-send-${target.key}`, 'send', `op-live-cancel-send-${target.key}`),
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
    result.cancel.status = 'not-admitted'
    return
  }
  await sleep(25)
  const cancel = {
    ...requestBase(`cancel-${target.key}`, 'cancel_run', `op-live-cancel-${target.key}`),
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
  const cancelStateResponse = await session
    .waitFor(
      'cancel terminal state',
      (response) =>
        response.requestId === cancel.requestId && stateForRun(response, cancelSendResponse.runId),
      30_000,
    )
    .catch(() => undefined)
  const cancelledRun = runFromState(cancelStateResponse?.state, cancelSendResponse.runId)
  result.cancel.run = evidenceValue(cancelledRun)
  result.cancel.attemptedRun = true
  result.cancel.advertisedByProvider = availability.advertisedByProvider
  result.cancel.advertisedByRun = advertisedByRun
  result.cancel.advertised = availability.advertised
  result.cancel.status = cancelSemanticStatus(cancelResponse, cancelledRun, availability.advertised)
}

export async function verifyInteraction(session, result, providerCapabilities, terminal) {
  const interaction = terminal.view?.interactions?.[0]
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
      `interaction-${result.targetKey}`,
      'respond_interaction',
      `op-live-interaction-${result.targetKey}`,
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
    response: evidenceValue(interactionResponse),
  }
}

export function assertTargetSemantics(result) {
  for (const [name, capability] of [
    ['reconnect', result.reconnect],
    ['cancel', result.cancel],
    ['interaction', result.interaction],
  ]) {
    assertSemanticOutcome(name, capability.status, capability.advertised, { capability })
  }
  result.semanticAssertions = {
    reconnect: result.reconnect.status,
    cancel: result.cancel.status,
    interaction: result.interaction.status,
  }
}

export async function finishTarget(session, result) {
  const finalStateRequest = {
    ...requestBase(`final-state-${result.targetKey}`, 'get_state'),
    params: { projection: 'full' },
  }
  result.requests.push(evidenceValue(finalStateRequest))
  session.send(finalStateRequest)
  result.finalState = evidenceValue(
    await session.waitFor('final state', stateForRequest(finalStateRequest.requestId), 15_000),
  )
  const shutdown = {
    ...requestBase(
      `shutdown-${result.targetKey}`,
      'shutdown',
      `op-live-shutdown-${result.targetKey}`,
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
