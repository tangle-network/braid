import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { validateInteractionResponse } from '@tangle-network/agent-interface'
import { Sandbox } from '@tangle-network/sandbox'
import {
  interactionFromResponse,
  requestBase,
  runFromState,
  stateForRequest,
  terminalMessage,
} from '../live-bridge/protocol.mjs'
import { installPackedBraid } from '../packed-binary.mjs'
import { safeJson } from './contracts.mjs'
import { configEvidence, initializedSession, prepareProductionWorkspace } from './headless.mjs'
import {
  cleanupRetainedResourceByControlRef,
  cleanupRetainedResourceByRunId,
  providerExecutionLedgerEvidence,
  retainedBox,
} from './tangle-sandbox-braid-stress.mjs'
import {
  assertSameControlRef,
  rpcRoundTrip,
  stateRoundTrip,
  waitForControlIdentity,
  waitForTerminal,
} from './tangle-sandbox-braid-stress-support.mjs'
import { workspaceRequestFor } from './workspace-request.mjs'

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_IDLE_TTL_SECONDS = 1_800
const DIAGNOSTIC_EVENT_LIMIT = 24
const DIAGNOSTIC_PROVIDER_RUN_LIMIT = 8
const DIAGNOSTIC_PROVIDER_TIMEOUT_MS = 5_000
const SECRET_ENVIRONMENT_NAMES = [
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_BEARER',
  'TANGLE_API_KEY',
]

