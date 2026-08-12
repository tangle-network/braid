import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AgentExactRunControlRefSchema } from '@tangle-network/agent-interface'

import { sleep } from '../live-bridge/process.mjs'
import {
  requestBase,
  responseForRequest,
  runFromState,
  stateForRun,
} from '../live-bridge/protocol.mjs'

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'aborted',
  'cancelled',
  'expired',
  'blocked',
  'unknown',
])
const NON_VISIBLE_KINDS = new Set([
  'run.admitted',
  'run.started',
  'run.environment.observed',
  'run.reconnecting',
  'run.reconciled',
  'run.finished',
  'run.cancel.requested',
  'run.cancelled',
  'run.aborted',
  'run.failed',
  'run.status.changed',
  'replay.cursor.advanced',
])

export class MissingIntegrationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'MissingIntegrationError'
    this.code = 'BRAID_LIVE_INTEGRATION_MISSING'
    this.details = details
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function scalarCursor(value) {
  return nonEmptyString(value)
}

function eventParts(response) {
  const event = record(response?.event)
  if (!event) return undefined
  const payload = record(event.payload) ?? event
  return { event, payload }
}

function eventRunId(response) {
  const parts = eventParts(response)
  return nonEmptyString(parts?.payload.runId)
}

function rawControlRef(parts) {
  const value = record(parts?.payload.value)
  return (
    record(parts?.payload.controlRef) ??
    record(record(parts?.payload.observation)?.controlRef) ??
    record(value?.controlRef) ??
    record(parts?.event.controlRef) ??
    record(record(parts?.payload.source)?.controlRef) ??
    record(record(parts?.payload.provider)?.controlRef)
  )
}

const CONTROL_REF_FIELDS = [
  'provider',
  'environmentId',
  'sessionId',
  'executionId',
  'runId',
  'requestDigest',
]

export function exactControlRef(value) {
  const candidate = record(value)
  if (!candidate) return undefined
  const missing = CONTROL_REF_FIELDS.filter((field) => !nonEmptyString(candidate[field]))
  if (missing.length > 0) return undefined
  const parsed = AgentExactRunControlRefSchema.safeParse(
    Object.fromEntries(CONTROL_REF_FIELDS.map((field) => [field, candidate[field]])),
  )
  if (!parsed.success || parsed.data.provider !== 'tangle-sandbox') return undefined
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed.data.requestDigest)) return undefined
  return parsed.data
}

export function controlRefFromEvent(response) {
  return exactControlRef(rawControlRef(eventParts(response)))
}

export function eventCursorFromEvent(response) {
  const parts = eventParts(response)
  return scalarCursor(record(parts?.payload.provider)?.cursor)
}

export function observationFromResponses(responses, runId) {
  let controlRef
  let cursor
  let observationEvent
  for (const response of responses) {
    if (!belongsToRun(response, runId, responses)) continue
    controlRef ??= controlRefFromEvent(response)
    const eventCursor = eventCursorFromEvent(response)
    if (eventCursor !== undefined) cursor = eventCursor
    if (controlRef && observationEvent === undefined) observationEvent = response
  }
  return controlRef || cursor !== undefined
    ? { controlRef, cursor, event: observationEvent }
    : undefined
}

export function latestCursorFromResponses(responses, runId) {
  let cursor
  for (const response of responses) {
    if (!belongsToRun(response, runId, responses)) continue
    const eventCursor = eventCursorFromEvent(response)
    if (eventCursor !== undefined) cursor = eventCursor
  }
  return cursor
}

export async function waitForControlIdentity(session, runId, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const observation = observationFromResponses(session.responses, runId)
    if (observation?.controlRef && observation.cursor !== undefined) return observation
    throwIfRunTerminated(session.responses, runId, 'exposing exact provider identity')
    if (performance.now() >= deadline) {
      const missing = [
        observation?.controlRef ? undefined : 'run.environment.observed.controlRef',
        observation?.cursor === undefined ? 'provider event cursor' : undefined,
      ].filter(Boolean)
      throw new MissingIntegrationError(
        `Braid RPC did not expose exact provider identity fields for run ${runId}`,
        { runId, missing },
      )
    }
    await sleep(Math.min(100, Math.max(10, deadline - performance.now())))
  }
}

