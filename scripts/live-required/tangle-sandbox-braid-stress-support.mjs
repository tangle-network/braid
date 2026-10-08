import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  AgentExactRunControlRefSchema,
  validateInteractionAnswer,
} from '@tangle-network/agent-interface'

import { sleep } from '../live-bridge/process.mjs'
import { countProtectedWork, redactString } from '../proof-tools.mjs'
import {
  requestBase,
  interactionFromResponse,
  responseForRequest,
  runFromState,
  stateForRequest,
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
const VISIBLE_PROVIDER_KINDS = new Set([
  'run.text.delta',
  'run.reasoning.delta',
  'run.part.updated',
  'run.tool.call',
  'run.tool.result',
  'run.artifact',
  'run.proposal',
  'run.warning',
  'run.error',
  'run.interaction',
  'run.interaction.cancelled',
  'run.provider.event',
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
  const value = record(parts?.payload.value)
  return nonEmptyString(parts?.payload.runId) ?? nonEmptyString(value?.runId)
}

function rawControlRef(parts) {
  const value = record(parts?.payload.value)
  return (
    record(parts?.payload.controlRef) ??
    record(record(parts?.payload.observation)?.controlRef) ??
    record(value?.controlRef) ??
    record(parts?.event.controlRef) ??
    record(record(parts?.payload.source)?.controlRef)
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
  return scalarCursor(providerEventMetadata(response)?.cursor)
}

export function observationFromResponses(responses, runId) {
  let controlRef = localControlRefFromResponses(responses, runId)
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

export async function waitForControlIdentity(session, runId, timeoutMs, permissions) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    countProtectedWork('polls')
    await answerProofPermissions(session, runId, permissions, deadline)
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
    countProtectedWork('polls')
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

function proofRequestDigest(request) {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

/** Keep permission evidence independently of a long tail of process-liveness events. */
export function proofInteractionTimeline(responses, runId) {
  return responses
    .flatMap((response) => {
      if (eventRunId(response) !== runId || !response.event?.kind?.startsWith('run.interaction'))
        return []
      const payload = eventParts(response).payload
      const request = response.event.kind === 'run.interaction' ? payload.interaction : undefined
      const value = record(payload.value) ?? record(payload.interaction) ?? payload
      return [
        {
          kind: response.event.kind,
          interactionId: request?.id ?? value.interactionId ?? value.id,
          ...(request
            ? {
                requestKind: request.kind,
                requestSha256: proofRequestDigest(request),
                ...proofPermissionPreview(request),
                ...(request.subject?.type === 'tool' ? { toolName: request.subject.toolName } : {}),
                ...(Number.isFinite(request.timeoutMs) ? { timeoutMs: request.timeoutMs } : {}),
              }
            : {}),
          ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
          ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 160) } : {}),
          ...(Number.isSafeInteger(response.event.sequence)
            ? { journalSequence: response.event.sequence }
            : {}),
        },
      ]
    })
    .slice(-32)
}

function proofPermissionPreview(request) {
  const input = request.subject?.input
  const command = typeof input?.command === 'string' ? input.command : undefined
  const path = typeof input?.filePath === 'string' ? input.filePath : undefined
  return {
    ...(command === undefined ? {} : { commandPreview: redactString(command).slice(0, 512) }),
    ...(path === undefined ? {} : { pathPreview: redactString(path).slice(0, 512) }),
  }
}

function proofPermissionResponse(request, policy) {
  const subject = request.subject
  const input = record(subject?.input)
  let allowed = false
  if (
    subject?.type === 'tool' &&
    subject.inputComplete === true &&
    subject.toolName === 'bash' &&
    input
  ) {
    allowed =
      policy.commands.includes(input.command) &&
      Object.keys(input).every((key) =>
        ['command', 'workdir', 'timeout', 'description'].includes(key),
      ) &&
      (input.workdir === undefined ||
        input.workdir === '.' ||
        input.workdir === policy.workspaceCwd)
  } else if (
    subject?.type === 'tool' &&
    subject.inputComplete === true &&
    subject.toolName === 'read' &&
    input
  ) {
    allowed =
      policy.readPaths.includes(input.filePath) &&
      Object.keys(input).every((key) => ['filePath', 'offset', 'limit'].includes(key))
  }
  const fields = request.answerSpec?.fields
  const grant = fields?.find((field) => field.name === 'grant')
  if (
    request.kind !== 'permission' ||
    !allowed ||
    grant?.type !== 'select' ||
    !grant.options?.some((option) => option.value === 'allow_once') ||
    (request.allowedOutcomes !== undefined && !request.allowedOutcomes.includes('accepted')) ||
    fields.some((field) => field.type === 'secret' || (field.name !== 'grant' && field.required))
  ) {
    throw new MissingIntegrationError(
      'The proof received an interaction outside its authorized workspace operations',
      {
        interactionId: request.id,
        requestKind: request.kind,
        requestSha256: proofRequestDigest(request),
        ...proofPermissionPreview(request),
        ...(subject?.type === 'tool' ? { toolName: subject.toolName } : {}),
      },
    )
  }
  const response = { id: request.id, outcome: 'accepted', data: { grant: ['allow_once'] } }
  const checked = validateInteractionAnswer(request.answerSpec, response.data)
  if (!checked.ok)
    throw new MissingIntegrationError(
      'The proof cannot answer the exact permission specification',
      {
        interactionId: request.id,
        errors: checked.errors,
      },
    )
  // Public RPC omits the private binding; Braid validates it against the durable request.
  return response
}

/** The proof acts as the user through public RPC; it never changes agent permissions. */
async function answerProofPermissions(session, runId, policy, deadline) {
  if (!policy) return
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now())
    if (ms <= 0)
      throw new MissingIntegrationError(
        'The proof permission response exceeded its existing phase deadline',
        { runId },
      )
    return ms
  }
  const requests = new Map()
  for (const response of [...(policy.previousResponses ?? []), ...session.responses]) {
    const interaction = interactionFromResponse(response, runId)
    if (interaction?.request) requests.set(interaction.interactionId, interaction.request)
    for (const pending of response.state?.interactions ?? []) {
      if (pending.runId === runId && pending.request)
        requests.set(pending.interactionId, pending.request)
    }
  }
  for (const [interactionId, request] of requests) {
    const requestSha256 = proofRequestDigest(request)
    const recorded = policy.receipts.find(
      (receipt) => receipt.runId === runId && receipt.interactionId === interactionId,
    )
    if (recorded) {
      assert.deepEqual(recorded.request, request, 'A proof permission changed after admission')
      if (recorded.outcome === 'responded') continue
    }
    const current = await rpcRoundTrip(
      session,
      'get_state',
      { projection: 'full' },
      undefined,
      'proof pending permission state',
      remaining(),
    )
    assert.equal(
      current.response.type,
      'state',
      'The proof could not inspect its pending permission',
    )
    if (terminalStatus(runFromState(current.response.state, runId))) continue
    const pending =
      current.response.state?.interactions?.some(
        (item) => item.runId === runId && item.interactionId === interactionId,
      ) ||
      current.response.state?.runs
        ?.find((run) => run.id === runId)
        ?.interactions?.some(
          (item) =>
            item.request?.id === interactionId && ['pending', 'responding'].includes(item.status),
        )
    if (!pending) continue
    const response = proofPermissionResponse(request, policy)
    const operationId = `op-live-permission-${proofRequestDigest({ proofId: policy.proofId, runId, interactionId })}`
    const receipt = recorded ?? {
      runId,
      interactionId,
      requestSha256,
      operationId,
      request: structuredClone(request),
      response,
      pendingStateObserved: true,
      outcome: 'pending',
    }
    if (!recorded) policy.receipts.push(receipt)
    const acknowledgement = await rpcRoundTrip(
      session,
      'respond_interaction',
      { runId, interactionId, response },
      operationId,
      'proof permission acknowledgement',
      remaining(),
    )
    assert.equal(
      acknowledgement.response.type,
      'ack',
      'Proof permission response was not acknowledged',
    )
    assert.equal(
      acknowledgement.response.operationId,
      operationId,
      'Proof permission acknowledgement changed identity',
    )
    assert.ok(
      ['accepted', 'already-applied'].includes(acknowledgement.response.outcome),
      'Proof permission was not accepted',
    )
    receipt.acknowledgement = acknowledgement.response
    const settled = await session.waitFor(
      'durable proof permission response',
      (entry) =>
        entry.type === 'event' &&
        entry.event?.kind === 'run.interaction.responded' &&
        entry.event.payload?.runId === runId &&
        entry.event.payload?.value?.operationId === operationId,
      remaining(),
    )
    receipt.settlement = {
      kind: settled.event.kind,
      operationId,
      ...(Number.isSafeInteger(settled.event.sequence)
        ? { journalSequence: settled.event.sequence }
        : {}),
    }
    receipt.outcome = 'responded'
  }
}