function positiveEnvironment(environment, name, fallback) {
  const value = Number(environment[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sanitizedEnvironment(environment) {
  const child = { ...environment }
  for (const name of SECRET_ENVIRONMENT_NAMES) delete child[name]
  return child
}

function assertAck(result, command) {
  const response = result.response
  assert.equal(
    response.type,
    'ack',
    `${command} failed: ${response.code ?? response.type}: ${response.message ?? ''}`,
  )
  return response
}

function interactionState(state, runId, interactionId) {
  return runFromState(state, runId)?.interactions?.find(
    (entry) => entry.request?.id === interactionId,
  )
}

export function retainedCloudQuestionRequest(state, runId, interactionId) {
  const retained = interactionState(state, runId, interactionId)
  assert.equal(retained?.status, 'pending', 'cloud question is no longer pending')
  const request = retained.request
  assert.equal(request.kind, 'question', 'retained cloud interaction was not a question')
  assert.equal(request.binding?.runId, runId, 'retained cloud question belongs to another run')
  assert.equal(
    request.binding?.interactionId,
    interactionId,
    'retained cloud question changed identity',
  )
  return request
}

export function cloudQuestionResponse(request, answer) {
  assert.equal(request?.kind, 'question', 'LIVE-08 requires a real cloud question')
  const fields = request.answerSpec?.fields
  assert.ok(Array.isArray(fields), 'cloud question has no answer specification')
  const data = {}
  for (const field of fields) {
    if (field.type === 'secret') throw new Error('LIVE-08 refuses secret-designated answers')
    if (field.type === 'text')
      data[field.name] = (field.default ?? answer).slice(0, field.maxLength)
    else if (field.type === 'number') data[field.name] = field.default ?? field.min ?? 0
    else if (field.type === 'boolean') data[field.name] = field.default ?? true
    else if (field.type === 'select')
      data[field.name] = [field.default?.[0] ?? field.options?.[0]?.value]
    else throw new Error(`LIVE-08 cannot answer field type ${String(field.type)}`)
  }
  const response = {
    id: request.id,
    outcome: 'accepted',
    ...(fields.length === 0 ? {} : { data }),
  }
  const validation = validateInteractionResponse(request, response)
  assert.equal(
    validation.ok,
    true,
    `cloud question answer is invalid: ${validation.errors?.join('; ')}`,
  )
  return response
}

export function assertCloudInteractionEvidence({
  firstResponses,
  freshResponses,
  initialState,
  reconnectedState,
  terminalState,
  runId,
  interactionId,
  operationId,
  reconnectAck,
  responseAck,
  marker,
}) {
  const requestEvents = firstResponses.filter(
    (entry) =>
      entry.type === 'event' &&
      entry.event?.kind === 'run.interaction' &&
      entry.event.payload?.runId === runId &&
      entry.event.payload?.interaction?.id === interactionId,
  )
  assert.equal(requestEvents.length, 1, 'cloud provider did not emit one retained interaction')
  const request = requestEvents[0].event.payload.interaction
  assert.equal(request.kind, 'question', 'cloud interaction was not a question')
  assert.equal(interactionState(initialState, runId, interactionId)?.status, 'pending')
  assert.equal(interactionState(reconnectedState, runId, interactionId)?.status, 'pending')
  assert.equal(reconnectAck?.type, 'ack', 'cloud reconnect was not acknowledged')
  assert.equal(
    runFromState(reconnectedState, runId)?.status,
    'reconnecting',
    'cloud reconnect state is not reconnecting before the answer',
  )
  assert.ok(Number.isSafeInteger(reconnectAck.revision), 'cloud reconnect has no revision')
  assert.ok(
    Number.isSafeInteger(reconnectedState.revision),
    'cloud reconnect state has no revision',
  )
  assert.ok(
    Number.isSafeInteger(reconnectedState.sequence),
    'cloud reconnect state has no sequence',
  )
  assert.ok(
    reconnectAck.revision <= reconnectedState.revision,
    'cloud reconnect state predates acknowledgement',
  )
  assert.equal(responseAck?.type, 'ack', 'cloud interaction response was not acknowledged')
  assert.equal(responseAck?.operationId, operationId, 'cloud response operation changed identity')
  assert.equal(responseAck?.outcome, 'accepted', 'cloud response was not accepted')
  const responseEvents = freshResponses.filter(
    (entry) =>
      entry.type === 'event' &&
      entry.event?.payload?.runId === runId &&
      entry.event.payload?.value?.interactionId === interactionId &&
      entry.event.payload.value.operationId === operationId,
  )
  const requested = responseEvents.filter(
    (entry) => entry.event.kind === 'run.interaction.response.requested',
  )
  const responded = responseEvents.filter(
    (entry) => entry.event.kind === 'run.interaction.responded',
  )
  assert.equal(requested.length, 1, 'Braid did not retain one response request')
  assert.equal(responded.length, 1, 'Braid did not retain one response acknowledgement')
  assert.ok(
    reconnectedState.sequence < requested[0].sequence,
    'cloud response request preceded the observed reconnecting state',
  )
  assert.ok(requested[0].sequence < responded[0].sequence, 'response events are out of order')
  assert.equal(requested[0].event.payload.value.outcome, 'accepted')
  assert.equal(responded[0].event.payload.value.outcome, 'accepted')
  const run = runFromState(terminalState, runId)
  assert.equal(run?.status, 'completed', 'cloud run did not continue to completion')
  assert.equal(terminalMessage(terminalState, runId)?.text?.trim(), marker)
  return {
    interactionId,
    kind: request.kind,
    requestSequence: requestEvents[0].sequence,
    reconnect: {
      operationId: reconnectAck.operationId,
      acknowledgedRevision: reconnectAck.revision,
      observedRevision: reconnectedState.revision,
      observedSequence: reconnectedState.sequence,
      runStatus: 'reconnecting',
      interactionStatus: 'pending',
    },
    responseRequestedSequence: requested[0].sequence,
    responseAcknowledgedSequence: responded[0].sequence,
    terminalStatus: run.status,
  }
}

function proofPrompt(marker) {
  return [
    'Before answering, call the ask_user question tool exactly once.',
    'Ask which proof action to take. Offer the options Continue and Stop.',
    'Wait for the answer. After any accepted answer, use no other tools.',
    `Then reply with exactly ${marker} and no other text.`,
  ].join(' ')
}

function diagnosticToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : null
}

export function cloudInteractionFailureSnapshot(responses, runId, questionRequested) {
  const all = Array.isArray(responses) ? responses : []
  const events = all.filter(
    (entry) =>
      entry?.type === 'event' &&
      entry.event?.payload?.runId === runId &&
      typeof entry.event?.kind === 'string',
  )
  const latestState = all.findLast(
    (entry) => entry?.type === 'state' && runFromState(entry.state, runId) !== undefined,
  )
  const run = runFromState(latestState?.state, runId)
  const counts = {}
  for (const entry of events) {
    const kind = diagnosticToken(entry.event.kind) ?? 'other'
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return {
    questionRequested,
    responseCount: all.length,
    runEventCount: events.length,
    eventCounts: counts,
    lastEvents: events.slice(-DIAGNOSTIC_EVENT_LIMIT).map((entry) => ({
      sequence: Number.isSafeInteger(entry.sequence) ? entry.sequence : null,
      kind: diagnosticToken(entry.event.kind) ?? 'other',
    })),
    latestState:
      run === undefined
        ? null
        : {
            revision: Number.isSafeInteger(latestState.revision) ? latestState.revision : null,
            sequence: Number.isSafeInteger(latestState.sequence) ? latestState.sequence : null,
            status: diagnosticToken(run.status),
            complete: run.complete === true,
            interactions: (run.interactions ?? [])
              .slice(0, DIAGNOSTIC_PROVIDER_RUN_LIMIT)
              .map((entry) => ({
                kind: diagnosticToken(entry.request?.kind),
                status: diagnosticToken(entry.status),
              })),
          },
  }
}

async function boundedProviderRead(operation) {
  let timer
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('provider diagnostic read timed out')),
          DIAGNOSTIC_PROVIDER_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function cloudProviderFailureProjection(status, runs) {
  return {
    observed: true,
    sessionStatus: diagnosticToken(status?.status),
    failureCode: diagnosticToken(status?.failureReason?.code),
    executionCount: Array.isArray(runs) ? runs.length : null,
    executions: Array.isArray(runs)
      ? runs.slice(0, DIAGNOSTIC_PROVIDER_RUN_LIMIT).map((run) => ({
          executionId: diagnosticToken(run.executionId),
          status: diagnosticToken(run.status),
          eventCount: Number.isSafeInteger(run.eventCount) ? run.eventCount : null,
        }))
      : [],
  }
}

async function cloudProviderFailureSnapshot(client, controlRef) {
  if (!client || !controlRef) return { observed: false, reasonCode: 'MISSING_EXACT_IDENTITY' }
  try {
    const box = await boundedProviderRead(() =>
      retainedBox(client, controlRef, 'LIVE-08 failure diagnostic'),
    )
    const session = box.session(controlRef.sessionId)
    const [status, runs] = await Promise.all([
      boundedProviderRead(() => session.status()),
      boundedProviderRead(() => session.runs()),
    ])
    return cloudProviderFailureProjection(status, runs)
  } catch (error) {
    return { observed: false, reasonCode: diagnosticToken(error?.code) ?? 'PROVIDER_READ_FAILED' }
  }
}

export async function refreshBraidFailureState(session) {
  if (!session || session.closed) return { attempted: false, received: false }
  try {
    const requestId = `braid-live-cloud-diagnostic-${randomUUID()}`
    session.send({
      ...requestBase(requestId, 'get_state'),
      params: { projection: 'full' },
    })
    await session.waitFor(
      'cloud interaction failure state',
      stateForRequest(requestId),
      DIAGNOSTIC_PROVIDER_TIMEOUT_MS,
    )
    return { attempted: true, received: true }
  } catch (error) {
    return {
      attempted: true,
      received: false,
      reasonCode: diagnosticToken(error?.code) ?? 'BRAID_STATE_READ_FAILED',
    }
  }
}

export async function runCloudInteractionProof({
  repository,
  environment = process.env,
  values,
} = {}) {
  assert.ok(
    values?.credentialValue,
    'cloud interaction proof needs a Sandbox observation credential',
  )
  const timeoutMs = positiveEnvironment(
    environment,
    'BRAID_TANGLE_SANDBOX_INTERACTION_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
  )
  const idleTtlSeconds = positiveEnvironment(
    environment,
    'BRAID_TANGLE_SANDBOX_INTERACTION_IDLE_TTL_SECONDS',
    DEFAULT_IDLE_TTL_SECONDS,
  )
  const packed = await installPackedBraid(repository, {
    tarballPath: environment.BRAID_RELEASE_TARBALL,
  })
  let config
  let firstSession
  let freshSession
  let client
  let runId
  let controlRef
  let proof
  let failure
  let cleanup
  let questionRequested = null
  let failureDiagnostic
  try {
    if (
      typeof environment.BRAID_LIVE_TARBALL_SHA256 === 'string' &&
      packed.tarballSha256 !== environment.BRAID_LIVE_TARBALL_SHA256
    )
      throw new Error('cloud interaction proof installed another release candidate')
    config = await prepareProductionWorkspace({
      repository,
      environment: sanitizedEnvironment(environment),
      kind: values.kind,
      endpoint: values.endpoint,
      model: values.model,
      modelProvider: values.modelProvider,
      runner: 'opencode',
      credentialRef: values.credentialRef,
      credentialValue: values.credentialValue,
      workspaceRequest: workspaceRequestFor(environment),
      providerOptions: { lifecycle: 'retained', idleTtlSeconds },
    })
    client = new Sandbox({ baseUrl: values.endpoint, apiKey: values.credentialValue })
    const marker = `BRAID_CLOUD_INTERACTION_${randomUUID().replaceAll('-', '').toUpperCase()}`
    const first = await initializedSession(packed.binary, config)
    firstSession = first.session
    const sent = assertAck(
      await rpcRoundTrip(
        firstSession,
        'send',
        {
          conversationId: first.state.state.conversationId,
          branchId: first.state.state.branchId,
          text: proofPrompt(marker),
        },
        `op-braid-cloud-interaction-send-${randomUUID()}`,
      ),
      'cloud interaction send',
    )
    runId = sent.runId
    assert.ok(typeof runId === 'string' && runId.length > 0, 'send returned no local run ID')
    questionRequested = sent.admission?.requested?.interactions?.question === true
    assert.equal(questionRequested, true, 'Tangle did not advertise and request cloud questions')
    const initialObservation = await waitForControlIdentity(firstSession, runId, timeoutMs)
    controlRef = initialObservation.controlRef
    const event = await firstSession.waitFor(
      'real cloud question',
      (entry) =>
        entry.type === 'event' &&
        entry.event?.kind === 'run.interaction' &&
        interactionFromResponse(entry, runId)?.request?.kind === 'question',
      timeoutMs,
    )
    const interaction = interactionFromResponse(event, runId)
    assert.ok(interaction, 'cloud question lacked an interaction identity')
    const initial = (await stateRoundTrip(firstSession)).state
    assert.equal(interactionState(initial, runId, interaction.interactionId)?.status, 'pending')
    const firstResponses = [...firstSession.responses]
    firstSession.child.kill('SIGKILL')
    const firstExit = await firstSession.exit
    assert.equal(firstExit.signal, 'SIGKILL', 'first Braid process did not exit before reconnect')
    const firstCleanup = await firstSession.close()
    assert.equal(
      firstCleanup.termination.descendantsVerified,
      true,
      'first Braid process tree remained',
    )
    firstSession = undefined

    const fresh = await initializedSession(packed.binary, config)
    freshSession = fresh.session
    assert.equal(
      interactionState(fresh.state.state, runId, interaction.interactionId)?.status,
      'pending',
      'cloud interaction was not retained across Braid process restart',
    )
    const reconnectOperationId = `op-braid-cloud-interaction-reconnect-${randomUUID()}`
    const reconnectAck = assertAck(
      await rpcRoundTrip(freshSession, 'reconnect', { runId }, reconnectOperationId),
      'cloud interaction reconnect',
    )
    assert.equal(reconnectAck.operationId, reconnectOperationId)
    const reconnected = (await stateRoundTrip(freshSession)).state
    assert.equal(interactionState(reconnected, runId, interaction.interactionId)?.status, 'pending')
    assert.equal(runFromState(reconnected, runId)?.status, 'reconnecting')
    const reconnectedRef = runFromState(reconnected, runId)?.controlRef
    assertSameControlRef(controlRef, reconnectedRef, 'cloud interaction reconnect')
    // RPC events expose a safe summary; the full request is in Braid's retained state.
    const retainedRequest = retainedCloudQuestionRequest(
      reconnected,
      runId,
      interaction.interactionId,
    )
    const response = cloudQuestionResponse(retainedRequest, marker)
    const responseOperationId = `op-braid-cloud-interaction-response-${randomUUID()}`
    const responseAck = assertAck(
      await rpcRoundTrip(
        freshSession,
        'respond_interaction',
        { runId, interactionId: interaction.interactionId, response },
        responseOperationId,
      ),
      'cloud interaction response',
    )
    assert.equal(responseAck.outcome, 'accepted', 'cloud response was not accepted')
    await freshSession.waitFor(
      'durable cloud interaction acknowledgement',
      (entry) =>
        entry.type === 'event' &&
        entry.event?.kind === 'run.interaction.responded' &&
        entry.event.payload?.runId === runId &&
        entry.event.payload?.value?.operationId === responseOperationId,
      timeoutMs,
    )
    const terminal = await waitForTerminal(freshSession, runId, timeoutMs)
    const timeline = assertCloudInteractionEvidence({
      firstResponses,
      freshResponses: freshSession.responses,
      initialState: initial,
      reconnectedState: reconnected,
      terminalState: terminal.response.state,
      runId,
      interactionId: interaction.interactionId,
      operationId: responseOperationId,
      reconnectAck,
      responseAck,
      marker,
    })
    const providerExecution = await providerExecutionLedgerEvidence(client, controlRef, [
      { controlRef, status: 'completed', name: 'cloud interaction' },
    ])
    proof = {
      status: 'passed',
      binary: { tarballSha256: packed.tarballSha256 },
      configuration: configEvidence(config),
      runId,
      controlRef,
      marker,
      interaction: timeline,
      firstProcess: { exitSignal: firstExit.signal, descendantsVerified: true },
      response: { operationId: responseOperationId, outcome: responseAck.outcome },
      providerExecution,
    }
  } catch (error) {
    failure = error
    const diagnosticSession = firstSession ?? freshSession
    const braidStateRead = await refreshBraidFailureState(diagnosticSession)
    failureDiagnostic = {
      schemaVersion: 1,
      phase: 'cloud-interaction',
      failureCode: diagnosticToken(error?.code) ?? 'PROOF_FAILED',
      runId: diagnosticToken(runId),
      environmentId: diagnosticToken(controlRef?.environmentId),
      braidStateRead,
      braid: cloudInteractionFailureSnapshot(
        diagnosticSession?.responses,
        runId,
        questionRequested,
      ),
      provider: await cloudProviderFailureSnapshot(client, controlRef),
    }
  } finally {
    if (runId && freshSession && !freshSession.closed && proof === undefined) {
      try {
        await rpcRoundTrip(
          freshSession,
          'cancel_run',
          { runId, reason: 'Cloud interaction proof cleanup' },
          `op-braid-cloud-interaction-cleanup-${randomUUID()}`,
        )
      } catch (error) {
        failure = new AggregateError(
          [failure, error].filter(Boolean),
          'cloud interaction cleanup failed',
        )
      }
    }
    for (const session of [firstSession, freshSession]) {
      if (session)
        await session.close().catch((error) => {
          failure = new AggregateError(
            [failure, error].filter(Boolean),
            'cloud interaction process cleanup failed',
          )
        })
    }
    if (client && runId) {
      try {
        cleanup = controlRef
          ? await cleanupRetainedResourceByControlRef(client, controlRef)
          : await cleanupRetainedResourceByRunId(client, runId)
      } catch (error) {
        failure = new AggregateError(
          [failure, error].filter(Boolean),
          'cloud interaction Sandbox cleanup failed',
        )
      }
    }
    if (config)
      await config.cleanup().catch((error) => {
        failure = new AggregateError(
          [failure, error].filter(Boolean),
          'cloud interaction workspace cleanup failed',
        )
      })
    await packed.cleanup().catch((error) => {
      failure = new AggregateError(
        [failure, error].filter(Boolean),
        'cloud interaction packed binary cleanup failed',
      )
    })
  }
  if (failureDiagnostic) {
    process.stderr.write(
      `BRAID_CLOUD_INTERACTION_DIAGNOSTIC_JSON=${safeJson(
        {
          ...failureDiagnostic,
          cleanup: {
            attempted: Boolean(client && runId),
            confirmed: cleanup?.confirmed === true,
            mode: diagnosticToken(cleanup?.mode),
          },
        },
        environment,
      )}\n`,
    )
  }
  if (failure) throw failure
  assert.equal(cleanup?.confirmed, true, 'cloud interaction resource cleanup was not confirmed')
  return { ...proof, cleanup }
}