export async function waitForVisibleEvents(session, runId, timeoutMs, phase) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const visible = assertUniqueVisibleEvents(session.responses, runId, phase)
    if (visible.count > 0) return visible
    throwIfRunTerminated(session.responses, runId, 'emitting a stable visible provider event')
    if (performance.now() >= deadline) {
      throw new MissingIntegrationError(
        `Braid RPC did not expose a stable visible provider event for run ${runId}`,
        { runId, required: 'at least one stable visible provider event before SIGKILL' },
      )
    }
    await sleep(Math.min(100, Math.max(10, deadline - performance.now())))
  }
}

function throwIfRunTerminated(responses, runId, pendingProof) {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index]
    if (response?.type !== 'state') continue
    const run = runFromState(response.state, runId)
    const status = terminalStatus(run)
    if (!status) continue
    throw new MissingIntegrationError(
      `Braid run ${runId} became ${status} before ${pendingProof}`,
      { runId, status, required: pendingProof },
    )
  }
}

export async function rpcRoundTrip(session, command, params = {}, operationId, label = command) {
  const requestId = `braid-live-${command}-${randomUUID()}`
  const request = { ...requestBase(requestId, command, operationId), params }
  const started = performance.now()
  session.send(request)
  const response = await session.waitFor(label, responseForRequest(requestId))
  return { request, response, elapsedMs: performance.now() - started }
}

export async function stateRoundTrip(session, projection = 'full') {
  const result = await rpcRoundTrip(session, 'get_state', { projection }, undefined, 'state')
  const response = result.response
  if (response.type !== 'state') {
    throw new Error(`get_state returned ${response.type} instead of state`)
  }
  return { ...result, state: response.state }
}

export async function waitForTerminal(session, runId, timeoutMs) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const existing = [...session.responses]
      .reverse()
      .find((response) => stateForRun(response, runId))
    if (existing) return { response: existing, run: runFromState(existing.state, runId) }
    const current = await stateRoundTrip(session)
    if (stateForRun(current.response, runId)) {
      return { response: current.response, run: runFromState(current.state, runId) }
    }
    if (performance.now() >= deadline) {
      throw new Error(`run ${runId} did not reach a terminal state before the timeout`)
    }
    await sleep(Math.min(100, Math.max(10, deadline - performance.now())))
  }
}

function providerEventMetadata(response) {
  const parts = eventParts(response)
  return record(parts?.payload.provider)
}

function belongsToRun(response, runId) {
  if (response?.type !== 'event') return false
  const observedRunId = eventRunId(response)
  return observedRunId === runId
}

export function providerEventsForRun(responses, runId) {
  const events = []
  for (const response of responses) {
    if (!belongsToRun(response, runId, responses)) continue
    const kind = eventParts(response)?.event.kind
    if (typeof kind !== 'string') continue
    const provider = providerEventMetadata(response)
    if (!provider) {
      if (!NON_VISIBLE_KINDS.has(kind)) {
        throw new MissingIntegrationError(
          `Braid emitted visible ${kind} without provider metadata`,
          { runId, kind },
        )
      }
      continue
    }
    const eventId = nonEmptyString(provider.eventId)
    const providerSequence = provider.providerSequence
    const cursor = nonEmptyString(provider.cursor)
    if (!eventId) {
      throw new MissingIntegrationError(
        `Braid emitted ${kind} without a stable provider event identity`,
        { runId, kind },
      )
    }
    if (!Number.isSafeInteger(providerSequence) || providerSequence < 1) {
      throw new MissingIntegrationError(
        `Braid emitted ${kind} without a stable provider sequence`,
        { runId, kind, eventId },
      )
    }
    const payload = eventParts(response)?.payload
    events.push({
      kind,
      eventId,
      providerSequence,
      ...(cursor === undefined ? {} : { cursor }),
      ...(record(payload?.part)?.kind === undefined
        ? {}
        : { partKind: record(payload?.part).kind }),
    })
  }
  return events
}

export function visibleProviderEvents(responses, runId) {
  return providerEventsForRun(responses, runId)
    .filter((event) => !NON_VISIBLE_KINDS.has(event.kind))
    .map((event) => {
      if (!event.cursor) {
        throw new MissingIntegrationError(
          `Braid emitted visible ${event.kind} without a provider cursor`,
          { runId, kind: event.kind, eventId: event.eventId },
        )
      }
      return event
    })
}

export function visibleEventKeys(responses, runId) {
  return visibleProviderEvents(responses, runId).map((event) => event.eventId)
}