export async function waitForWorkspaceToolEvents(session, runId, timeoutMs, phase, permissions) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    countProtectedWork('polls')
    await answerProofPermissions(session, runId, permissions, deadline)
    const visible = assertUniqueVisibleEvents(session.responses, runId, phase)
    const tools = workspaceToolEvents(visible)
    if (tools.length > 0) return visible
    throwIfRunTerminated(session.responses, runId, 'emitting a provider-bound workspace tool event')
    if (performance.now() >= deadline) {
      throw new MissingIntegrationError(
        `Braid RPC did not expose a provider-bound workspace tool event for run ${runId}`,
        { runId, required: ['run.tool.call', 'run.tool.result', 'run.part.updated:tool'] },
      )
    }
    await sleep(Math.min(100, Math.max(10, deadline - performance.now())))
  }
}

export function workspaceToolEvents(observation) {
  return observation.events.filter(
    (event) =>
      event.kind === 'run.tool.call' ||
      event.kind === 'run.tool.result' ||
      (event.kind === 'run.part.updated' &&
        ['tool', 'result', 'tool-call', 'tool-result'].includes(event.partKind)),
  )
}

function throwIfRunTerminated(responses, runId, pendingProof) {
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index]
    if (response?.type !== 'state') continue
    const run = runFromState(response.state, runId)
    const status = terminalStatus(run)
    if (!status) continue
    const runError = typeof run.error === 'string' && run.error.length > 0 ? run.error : undefined
    throw new MissingIntegrationError(
      `Braid run ${runId} became ${status}${runError === undefined ? '' : ` with ${runError}`} before ${pendingProof}`,
      { runId, status, ...(runError === undefined ? {} : { runError }), required: pendingProof },
    )
  }
}

