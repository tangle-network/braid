import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AgentEnvironmentCapabilitiesSchema,
  AgentExactRunControlRefSchema,
  AgentNativeContextContinuationAdmissionSchema,
  AgentNativeContextContinuationResultSchema,
  AgentRunCancellationAcknowledgementSchema,
  AgentRunCancellationRequestSchema,
  agentNativeContextContinuationAdmissionMatchesRequest,
  agentNativeContextContinuationResultMatchesRequest,
  agentRunCancellationAcknowledgementMatchesRequest,
  agentRunCancellationRequestDigest,
  NativeContextBoundaryProofSchema,
  NativeContextContinuationRequestSchema,
  NativeContextContinuationTurnSchema,
  nativeContextContinuationRequestDigest,
  nativeContextContinuationTurnDigest,
} from '@tangle-network/agent-interface'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'

import { defaultTimeoutMs, exitCodes, repository } from './constants.mjs'
import {
  bridgeAuthToken,
  endpointForEvidence,
  healthBackendsReady,
  requestJson,
  safeEndpoint,
} from './endpoint.mjs'
import { LiveBridgeError } from './errors.mjs'
import { errorEvidence, writeEvidence } from './evidence.mjs'
import { evidenceValue, redactString } from './redaction.mjs'

export const NATIVE_CONTINUATION_RECEIPT_SCHEMA = 'braid.live-bridge.native-continuation.v1'
export const NATIVE_CONTINUATION_MODEL = 'pi/tangle-router/deepseek-v4-flash'
export const NATIVE_CONTINUATION_EVIDENCE_PATH = join(
  repository,
  'artifacts',
  'verification',
  'live',
  'bridge',
  'native-continuation.json',
)

const DEFAULT_FIRST_PROMPT = 'Reply exactly with: Braid live continuation first complete.'
const DEFAULT_CANCEL_PROMPT =
  'Use the terminal to run `sleep 30`. After it finishes, reply exactly: cancelled continuation.'
const DEFAULT_SUCCESS_PROMPT = 'Reply exactly with: Braid live continuation success.'
const DEFAULT_EVENT_TIMEOUT_MS = 3_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_MAX_SSE_EVENTS = 12
const RUNNER_NAME = 'pi'
const ROUTER_PROVIDER = 'tangle-router'

export function nativeContinuationTarget(route) {
  const prefix = `${RUNNER_NAME}/${ROUTER_PROVIDER}/`
  if (typeof route !== 'string' || !route.startsWith(prefix)) return undefined
  const model = route.slice(prefix.length)
  if (model.length === 0) return undefined
  return { route, runner: RUNNER_NAME, provider: ROUTER_PROVIDER, model }
}

function recordValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function fail(code, message, details = {}, exitCode = exitCodes.failed) {
  throw new LiveBridgeError(code, message, exitCode, details)
}

function assertCondition(condition, code, message, details = {}, exitCode = exitCodes.failed) {
  if (!condition) fail(code, message, details, exitCode)
}

function responseFailureDetails(response) {
  return {
    status: response?.status,
    ...(response?.error === undefined ? {} : { error: response.error }),
  }
}

function requireResponse(response, expectedStatus, label, { unavailable = false } = {}) {
  if (response?.status === expectedStatus && response.ok === true) return response
  fail(
    unavailable ? 'LIVE_NATIVE_BRIDGE_UNAVAILABLE' : 'LIVE_NATIVE_REQUEST_FAILED',
    `${label} returned an unexpected response`,
    responseFailureDetails(response),
    unavailable ? exitCodes.unavailable : exitCodes.failed,
  )
}