export function assertUniqueVisibleEvents(responses, runId, phase) {
  const events = visibleProviderEvents(responses, runId)
  const keys = events.map((event) => event.eventId)
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
  assert.equal(
    duplicates.length,
    0,
    `${phase} replay contained duplicate visible provider events: ${duplicates.join(', ')}`,
  )
  const sequences = events.map((event) => event.providerSequence)
  const duplicateSequences = sequences.filter(
    (sequence, index) => sequences.indexOf(sequence) !== index,
  )
  assert.equal(
    duplicateSequences.length,
    0,
    `${phase} replay contained duplicate provider sequences: ${duplicateSequences.join(', ')}`,
  )
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(
      sequences[index] > sequences[index - 1],
      `${phase} provider sequences were not strictly increasing`,
    )
  }
  return { count: keys.length, keys, events }
}

export function exclusiveResumeIntersection(acknowledged, resumed) {
  const acknowledgedSet = new Set(acknowledged)
  return [...new Set(resumed)].filter((eventId) => acknowledgedSet.has(eventId))
}

export function assertExclusiveResume(acknowledged, resumed) {
  assert.ok(resumed.length > 0, 'fresh process replay returned no visible provider events')
  const intersection = exclusiveResumeIntersection(acknowledged, resumed)
  assert.deepEqual(
    intersection,
    [],
    'fresh process replayed a provider event acknowledged before SIGKILL',
  )
  return intersection
}

export function assertProviderResumeProgress(
  acknowledgedResponses,
  resumedResponses,
  runId,
  cursor,
) {
  const acknowledged = assertUniqueVisibleEvents(acknowledgedResponses, runId, 'pre-kill replay')
  const resumed = assertUniqueVisibleEvents(resumedResponses, runId, 'fresh-process replay')
  assertNonVacuousVisibleEvents(acknowledged, 'pre-kill replay')
  assertNonVacuousVisibleEvents(resumed, 'fresh-process replay')
  const cursorEvent = providerEventsForRun(acknowledgedResponses, runId).find(
    (event) => event.cursor === cursor,
  )
  if (!cursorEvent) {
    throw new MissingIntegrationError(
      'The persisted reconnect cursor did not identify an acknowledged provider event',
      { runId, cursor },
    )
  }
  const first = resumed.events[0]
  assert.ok(
    first.providerSequence > cursorEvent.providerSequence,
    'fresh process replay did not advance beyond the acknowledged provider cursor',
  )
  assert.notEqual(first.cursor, cursor, 'fresh process replay started at the acknowledged cursor')
  return {
    acknowledgedSequence: cursorEvent.providerSequence,
    firstFreshSequence: first.providerSequence,
  }
}

export function assertNonTerminalRun(run, label = 'run') {
  assert.ok(run && typeof run.status === 'string', `${label} was not present in persisted state`)
  assert.equal(terminalStatus(run), undefined, `${label} was terminal before the forced restart`)
  return run
}

export function assertNonVacuousVisibleEvents(observation, label = 'pre-kill replay') {
  assert.ok(
    observation?.count >= 1,
    `${label} had no stable visible provider events to compare across the restart`,
  )
  return observation
}

export function controlIdentity(ref) {
  const exact = exactControlRef(ref)
  if (!exact) throw new MissingIntegrationError('Provider control reference is incomplete', { ref })
  return {
    provider: exact.provider,
    environmentId: exact.environmentId,
    sessionId: exact.sessionId,
    executionId: exact.executionId,
    runId: exact.runId,
    requestDigest: exact.requestDigest,
  }
}

export function assertSameControlRef(left, right, label) {
  assert.deepEqual(
    controlIdentity(right),
    controlIdentity(left),
    `${label} changed provider control identity`,
  )
}

export function assertSameCloudSession(left, right, label) {
  const first = controlIdentity(left)
  const second = controlIdentity(right)
  assert.equal(second.provider, first.provider, `${label} changed provider`)
  assert.equal(second.environmentId, first.environmentId, `${label} changed cloud environment`)
  assert.equal(second.sessionId, first.sessionId, `${label} changed cloud session`)
  assert.notEqual(
    second.executionId,
    first.executionId,
    `${label} reused the prior execution identity`,
  )
  assert.notEqual(second.runId, first.runId, `${label} reused the prior provider run identity`)
}

const OBSERVATION_FIELDS = [
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'costStatus',
  'usage',
  'cost',
  'tokensKnown',
  'usdKnown',
  'usageCompleteness',
  'latencyMs',
  'durationMs',
  'model',
  'provider',
  'runner',
  'operationId',
  'profileSnapshotId',
  'connectionId',
  'providerSessionId',
  'environmentId',
  'replayCursor',
  'lastCursor',
  'lastProviderSequence',
  'eventCount',
  'contentBytes',
  'contentTruncated',
  'missingSequence',
  'terminalReason',
  'materializationDigest',
  'complete',
  'status',
  'error',
  'startedAt',
  'updatedAt',
  'terminalAt',
  'placement',
  'resourceSample',
  'requestedResources',
  'machineId',
  'runtimeEndpointHost',
  'requestedRegion',
  'verifiedRegion',
  'storagePersistence',
  'gpu',
]