export async function rpcRoundTrip(
  session,
  command,
  params = {},
  operationId,
  label = command,
  timeoutMs,
) {
  const requestId = `braid-live-${command}-${randomUUID()}`
  const request = { ...requestBase(requestId, command, operationId), params }
  const started = performance.now()
  if (command === 'get_state') countProtectedWork('stateRequests')
  session.send(request)
  const response = await session.waitFor(
    label,
    command === 'get_state' ? stateForRequest(requestId) : responseForRequest(requestId),
    timeoutMs,
  )
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

export async function waitForRequestState(session, requestId, runId, timeoutMs) {
  const response = await session.waitFor(
    `completion state for ${requestId}`,
    stateForRequest(requestId),
    timeoutMs,
  )
  const run = runFromState(response.state, runId)
  if (run === undefined) {
    throw new Error(`completion state for ${requestId} omitted run ${runId}`)
  }
  return { response, run }
}

export async function waitForTerminal(session, runId, timeoutMs, permissions) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    countProtectedWork('polls')
    await answerProofPermissions(session, runId, permissions, deadline)
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
  const value = record(parts?.payload.value)
  return record(parts?.payload.source) ?? record(value?.provider)
}

function belongsToRun(response, runId) {
  if (response?.type !== 'event') return false
  const observedRunId = eventRunId(response)
  return observedRunId === runId
}

function localControlRefFromResponses(responses, runId) {
  for (const response of responses) {
    if (!belongsToRun(response, runId)) continue
    if (eventParts(response)?.event.kind !== 'run.environment.observed') continue
    const controlRef = controlRefFromEvent(response)
    if (controlRef !== undefined) return controlRef
  }
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index]
    if (response?.type !== 'state') continue
    const controlRef = exactControlRef(runFromState(response.state, runId)?.controlRef)
    if (controlRef !== undefined) return controlRef
  }
  return undefined
}

function providerIdentityFromEvent(response, kind, eventId) {
  const parts = eventParts(response)
  const payload = parts?.payload
  const provider = providerEventMetadata(response)
  const value = record(payload?.value)
  const sources = [
    ['source', provider, ['runId', 'providerRunId', 'executionId', 'providerExecutionId']],
    ['source.controlRef', record(provider?.controlRef), ['runId', 'executionId']],
    ['payload.controlRef', record(payload?.controlRef), ['runId', 'executionId']],
    ['payload.value.controlRef', record(value?.controlRef), ['runId', 'executionId']],
    ['payload.providerControlRef', record(payload?.providerControlRef), ['runId', 'executionId']],
    ['payload', payload, ['executionId', 'providerRunId', 'providerExecutionId']],
  ]
  const fields = {
    runId: ['runId', 'providerRunId'],
    executionId: ['executionId', 'providerExecutionId'],
  }
  const identity = {}
  for (const [field, aliases] of Object.entries(fields)) {
    const observed = []
    for (const [sourceName, source, sourceAliases] of sources) {
      if (!source) continue
      for (const alias of aliases) {
        if (!sourceAliases.includes(alias)) continue
        if (Object.hasOwn(source, alias)) observed.push({ sourceName, alias, value: source[alias] })
      }
    }
    if (observed.length === 0) continue
    const values = observed.map((candidate) => nonEmptyString(candidate.value))
    if (values.some((value) => value === undefined)) {
      throw new MissingIntegrationError(
        `Braid emitted visible ${kind} with an invalid provider ${field}`,
        { runId: eventRunId(response), kind, eventId, field, observed },
      )
    }
    const uniqueValues = [...new Set(values)]
    if (uniqueValues.length !== 1) {
      throw new MissingIntegrationError(
        `Braid emitted visible ${kind} with conflicting provider ${field} values`,
        { runId: eventRunId(response), kind, eventId, field, observed },
      )
    }
    identity[field] = uniqueValues[0]
  }
  return Object.keys(identity).length === 0 ? undefined : identity
}

