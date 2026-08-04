import { exitCodes } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'

export function requestBase(requestId, command, operationId) {
  return {
    version: 1,
    requestId,
    ...(operationId === undefined ? {} : { operationId }),
    command,
  }
}

export function responseForRequest(requestId) {
  return (response) =>
    response.requestId === requestId && (response.type === 'ack' || response.type === 'error')
}

export function stateForRequest(requestId) {
  return (response) => response.requestId === requestId && response.type === 'state'
}

export function stateForRun(response, runId) {
  if (response.type !== 'state' || !response.state) return false
  const run = response.state.runs?.find((candidate) => candidate.id === runId)
  return (
    run !== undefined &&
    ['completed', 'failed', 'aborted', 'cancelled', 'unknown'].includes(run.status)
  )
}

export function runFromState(state, runId) {
  return state?.runs?.find((run) => run.id === runId)
}

export function terminalMessage(state, runId) {
  return (
    state?.messages?.findLast?.(
      (message) => message.runId === runId && message.role === 'assistant',
    ) ??
    [...(state?.messages ?? [])]
      .reverse()
      .find((message) => message.runId === runId && message.role === 'assistant')
  )
}

export function targetCapabilities(stateResponse, terminalState) {
  const view = stateResponse?.view ?? {}
  const run = terminalState?.runs?.at(-1)
  return {
    view: view.capabilities ?? {},
    analysisAsk: view.capabilities?.['analysis.ask'],
    run: run?.capabilities ?? {},
  }
}

export function exactMarker(value, marker) {
  return typeof value === 'string' && value.trim() === marker
}

export function capabilityAdvertised(value) {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  return typeof value === 'object' && value.available !== false
}

export function assertSemanticOutcome(name, status, advertised, details = {}) {
  const expected = advertised ? 'verified' : 'reported-unavailable'
  if (status === expected) return
  throw new LiveBridgeError(
    'LIVE_CAPABILITY_CONTRADICTION',
    `${name} capability reported ${status}; expected ${expected}`,
    exitCodes.failed,
    { name, status, advertised, ...details },
  )
}

export function classifyPackedStartup(response, stderr) {
  const message = `${response.message ?? ''} ${stderr}`
  if (
    /CREDENTIAL_STORE_UNAVAILABLE|operating-system credential facility|credential store/iu.test(
      message,
    )
  ) {
    return new LiveBridgeError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'The packed Braid production path cannot access its operating-system credential store',
      exitCodes.unavailable,
      { response, stderr },
    )
  }
  return new LiveBridgeError(
    'PACKED_STARTUP_FAILED',
    'The packed Braid production path rejected initialization',
    exitCodes.failed,
    { response, stderr },
  )
}

export function semanticCommandStatus(response, advertised) {
  if (advertised) return response.type === 'ack' ? 'verified' : 'advertised-but-rejected'
  return response.type === 'error' && response.code === 'CAPABILITY_UNAVAILABLE'
    ? 'reported-unavailable'
    : 'unexpected'
}

export function cancelSemanticStatus(response, run, advertised) {
  if (advertised) {
    if (response.type !== 'ack') return 'advertised-but-rejected'
    return ['aborted', 'cancelled'].includes(run?.status)
      ? 'verified'
      : 'advertised-but-not-terminal-cancelled'
  }
  if (response.type === 'error' && response.code === 'CAPABILITY_UNAVAILABLE')
    return 'reported-unavailable'
  return ['aborted', 'cancelled'].includes(run?.status)
    ? 'observed-without-advertisement'
    : 'unexpected'
}