function assertRunCoordinates(reference, label = 'run reference') {
  try {
    return AgentExactRunControlRefSchema.parse(reference)
  } catch (error) {
    fail('LIVE_NATIVE_RUN_IDENTITY_INVALID', `${label} is not an exact run reference`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

function assertBoundaryCoordinates(boundary, reference) {
  assertCondition(
    boundary.runId === reference.runId &&
      boundary.provider === reference.provider &&
      boundary.environmentId === reference.environmentId &&
      boundary.sessionId === reference.sessionId &&
      boundary.executionId === reference.executionId &&
      boundary.requestDigest === reference.requestDigest,
    'LIVE_NATIVE_BOUNDARY_IDENTITY_MISMATCH',
    'native context boundary does not bind to the source run',
  )
}

function advancedReference(source, candidate) {
  return (
    candidate.provider === source.provider &&
    candidate.environmentId === source.environmentId &&
    candidate.sessionId === source.sessionId &&
    (candidate.runId !== source.runId || candidate.executionId !== source.executionId)
  )
}

function statusSummary(body) {
  const value = recordValue(body)
  if (!value) return undefined
  return {
    status: stringValue(value.status),
    terminal: typeof value.terminal === 'boolean' ? value.terminal : undefined,
    state: stringValue(value.state),
    canonicalLastSeq: Number.isSafeInteger(value.canonicalLastSeq)
      ? value.canonicalLastSeq
      : undefined,
  }
}

function sessionIdentitySummary(body) {
  const value = recordValue(body)
  if (!value) return undefined
  return {
    id: stringValue(value.id),
    backend: stringValue(value.backend),
    model: stringValue(value.model),
    status: stringValue(value.status),
    runId: stringValue(value.runId ?? value.run_id),
  }
}

async function readSessionIdentity(endpoint, sessionId, token, timeoutMs) {
  const response = await requestJson(
    endpoint,
    `/v1/sessions/${encodeURIComponent(sessionId)}`,
    token,
    Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
  )
  requireResponse(response, 200, `session ${sessionId} identity`)
  const session = sessionIdentitySummary(response.body)
  assertCondition(
    session?.id === sessionId &&
      session.backend === RUNNER_NAME &&
      nativeContinuationTarget(session.model) !== undefined,
    'LIVE_NATIVE_SESSION_IDENTITY_MISMATCH',
    'CLI Bridge session identity did not retain the requested Pi model route',
    { session },
  )
  return session
}

function referenceSummary(reference) {
  const parsed = assertRunCoordinates(reference)
  return {
    runId: parsed.runId,
    provider: parsed.provider,
    environmentId: parsed.environmentId,
    sessionId: parsed.sessionId,
    executionId: parsed.executionId,
    requestDigest: parsed.requestDigest,
  }
}

function boundarySummary(boundary) {
  const parsed = NativeContextBoundaryProofSchema.parse(boundary)
  return {
    runId: parsed.runId,
    provider: parsed.provider,
    environmentId: parsed.environmentId,
    sessionId: parsed.sessionId,
    executionId: parsed.executionId,
    requestDigest: parsed.requestDigest,
    kind: parsed.boundary.kind,
    observedAt: parsed.observedAt,
  }
}

function capabilitySummary(capabilities) {
  return evidenceValue({
    nativeContinuation: capabilities.nativeContinuation,
    retainedControl: capabilities.retainedControl,
    streaming: capabilities.streaming,
    sessions: capabilities.sessions,
    interactions: capabilities.interactions,
  })
}

function assertNativeCapabilities(capabilities) {
  const parsed = AgentEnvironmentCapabilitiesSchema.parse(capabilities)
  const retained = parsed.retainedControl
  const native = parsed.nativeContinuation
  assertCondition(
    parsed.sessions.continue === true &&
      parsed.streaming.live === true &&
      parsed.streaming.replay === true &&
      parsed.streaming.detach === true &&
      parsed.streaming.turnIdempotency === true,
    'LIVE_NATIVE_CAPABILITY_INCOMPLETE',
    'CLI Bridge did not advertise the complete retained stream contract',
  )
  assertCondition(
    retained?.exactRunIdentity === true &&
      retained.resultIdentity === true &&
      retained.eventIdentity === true &&
      retained.cancellationIdempotency === true,
    'LIVE_NATIVE_CAPABILITY_INCOMPLETE',
    'CLI Bridge did not advertise exact retained-run controls',
  )
  assertCondition(
    native?.atomicBoundary === true &&
      native.requestIdempotency === true &&
      native.admissionControl === true,
    'LIVE_NATIVE_CAPABILITY_INCOMPLETE',
    'CLI Bridge did not advertise native admission control',
  )
  return parsed
}

/** Build the canonical native continuation request used by the live check. */
export function nativeContinuationRequest({ operationId, run, expectedBoundary, prompt }) {
  const turn = { prompt }
  const material = {
    operationId,
    turnDigest: nativeContextContinuationTurnDigest(turn),
    run: assertRunCoordinates(run),
    expectedBoundary: NativeContextBoundaryProofSchema.parse(expectedBoundary),
  }
  const request = NativeContextContinuationRequestSchema.parse({
    ...material,
    requestDigest: nativeContextContinuationRequestDigest(material),
  })
  return { request, turn }
}

/** Build the canonical exact cancellation request used by the live check. */
export function exactCancellationRequest({ operationId, run, reason }) {
  const material = {
    operationId,
    run: assertRunCoordinates(run),
    ...(reason === undefined ? {} : { reason }),
  }
  return AgentRunCancellationRequestSchema.parse({
    ...material,
    requestDigest: agentRunCancellationRequestDigest(material),
  })
}

/** Encode one continuation body without provider-specific fields. */
export function nativeContinuationBody(input) {
  const request = NativeContextContinuationRequestSchema.parse(input.request)
  const turn = NativeContextContinuationTurnSchema.parse(input.turn)
  return JSON.stringify({ request, turn })
}

/** Parse complete SSE frames without interpreting provider-native payloads. */
export function parseSseEvents(value) {
  const text = String(value).replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  return text.split('\n\n').flatMap((frame) => {
    const eventLines = []
    const dataLines = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) eventLines.push(line.slice(6).trimStart())
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) return []
    const dataText = dataLines.join('\n')
    let data
    try {
      data = JSON.parse(dataText)
    } catch {
      data = undefined
    }
    return [{ event: eventLines.at(-1) ?? 'message', data }]
  })
}

async function raceWithTimeout(promises, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      ...promises,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function observeSettlement(promise, timeoutMs, onFulfilled) {
  let timer
  try {
    await Promise.race([
      promise.then(onFulfilled, () => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function eventSummary(frame) {
  const event = recordValue(frame.data)
  // Retained Bridge streams wrap the native event as envelope.event.event.
  // Pi puts provider and model on message_start.message (or messages[*]).
  const bridgeEvent = recordValue(event?.event)
  const nativeEvent = recordValue(bridgeEvent?.event)
  const nativeData = recordValue(nativeEvent?.data)
  const nativeProviderEvent = recordValue(nativeEvent?.providerEvent)
  const nativeMessage = recordValue(nativeEvent?.message)
  const nativeMessages = Array.isArray(nativeEvent?.messages)
    ? nativeEvent.messages.map(recordValue).filter(Boolean)
    : []
  const candidates = [
    event,
    bridgeEvent,
    recordValue(event?.data),
    recordValue(event?.providerEvent),
    nativeEvent,
    nativeData,
    nativeProviderEvent,
    nativeMessage,
    ...nativeMessages,
  ].filter(Boolean)
  const eventType =
    stringValue(frame.event) ??
    candidates
      .map((candidate) => stringValue(candidate.type) ?? stringValue(candidate.kind))
      .find(Boolean)
  const backend = candidates.map((candidate) => stringValue(candidate.backend)).find(Boolean)
  const provider = candidates
    .map((candidate) => stringValue(candidate.provider) ?? stringValue(candidate.providerName))
    .find(Boolean)
  const model = candidates.map((candidate) => stringValue(candidate.model)).find(Boolean)
  const status = candidates.map((candidate) => stringValue(candidate.status)).find(Boolean)
  return {
    ...(eventType === undefined ? {} : { type: eventType }),
    ...(backend === undefined ? {} : { backend }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(status === undefined ? {} : { status }),
  }
}

function appendSseFrames(buffer, maxEvents) {
  const frames = []
  let remainder = buffer
  while (frames.length < maxEvents) {
    const separator = remainder.indexOf('\n\n')
    if (separator < 0) break
    const frame = remainder.slice(0, separator)
    remainder = remainder.slice(separator + 2)
    frames.push(...parseSseEvents(`${frame}\n\n`))
  }
  return { frames: frames.slice(0, maxEvents), remainder }
}

async function captureRunEvents(
  endpoint,
  runId,
  token,
  { timeoutMs = DEFAULT_EVENT_TIMEOUT_MS, maxEvents = DEFAULT_MAX_SSE_EVENTS } = {},
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  let reader
  let raw = ''
  let frames = []
  let remainder = ''
  try {
    response = await fetch(`${endpoint}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: {
        accept: 'text/event-stream',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      return {
        ok: false,
        status: response.status,
        error: `run events returned HTTP ${String(response.status)}`,
        events: [],
      }
    }
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    while (frames.length < maxEvents) {
      const next = await reader.read()
      if (next.done) break
      raw += decoder.decode(next.value, { stream: true })
      if (Buffer.byteLength(raw) > 128_000) {
        return {
          ok: false,
          status: response.status,
          error: 'run events exceeded the bounded observation window',
          events: frames.map(eventSummary),
        }
      }
      const parsed = appendSseFrames(`${remainder}${raw}`, maxEvents - frames.length)
      frames = [...frames, ...parsed.frames]
      remainder = parsed.remainder
      raw = ''
    }
    return {
      ok: true,
      status: response.status,
      contentType: response.headers.get('content-type'),
      events: frames.map(eventSummary),
    }
  } catch (error) {
    if (response?.ok === true) {
      return {
        ok: true,
        status: response.status,
        contentType: response.headers.get('content-type'),
        events: frames.map(eventSummary),
        ...(frames.length === 0
          ? {
              error: redactString(
                error instanceof Error ? error.message : String(error),
                token ? [token] : [],
              ),
            }
          : {}),
      }
    }
    return {
      ok: false,
      status: response?.status,
      error: redactString(
        error instanceof Error ? error.message : String(error),
        token ? [token] : [],
      ),
      events: frames.map(eventSummary),
    }
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader !== undefined) await reader.cancel().catch(() => {})
  }
}

export function observedProviderAndModel(events, expectedRoute = NATIVE_CONTINUATION_MODEL) {
  const target = nativeContinuationTarget(expectedRoute)
  const backends = [...new Set(events.map((event) => event.backend).filter(Boolean))]
  const providers = [...new Set(events.map((event) => event.provider).filter(Boolean))]
  const models = [...new Set(events.map((event) => event.model).filter(Boolean))]
  return {
    backends,
    providers,
    models,
    backend: backends.find((value) => value === target?.runner),
    provider: providers.find((value) => value === target?.provider),
    model: models.find(
      (value) => value === target?.model || value.endsWith(`/${target?.model ?? ''}`),
    ),
  }
}

function observedIdentityMatchesSession(observed, session) {
  const target = nativeContinuationTarget(session?.model)
  if (target === undefined) return false
  return (
    observed.backend === session?.backend &&
    observed.backends.every((value) => value === session?.backend) &&
    observed.providers.every((value) => value === target.provider) &&
    observed.models.every(
      (value) => `${observed.backend}/${target.provider}/${value}` === session?.model,
    ) &&
    observed.provider === target.provider &&
    observed.model !== undefined &&
    `${observed.backend}/${observed.provider}/${observed.model}` === session?.model
  )
}

export function assertObservedIdentity(observed, session) {
  assertCondition(
    (observed.backend === undefined || observed.backend === session?.backend) &&
      (observed.provider === undefined && observed.model === undefined
        ? true
        : observedIdentityMatchesSession(observed, session)),
    'LIVE_NATIVE_PROVIDER_UNVERIFIED',
    'live events reported a provider or model that did not match the retained session route',
    {
      session,
      backends: observed.backends,
      providers: observed.providers,
      models: observed.models,
    },
  )
}

async function readActiveStatus(endpoint, runId, token, timeoutMs) {
  const response = await requestJson(
    endpoint,
    `/v1/runs/${encodeURIComponent(runId)}`,
    token,
    Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
  )
  requireResponse(response, 200, 'active run status')
  const status = statusSummary(response.body)
  assertCondition(
    status?.status === 'running' && status.terminal === false,
    'LIVE_NATIVE_ADMISSION_NOT_ACTIVE',
    'native continuation was not observable as an active run after admission',
    { status },
  )
  return status
}

async function closeSession(endpoint, sessionId, token, timeoutMs) {
  const response = await requestJson(
    endpoint,
    `/v1/sessions/${encodeURIComponent(sessionId)}/close`,
    token,
    Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    { method: 'POST' },
  )
  requireResponse(response, 200, `close session ${sessionId}`)
  assertCondition(
    recordValue(response.body)?.closed === true,
    'LIVE_NATIVE_CLEANUP_FAILED',
    'CLI Bridge did not confirm retained session cleanup',
  )
  return {
    status: response.status,
    closed: true,
    session: statusSummary(recordValue(response.body)?.session),
  }
}

async function firstTurn(environment, sessionId, suffix, prompt, endpoint, token, timeoutMs) {
  const session = environment.session(sessionId)
  const startedAt = performance.now()
  const result = await session.prompt({
    prompt,
    turnId: `${suffix}-turn-1`,
    executionId: `${suffix}-execution-1`,
  })
  const elapsedMs = Math.round(performance.now() - startedAt)
  assertCondition(
    result.success === true && result.metadata?.status === 'done',
    'LIVE_NATIVE_FIRST_TURN_FAILED',
    'the real Pi first turn did not complete successfully',
    { status: result.metadata?.status },
  )
  const controlRef = assertRunCoordinates(session.controlRef, 'first turn control reference')
  const boundaryValue = await session.contextBoundary?.()
  assertCondition(
    boundaryValue !== null && boundaryValue !== undefined,
    'LIVE_NATIVE_BOUNDARY_MISSING',
    'the real Pi session did not return a context boundary',
  )
  const boundary = NativeContextBoundaryProofSchema.parse(boundaryValue)
  assertBoundaryCoordinates(boundary, controlRef)
  const sessionIdentity = await readSessionIdentity(endpoint, sessionId, token, timeoutMs)
  return {
    session,
    controlRef,
    boundary,
    receipt: {
      success: true,
      status: result.metadata?.status,
      elapsedMs,
      run: referenceSummary(controlRef),
      boundary: boundarySummary(boundary),
      session: sessionIdentity,
    },
  }
}

async function runCancellationCase({
  environment,
  endpoint,
  token,
  timeoutMs,
  suffix,
  cleanupReports = [],
}) {
  const sessionId = `${suffix}-session`
  let session
  let continuationPromise
  let admitted
  let cancellationSent = false
  let terminalOutcome
  let cleanup
  let cleanupCancellation = { attempted: false }
  try {
    const first = await firstTurn(
      environment,
      sessionId,
      suffix,
      DEFAULT_FIRST_PROMPT,
      endpoint,
      token,
      timeoutMs,
    )
    session = first.session
    const continuation = nativeContinuationRequest({
      operationId: `${suffix}-continue`,
      run: first.controlRef,
      expectedBoundary: first.boundary,
      prompt: DEFAULT_CANCEL_PROMPT,
    })
    const admissionStartedAt = performance.now()
    let resolveAdmission
    let rejectAdmission
    const admissionPromise = new Promise((resolve, reject) => {
      resolveAdmission = resolve
      rejectAdmission = reject
    })
    continuationPromise = session.continueNative?.(continuation.request, {
      turn: continuation.turn,
      onAdmission: (controlRef) => {
        try {
          const parsed = assertRunCoordinates(controlRef, 'native continuation admission')
          if (!advancedReference(first.controlRef, parsed)) {
            rejectAdmission(
              new Error('native continuation admission did not advance the run identity'),
            )
            return
          }
          admitted = {
            controlRef: parsed,
            elapsedMs: Math.round(performance.now() - admissionStartedAt),
          }
          resolveAdmission(admitted)
        } catch (error) {
          rejectAdmission(error)
        }
      },
    })
    assertCondition(
      continuationPromise !== undefined,
      'LIVE_NATIVE_CONTINUATION_UNAVAILABLE',
      'the Braid CLI Bridge provider did not expose native continuation',
    )
    const admission = await raceWithTimeout(
      [
        admissionPromise,
        continuationPromise.then(
          () =>
            fail(
              'LIVE_NATIVE_ADMISSION_MISSING',
              'native continuation completed without early admission',
            ),
          (error) => {
            throw error
          },
        ),
      ],
      timeoutMs,
      'native continuation admission timed out',
    )
    const activeStatus = await readActiveStatus(
      endpoint,
      admission.controlRef.runId,
      token,
      timeoutMs,
    )
    const events = await captureRunEvents(endpoint, admission.controlRef.runId, token)
    assertCondition(
      events.ok === true && events.events.length > 0,
      'LIVE_NATIVE_EVENTS_UNAVAILABLE',
      'the admitted real run did not expose live events',
      { status: events.status, eventCount: events.events.length, error: events.error },
    )
    const observed = observedProviderAndModel(events.events, first.receipt.session.model)
    assertObservedIdentity(observed, first.receipt.session)
    const cancellation = exactCancellationRequest({
      operationId: `${suffix}-cancel`,
      run: admission.controlRef,
      reason: 'live native continuation cancellation proof',
    })
    const cancelStartedAt = performance.now()
    const acknowledgement = await session.cancelRun?.(cancellation)
    cancellationSent = true
    const cancelElapsedMs = Math.round(performance.now() - cancelStartedAt)
    const parsedAcknowledgement = AgentRunCancellationAcknowledgementSchema.parse(acknowledgement)
    assertCondition(
      agentRunCancellationAcknowledgementMatchesRequest(cancellation, parsedAcknowledgement),
      'LIVE_NATIVE_CANCEL_IDENTITY_MISMATCH',
      'exact cancellation acknowledgement did not match its request',
    )
    assertCondition(
      parsedAcknowledgement.status === 'accepted' || parsedAcknowledgement.status === 'replayed',
      'LIVE_NATIVE_CANCEL_REJECTED',
      'exact cancellation was not accepted',
      { status: parsedAcknowledgement.status, effect: parsedAcknowledgement.effect },
    )
    assertCondition(
      parsedAcknowledgement.effect === 'cancel_requested' ||
        parsedAcknowledgement.effect === 'cancelled',
      'LIVE_NATIVE_CANCEL_UNCERTAIN',
      'exact cancellation did not return a known cancellation effect',
      { effect: parsedAcknowledgement.effect },
    )
    const terminalStartedAt = performance.now()
    terminalOutcome = await continuationPromise
    const terminalElapsedMs = Math.round(performance.now() - terminalStartedAt)
    const parsedOutcome = AgentNativeContextContinuationResultSchema.parse(terminalOutcome)
    assertCondition(
      parsedOutcome.acknowledgement.status === 'accepted' ||
        parsedOutcome.acknowledgement.status === 'replayed',
      'LIVE_NATIVE_CANCEL_TERMINAL_REJECTED',
      'the continuation did not return a durable terminal acknowledgement',
      { status: parsedOutcome.acknowledgement.status },
    )
    assertCondition(
      parsedOutcome.result.success === false &&
        parsedOutcome.result.metadata?.status === 'cancelled',
      'LIVE_NATIVE_CANCEL_TERMINAL_NOT_CANCELLED',
      'the cancelled continuation did not replay a cancelled terminal result',
      { status: parsedOutcome.result.metadata?.status, success: parsedOutcome.result.success },
    )
    assertCondition(
      agentNativeContextContinuationResultMatchesRequest(continuation.request, parsedOutcome),
      'LIVE_NATIVE_RESULT_IDENTITY_MISMATCH',
      'the cancelled continuation result did not match its exact request',
    )
    const terminalStatusResponse = await requestJson(
      endpoint,
      `/v1/runs/${encodeURIComponent(admission.controlRef.runId)}`,
      token,
      Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    )
    requireResponse(terminalStatusResponse, 200, 'cancelled terminal status')
    const terminalStatus = statusSummary(terminalStatusResponse.body)
    assertCondition(
      terminalStatus?.status === 'cancelled' && terminalStatus.terminal === true,
      'LIVE_NATIVE_CANCEL_TERMINAL_NOT_CANCELLED',
      'the Bridge terminal run snapshot was not cancelled',
      { status: terminalStatus },
    )
    const body = nativeContinuationBody(continuation)
    const replayResponse = await requestJson(
      endpoint,
      `/v1/sessions/${encodeURIComponent(sessionId)}/continue`,
      token,
      Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
      { method: 'POST', body },
    )
    requireResponse(replayResponse, 200, 'cancelled continuation replay')
    const replayOutcome = AgentNativeContextContinuationResultSchema.parse(replayResponse.body)
    assertCondition(
      replayOutcome.acknowledgement.status === 'replayed' &&
        replayOutcome.result.success === false &&
        replayOutcome.result.metadata?.status === 'cancelled',
      'LIVE_NATIVE_CANCEL_REPLAY_INVALID',
      'the post-terminal continuation replay was not byte-stable cancelled state',
      {
        status: replayOutcome.acknowledgement.status,
        resultStatus: replayOutcome.result.metadata?.status,
      },
    )
    assertCondition(
      agentNativeContextContinuationResultMatchesRequest(continuation.request, replayOutcome),
      'LIVE_NATIVE_REPLAY_IDENTITY_MISMATCH',
      'the cancelled terminal replay did not match its exact request',
    )
    const admissionReplayResponses = await Promise.all([
      requestJson(
        endpoint,
        `/v1/sessions/${encodeURIComponent(sessionId)}/continue?return=admission`,
        token,
        Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
        { method: 'POST', body, captureWireDigest: true },
      ),
      requestJson(
        endpoint,
        `/v1/sessions/${encodeURIComponent(sessionId)}/continue?return=admission`,
        token,
        Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
        { method: 'POST', body, captureWireDigest: true },
      ),
    ])
    for (const response of admissionReplayResponses)
      requireResponse(response, 202, 'duplicate admission replay')
    const admissionReplays = admissionReplayResponses.map((response) =>
      AgentNativeContextContinuationAdmissionSchema.parse(response.body),
    )
    for (const replay of admissionReplays) {
      assertCondition(
        agentNativeContextContinuationAdmissionMatchesRequest(continuation.request, replay),
        'LIVE_NATIVE_ADMISSION_REPLAY_IDENTITY_MISMATCH',
        'duplicate admission did not match the exact continuation request',
      )
    }
    const firstWire = admissionReplayResponses[0].wire
    const secondWire = admissionReplayResponses[1].wire
    assertCondition(
      firstWire?.bytes === secondWire?.bytes && firstWire?.digest === secondWire?.digest,
      'LIVE_NATIVE_ADMISSION_REPLAY_NOT_BYTE_IDENTICAL',
      'duplicate admission responses were not byte-identical',
      { firstWire, secondWire },
    )
    const terminalAt = admissionStartedAt + admission.elapsedMs + terminalElapsedMs
    return {
      sessionId,
      first: first.receipt,
      admission: {
        ...admitted,
        request: {
          operationId: continuation.request.operationId,
          requestDigest: continuation.request.requestDigest,
          turnDigest: continuation.request.turnDigest,
        },
      },
      active: {
        status: activeStatus,
        events: {
          status: events.status,
          contentType: events.contentType,
          count: events.events.length,
          types: [...new Set(events.events.map((event) => event.type).filter(Boolean))],
          session: first.receipt.session,
          backends: observed.backends,
          providers: observed.providers,
          models: observed.models,
        },
      },
      cancellation: {
        request: {
          operationId: cancellation.operationId,
          requestDigest: cancellation.requestDigest,
        },
        acknowledgement: {
          status: parsedAcknowledgement.status,
          effect: parsedAcknowledgement.effect,
        },
        elapsedMs: cancelElapsedMs,
      },
      terminal: {
        status: terminalStatus,
        acknowledgement: parsedOutcome.acknowledgement.status,
        result: {
          success: parsedOutcome.result.success,
          status: parsedOutcome.result.metadata?.status,
          error: parsedOutcome.result.error,
        },
        elapsedMs: terminalElapsedMs,
      },
      terminalReplay: {
        status: replayResponse.status,
        acknowledgement: replayOutcome.acknowledgement.status,
        result: {
          success: replayOutcome.result.success,
          status: replayOutcome.result.metadata?.status,
        },
      },
      duplicateAdmission: {
        statuses: admissionReplayResponses.map((response) => response.status),
        phases: admissionReplays.map((replay) => replay.phase),
        controlRefs: admissionReplays.map((replay) => referenceSummary(replay.controlRef)),
        byteIdentical: true,
        wire: { bytes: firstWire.bytes, digest: firstWire.digest },
      },
      assertions: {
        admissionBeforeTerminal: true,
        activeStatus: true,
        activeEvents: true,
        exactCancel: true,
        cancelledTerminalReplay: true,
        duplicateAdmissionByteIdentical: true,
        timing: {
          admissionElapsedMs: admitted.elapsedMs,
          cancelElapsedMs: cancelElapsedMs,
          terminalElapsedMs: terminalElapsedMs,
          terminalObservedAfterCancel: terminalAt >= admissionStartedAt,
        },
      },
    }
  } finally {
    if (continuationPromise !== undefined && !terminalOutcome && admitted && !cancellationSent) {
      try {
        const cleanupRequest = exactCancellationRequest({
          operationId: `${suffix}-cleanup-cancel`,
          run: admitted.controlRef,
          reason: 'live check cleanup',
        })
        const acknowledgement = await session?.cancelRun?.(cleanupRequest)
        cleanupCancellation = {
          attempted: true,
          acknowledged: acknowledgement !== undefined,
        }
      } catch (error) {
        cleanupCancellation = {
          attempted: true,
          acknowledged: false,
          error: errorEvidence(error),
        }
      }
    }
    if (continuationPromise !== undefined && !terminalOutcome) {
      await observeSettlement(continuationPromise, Math.min(timeoutMs, 10_000), (result) => {
        terminalOutcome = result
      })
    }
    try {
      cleanup = await closeSession(endpoint, sessionId, token, timeoutMs)
    } catch (error) {
      cleanup = { closed: false, error: errorEvidence(error) }
    }
    cleanupReports.push({
      scope: 'session',
      sessionId,
      continuationObserved: terminalOutcome !== undefined,
      cancellation: cleanupCancellation,
      ...cleanup,
    })
  }
}

async function runSuccessCase({
  environment,
  endpoint,
  token,
  timeoutMs,
  suffix,
  cleanupReports = [],
}) {
  const sessionId = `${suffix}-session`
  let session
  let continuationPromise
  let admitted
  let terminalOutcome
  let cleanup
  let cleanupCancellation = { attempted: false }
  try {
    const first = await firstTurn(
      environment,
      sessionId,
      suffix,
      DEFAULT_FIRST_PROMPT,
      endpoint,
      token,
      timeoutMs,
    )
    session = first.session
    const continuation = nativeContinuationRequest({
      operationId: `${suffix}-continue`,
      run: first.controlRef,
      expectedBoundary: first.boundary,
      prompt: DEFAULT_SUCCESS_PROMPT,
    })
    const admissionStartedAt = performance.now()
    continuationPromise = session.continueNative?.(continuation.request, {
      turn: continuation.turn,
      onAdmission: (controlRef) => {
        admitted = {
          controlRef: assertRunCoordinates(controlRef, 'successful continuation admission'),
          elapsedMs: Math.round(performance.now() - admissionStartedAt),
        }
      },
    })
    assertCondition(
      continuationPromise !== undefined,
      'LIVE_NATIVE_CONTINUATION_UNAVAILABLE',
      'the Braid CLI Bridge provider did not expose native continuation',
    )
    terminalOutcome = await continuationPromise
    const parsedOutcome = AgentNativeContextContinuationResultSchema.parse(terminalOutcome)
    assertCondition(
      admitted !== undefined,
      'LIVE_NATIVE_ADMISSION_MISSING',
      'successful continuation omitted early admission',
    )
    assertCondition(
      advancedReference(first.controlRef, admitted.controlRef),
      'LIVE_NATIVE_ADMISSION_IDENTITY_MISMATCH',
      'successful continuation did not advance the run identity',
    )
    assertCondition(
      (parsedOutcome.acknowledgement.status === 'accepted' ||
        parsedOutcome.acknowledgement.status === 'replayed') &&
        parsedOutcome.result.success === true &&
        parsedOutcome.result.metadata?.status === 'done',
      'LIVE_NATIVE_SUCCESS_CONTINUATION_FAILED',
      'the real Pi successful continuation did not complete',
      {
        acknowledgement: parsedOutcome.acknowledgement.status,
        status: parsedOutcome.result.metadata?.status,
        success: parsedOutcome.result.success,
      },
    )
    assertCondition(
      agentNativeContextContinuationResultMatchesRequest(continuation.request, parsedOutcome),
      'LIVE_NATIVE_RESULT_IDENTITY_MISMATCH',
      'the successful continuation result did not match its exact request',
    )
    const terminalStatusResponse = await requestJson(
      endpoint,
      `/v1/runs/${encodeURIComponent(admitted.controlRef.runId)}`,
      token,
      Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    )
    requireResponse(terminalStatusResponse, 200, 'successful terminal status')
    const terminalStatus = statusSummary(terminalStatusResponse.body)
    assertCondition(
      terminalStatus?.status === 'done' && terminalStatus.terminal === true,
      'LIVE_NATIVE_SUCCESS_TERMINAL_INVALID',
      'the successful continuation did not expose a done terminal run',
      { status: terminalStatus },
    )
    return {
      sessionId,
      first: first.receipt,
      admission: {
        ...admitted,
        request: {
          operationId: continuation.request.operationId,
          requestDigest: continuation.request.requestDigest,
          turnDigest: continuation.request.turnDigest,
        },
      },
      terminal: {
        status: terminalStatus,
        acknowledgement: parsedOutcome.acknowledgement.status,
        result: {
          success: parsedOutcome.result.success,
          status: parsedOutcome.result.metadata?.status,
          text: parsedOutcome.result.text,
        },
      },
      assertions: {
        admissionBeforeTerminal: admitted.elapsedMs >= 0,
        successfulContinuation: true,
      },
    }
  } finally {
    if (continuationPromise !== undefined && !terminalOutcome && admitted) {
      try {
        const acknowledgement = await session?.cancelRun?.(
          exactCancellationRequest({
            operationId: `${suffix}-cleanup-cancel`,
            run: admitted.controlRef,
            reason: 'live check cleanup',
          }),
        )
        cleanupCancellation = {
          attempted: true,
          acknowledged: acknowledgement !== undefined,
        }
      } catch (error) {
        cleanupCancellation = {
          attempted: true,
          acknowledged: false,
          error: errorEvidence(error),
        }
      }
      await observeSettlement(continuationPromise, Math.min(timeoutMs, 10_000), (result) => {
        terminalOutcome = result
      })
    }
    try {
      cleanup = await closeSession(endpoint, sessionId, token, timeoutMs)
    } catch (error) {
      cleanup = { closed: false, error: errorEvidence(error) }
    }
    cleanupReports.push({
      scope: 'session',
      sessionId,
      continuationObserved: terminalOutcome !== undefined,
      cancellation: cleanupCancellation,
      ...cleanup,
    })
  }
}

function defaultEndpoint() {
  return (
    process.env.BRAID_CLI_BRIDGE_URL ??
    process.env.CLI_BRIDGE_URL ??
    `http://127.0.0.1:${process.env.BRIDGE_PORT ?? '3344'}`
  )
}

function receiptBase(endpoint, model, timeoutMs) {
  return {
    schema: NATIVE_CONTINUATION_RECEIPT_SCHEMA,
    command: 'pnpm test:live:bridge:continuation',
    scope: {
      claims: [
        'admission before terminal output',
        'active status and event access',
        'exact cancellation',
        'cancelled terminal replay',
        'byte-identical duplicate admission',
        'successful native continuation',
      ],
      provider: 'real Pi through Tangle Router',
    },
    startedAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    environment: {
      endpoint: endpointForEvidence(endpoint),
      bearerConfigured: bridgeAuthToken() !== undefined,
      model,
      runner: RUNNER_NAME,
      provider: ROUTER_PROVIDER,
      timeoutMs,
    },
  }
}

/** Run the provider-backed live continuation release check. */
export async function runNativeContinuationProof({
  endpoint: rawEndpoint = defaultEndpoint(),
  token = bridgeAuthToken(),
  model = NATIVE_CONTINUATION_MODEL,
  timeoutMs = Number(process.env.BRAID_LIVE_BRIDGE_TIMEOUT_MS ?? defaultTimeoutMs),
  now = () => new Date().toISOString(),
} = {}) {
  const endpoint = safeEndpoint(rawEndpoint)
  const target = nativeContinuationTarget(model)
  assertCondition(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'LIVE_NATIVE_TIMEOUT_INVALID',
    'native continuation timeout must be a positive safe integer',
  )
  if (!new URL(endpoint).hostname.match(/^(localhost|127\.0\.0\.1|::1)$/u) && token === undefined)
    fail(
      'BRIDGE_CREDENTIAL_REQUIRED',
      'a non-loopback CLI Bridge endpoint requires a bearer credential',
      {},
      exitCodes.unavailable,
    )
  assertCondition(
    target !== undefined,
    'LIVE_NATIVE_MODEL_INVALID',
    `native continuation proof requires a ${RUNNER_NAME}/${ROUTER_PROVIDER}/<model> route`,
  )
  const health = await requestJson(
    endpoint,
    '/health',
    token,
    Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
  )
  requireResponse(health, 200, 'CLI Bridge health', { unavailable: true })
  assertCondition(
    healthBackendsReady(health, [target.runner]),
    'LIVE_NATIVE_BACKEND_UNAVAILABLE',
    'CLI Bridge did not report a ready Pi backend',
    { health: statusSummary(health.body) },
    exitCodes.unavailable,
  )
  const capabilityResponse = await requestJson(
    endpoint,
    `/v1/capabilities?model=${encodeURIComponent(model)}`,
    token,
    Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
  )
  requireResponse(capabilityResponse, 200, 'CLI Bridge capabilities', { unavailable: true })
  const capabilities = assertNativeCapabilities(capabilityResponse.body)
  const provider = createCliBridgeProvider({
    baseUrl: endpoint,
    ...(token === undefined ? {} : { bearerToken: token }),
    defaultModel: model,
    defaultExecution: { kind: 'host', jail: { mode: 'fs-jail' } },
    headersTimeoutMs: Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    bodyTimeoutMs: Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    cancelWaitMs: Math.min(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
  })
  const providerCapabilities = assertNativeCapabilities(await provider.capabilities())
  let environment
  const startedAt = now()
  const cleanupReports = []
  let proof
  let failure
  try {
    environment = await provider.create({
      profile: {
        name: 'Braid live native continuation',
        harness: target.runner,
        model: { provider: target.provider, default: target.model },
      },
    })
    const suffix = `braid-live-native-${Date.now()}`
    const cancellation = await runCancellationCase({
      environment,
      endpoint,
      token,
      timeoutMs,
      suffix: `${suffix}-cancel`,
      cleanupReports,
    })
    const success = await runSuccessCase({
      environment,
      endpoint,
      token,
      timeoutMs,
      suffix: `${suffix}-success`,
      cleanupReports,
    })
    assertCondition(
      cleanupReports.every((report) => report.scope !== 'session' || report.closed === true),
      'LIVE_NATIVE_CLEANUP_FAILED',
      'the live continuation check did not confirm every retained session was closed',
      { cleanup: cleanupReports },
    )
    proof = {
      schema: NATIVE_CONTINUATION_RECEIPT_SCHEMA,
      startedAt,
      capabilities: capabilitySummary(providerCapabilities),
      bridgeCapabilities: capabilitySummary(capabilities),
      provider: {
        name: provider.name,
        environmentId: environment.id,
        route: model,
        real: true,
      },
      cleanup: cleanupReports,
      cancellation,
      success,
      assertions: {
        admissionBeforeTerminal: cancellation.assertions.admissionBeforeTerminal,
        activeStatus: cancellation.assertions.activeStatus,
        activeEvents: cancellation.assertions.activeEvents,
        exactCancel: cancellation.assertions.exactCancel,
        cancelledTerminalReplay: cancellation.assertions.cancelledTerminalReplay,
        duplicateAdmissionByteIdentical: cancellation.assertions.duplicateAdmissionByteIdentical,
        successfulContinuation: success.assertions.successfulContinuation,
      },
    }
  } catch (error) {
    failure = error
  } finally {
    if (environment !== undefined) {
      try {
        await environment.destroy?.()
        cleanupReports.push({
          scope: 'environment',
          environmentId: environment.id,
          destroyed: true,
        })
      } catch (error) {
        cleanupReports.push({
          scope: 'environment',
          environmentId: environment.id,
          destroyed: false,
          error: errorEvidence(error),
        })
      }
    }
  }
  if (failure !== undefined) {
    if (failure instanceof LiveBridgeError) {
      failure.details = { ...failure.details, cleanup: cleanupReports }
      throw failure
    }
    throw new LiveBridgeError(
      'LIVE_NATIVE_CONTINUATION_FAILED',
      failure instanceof Error ? failure.message : String(failure),
      exitCodes.failed,
      { cause: errorEvidence(failure), cleanup: cleanupReports },
    )
  }
  assertCondition(
    cleanupReports.every((report) => report.scope !== 'environment' || report.destroyed === true),
    'LIVE_NATIVE_CLEANUP_FAILED',
    'the live continuation check did not confirm provider environment cleanup',
    { cleanup: cleanupReports },
  )
  return proof
}

/** Write a redacted native continuation receipt to the release artifact path. */
export async function writeNativeContinuationReceipt(receipt, destination) {
  const output =
    destination ??
    process.env.BRAID_LIVE_BRIDGE_CONTINUATION_EVIDENCE ??
    NATIVE_CONTINUATION_EVIDENCE_PATH
  return writeEvidence(receipt, output)
}

/** Execute the live check and always persist a sanitized receipt. */
export async function executeNativeContinuationReleaseCheck(options = {}) {
  const endpoint = safeEndpoint(options.endpoint ?? defaultEndpoint())
  const model =
    options.model ?? process.env.BRAID_LIVE_BRIDGE_CONTINUATION_MODEL ?? NATIVE_CONTINUATION_MODEL
  const timeoutMs =
    options.timeoutMs ?? Number(process.env.BRAID_LIVE_BRIDGE_TIMEOUT_MS ?? defaultTimeoutMs)
  const base = receiptBase(endpoint, model, timeoutMs)
  let proof
  let failure
  try {
    proof = await runNativeContinuationProof({ ...options, endpoint, model, timeoutMs })
  } catch (error) {
    failure = error
  }
  const receipt = evidenceValue({
    ...base,
    ...(proof ?? {}),
    status:
      failure === undefined
        ? 'passed'
        : failure instanceof LiveBridgeError && failure.exitCode === exitCodes.unavailable
          ? 'unavailable'
          : 'failed',
    ...(failure === undefined ? {} : { error: errorEvidence(failure) }),
    finishedAt: new Date().toISOString(),
  })
  const evidencePath = await writeNativeContinuationReceipt(receipt, options.evidencePath)
  if (failure !== undefined) {
    if (failure instanceof LiveBridgeError) {
      failure.details = { ...failure.details, evidencePath }
      throw failure
    }
    throw new LiveBridgeError(
      'LIVE_NATIVE_CONTINUATION_FAILED',
      failure instanceof Error ? failure.message : String(failure),
      exitCodes.failed,
      { evidencePath },
    )
  }
  return { receipt, evidencePath }
}

function isMainModule() {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
}

if (isMainModule()) {
  try {
    const result = await executeNativeContinuationReleaseCheck()
    process.stdout.write(
      `${JSON.stringify({
        status: result.receipt.status,
        evidence: result.evidencePath,
        assertions: result.receipt.assertions,
      })}\n`,
    )
  } catch (error) {
    const details = error instanceof LiveBridgeError ? error.details : {}
    process.stdout.write(
      `${JSON.stringify({
        status:
          error instanceof LiveBridgeError && error.exitCode === exitCodes.unavailable
            ? 'unavailable'
            : 'failed',
        evidence: details?.evidencePath,
        error: errorEvidence(error),
      })}\n`,
    )
    process.exitCode = error instanceof LiveBridgeError ? error.exitCode : exitCodes.failed
  }
}