function assertProviderIdentity(response, runId, kind, eventId, expectedControlRef) {
  const observed = providerIdentityFromEvent(response, kind, eventId)
  if (observed === undefined) return
  if (expectedControlRef === undefined) {
    throw new MissingIntegrationError(
      `Braid emitted visible ${kind} with provider identity before exposing the exact local control reference`,
      { runId, kind, eventId, observed },
    )
  }
  for (const field of ['runId', 'executionId']) {
    if (observed[field] === undefined) continue
    if (observed[field] !== expectedControlRef[field]) {
      throw new MissingIntegrationError(
        `Braid emitted visible ${kind} for a foreign provider ${field}`,
        {
          runId,
          kind,
          eventId,
          field,
          expected: expectedControlRef[field],
          observed: observed[field],
        },
      )
    }
  }
}

export function providerEventsForRun(responses, runId) {
  const events = []
  const expectedControlRef = localControlRefFromResponses(responses, runId)
  for (const response of responses) {
    if (!belongsToRun(response, runId, responses)) continue
    const kind = eventParts(response)?.event.kind
    if (typeof kind !== 'string') continue
    const provider = providerEventMetadata(response)
    if (!provider) {
      if (VISIBLE_PROVIDER_KINDS.has(kind)) {
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
    if (VISIBLE_PROVIDER_KINDS.has(kind)) {
      assertProviderIdentity(response, runId, kind, eventId, expectedControlRef)
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
    .filter((event) => VISIBLE_PROVIDER_KINDS.has(event.kind))
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

function assertNoMissingReplayEvidence(responses, runId, phase) {
  const missingSequence = []
  const missingHistory = []
  for (const response of responses) {
    if (response?.type !== 'state') continue
    const state = record(response.state)
    const run = runFromState(state, runId)
    if (run?.missingSequence !== undefined && run.missingSequence !== null) {
      missingSequence.push(run.missingSequence)
    }
    if (Array.isArray(state?.missingHistory)) {
      missingHistory.push(...state.missingHistory.filter((range) => record(range)?.runId === runId))
    }
  }
  if (missingSequence.length === 0 && missingHistory.length === 0) return
  throw new MissingIntegrationError(
    `${phase} cannot prove replay because Braid reported missing provider history`,
    { runId, missingSequence, missingHistory },
  )
}

export function assertUniqueVisibleEvents(responses, runId, phase) {
  assertNoMissingReplayEvidence(responses, runId, phase)
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

function assertContiguousReplay(responses, runId, acknowledgedSequence, phase) {
  const freshEvents = providerEventsForRun(responses, runId).filter(
    (event) => event.providerSequence > acknowledgedSequence,
  )
  assert.ok(
    freshEvents.length > 0,
    `${phase} replay exposed no provider sequence after the acknowledged cursor`,
  )
  assert.equal(
    freshEvents[0].providerSequence,
    acknowledgedSequence + 1,
    `${phase} replay provider sequences after the cursor were not contiguous`,
  )
  for (let index = 1; index < freshEvents.length; index += 1) {
    assert.equal(
      freshEvents[index].providerSequence,
      freshEvents[index - 1].providerSequence + 1,
      `${phase} replay provider sequences after the cursor were not contiguous`,
    )
  }
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
  assertContiguousReplay(resumedResponses, runId, cursorEvent.providerSequence, 'fresh-process')
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
  const fingerprint = errorFingerprint(error)
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(fingerprint === undefined ? {} : { fingerprint }),
    ...(error instanceof MissingIntegrationError
      ? { code: error.code, details: error.details }
      : {}),
  }
}

function errorFingerprint(error, depth = 0) {
  if (depth > 4 || error === null || typeof error !== 'object') return undefined
  const code =
    typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,127}$/u.test(error.code)
      ? error.code
      : undefined
  const status =
    Number.isSafeInteger(error.status) && error.status >= 100 && error.status <= 599
      ? error.status
      : undefined
  const name =
    typeof error.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/u.test(error.name)
      ? error.name
      : undefined
  const cause = errorFingerprint(error.cause, depth + 1)
  if (code === undefined && status === undefined && name === undefined && cause === undefined) {
    return undefined
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
    ...(status === undefined ? {} : { status }),
    ...(cause === undefined ? {} : { cause }),
  }
}

export function terminalStatus(run) {
  return run && TERMINAL_STATUSES.has(run.status) ? run.status : undefined
}