const ENVIRONMENT_FIELDS = [
  'kind',
  'providerEnvironmentId',
  'provider',
  'name',
  'lifecycle',
  'lifecycleMode',
  'cleanup',
  'continuity',
  'location',
  'region',
  'runtimeEndpointHost',
  'machineId',
  'requestedRegion',
  'verifiedRegion',
  'storagePersistence',
  'requestedResources',
  'resourceSample',
  'gpu',
  'accountUsage',
  'unavailableTelemetry',
  'placement',
  'repository',
  'gitRef',
  'workingDirectory',
  'image',
  'createdAt',
  'startedAt',
  'lastActivityAt',
  'expiresAt',
  'updatedAt',
]

function telemetryField(source, field, unavailable) {
  if (source && Object.hasOwn(source, field)) {
    if (source[field] === null) return { status: 'unavailable', value: null }
    if (source[field] === undefined) return { status: 'missing' }
    return { status: 'observed', value: source[field] }
  }
  return unavailable.has(field) ? { status: 'unavailable', value: null } : { status: 'missing' }
}

export function environmentForRun(state, run) {
  return (state?.environments ?? []).find((environment) => environment.id === run?.environmentId)
}

export function assertEnvironmentIdentity(run, state, controlRef, label) {
  const environment = environmentForRun(state, run)
  if (!environment) {
    throw new MissingIntegrationError(`${label} has no persisted Braid environment record`, {
      localEnvironmentId: run?.environmentId,
    })
  }
  if (!environment.providerEnvironmentId) {
    throw new MissingIntegrationError(`${label} environment has no provider environment ID`, {
      localEnvironmentId: environment.id,
    })
  }
  assert.equal(
    controlRef.environmentId,
    environment.providerEnvironmentId,
    `${label} control reference does not match environment.providerEnvironmentId`,
  )
  assert.notEqual(
    run?.environmentId,
    controlRef.environmentId,
    `${label} collapsed the local Braid environment ID into the provider environment ID`,
  )
  return environment
}

export function runObservations(run, state) {
  const environment = environmentForRun(state, run)
  const unavailable = new Set(environment?.unavailableTelemetry ?? [])
  const runSources = [record(run), record(run?.observation)].filter(Boolean)
  const runTelemetry = Object.fromEntries(
    OBSERVATION_FIELDS.map((field) => {
      const source = runSources.find((candidate) => Object.hasOwn(candidate, field))
      return [field, telemetryField(source, field, new Set())]
    }),
  )
  const environmentTelemetry = Object.fromEntries(
    ENVIRONMENT_FIELDS.map((field) => [field, telemetryField(environment, field, unavailable)]),
  )
  return {
    localEnvironmentId: run?.environmentId ?? null,
    providerEnvironmentId: environment?.providerEnvironmentId ?? null,
    environmentRecord: environment ?? null,
    run: runTelemetry,
    environment: environmentTelemetry,
  }
}

export function numericDelta(after, before, field) {
  const left = after?.[field]
  const right = before?.[field]
  return typeof left === 'number' && typeof right === 'number' ? left - right : null
}

export function resourceDelta(after, before) {
  const fields = ['activeSandboxes', 'totalSandboxes', 'computeMinutes', 'gpuSeconds', 'gpuCostUsd']
  const delta = Object.fromEntries(
    fields.map((field) => [field, numericDelta(after, before, field)]),
  )
  return {
    ...delta,
    unknownFields: fields.filter((field) => delta[field] === null),
  }
}

export function proofCoordinates() {
  const nonce = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`
  const safe = nonce.replaceAll('-', '_')
  return {
    proofId: `braid-cloud-stress-${nonce}`,
    marker: `BRAID_CLOUD_${safe}`,
    followUpMarker: `BRAID_FOLLOW_UP_${safe}`,
    cancelMarker: `BRAID_CANCEL_${safe}`,
  }
}

export function errorDetails(error) {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof MissingIntegrationError
      ? { code: error.code, details: error.details }
      : {}),
  }
}

export function terminalStatus(run) {
  return run && TERMINAL_STATUSES.has(run.status) ? run.status : undefined
}
