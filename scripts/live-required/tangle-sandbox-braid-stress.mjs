import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Sandbox } from '@tangle-network/sandbox'
import { sleep } from '../live-bridge/process.mjs'
import { connectionConfiguration } from './configuration.mjs'
import {
  closeSession,
  configEvidence,
  initializedSession,
  prepareProductionWorkspace,
  resolveBinary,
} from './headless.mjs'
import {
  assertEnvironmentIdentity,
  assertExclusiveResume,
  assertNonTerminalRun,
  assertNonVacuousVisibleEvents,
  assertProviderResumeProgress,
  assertSameCloudSession,
  assertSameControlRef,
  assertUniqueVisibleEvents,
  errorDetails,
  latestCursorFromResponses,
  MissingIntegrationError,
  proofCoordinates,
  resourceDelta,
  rpcRoundTrip,
  runObservations,
  stateRoundTrip,
  terminalStatus,
  waitForControlIdentity,
  waitForTerminal,
  waitForWorkspaceToolEvents,
  workspaceToolEvents,
} from './tangle-sandbox-braid-stress-support.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repository = resolve(dirname(scriptPath), '../..')
const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_HOLD_MS = 30_000
const DEFAULT_IDLE_TTL_SECONDS = 1_800
const SANDBOX_LIST_PAGE_SIZE = 100
const BRAID_RESOURCE_OWNER = 'braid'
const RETAINED_LIFECYCLE = 'retained'
const SECRET_ENVIRONMENT_NAMES = [
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_BEARER',
  'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY',
  'TANGLE_API_KEY',
]

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

function numberEnvironment(environment, name, fallback) {
  const value = Number(environment[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sanitizedEnvironment(environment) {
  const child = { ...environment }
  for (const name of SECRET_ENVIRONMENT_NAMES) delete child[name]
  return child
}

function configurationEnvironment(environment) {
  if (
    !environment.BRAID_TANGLE_SANDBOX_CREDENTIAL_REF &&
    !environment.BRAID_TANGLE_SANDBOX_AUTH &&
    !environment.BRAID_TANGLE_SANDBOX_API_KEY &&
    !environment.BRAID_TANGLE_SANDBOX_BEARER &&
    environment.TANGLE_API_KEY
  ) {
    return { ...environment, BRAID_TANGLE_SANDBOX_API_KEY: environment.TANGLE_API_KEY }
  }
  return environment
}

function sandboxClient(values) {
  // Direct verification must use the value installed under this proof's
  // generated credential reference. An independent cleanup key could observe
  // another account and make identity or resource-delta evidence meaningless.
  const apiKey = values.credentialValue?.trim()
  if (!apiKey) return undefined
  return new Sandbox({ baseUrl: values.endpoint, apiKey })
}

function sandboxConfiguration(environment) {
  return connectionConfiguration(configurationEnvironment(environment), {
    prefix: 'BRAID_TANGLE_SANDBOX',
    kind: 'tangle-sandbox',
    endpointNames: ['BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_RUNNER'],
    providerNames: ['BRAID_TANGLE_SANDBOX_PROVIDER'],
  })
}

function workspaceMarkerPath(coordinates) {
  return `.braid-live/${coordinates.proofId}/marker.txt`
}

function continuityChallengePath(coordinates) {
  return `.braid-live/${coordinates.proofId}/continuity-challenge.txt`
}

function continuityResponsePath(coordinates) {
  return `.braid-live/${coordinates.proofId}/continuity-response.txt`
}

export function sandboxWorkspaceRelativePath(path) {
  const normalized = path.startsWith('./') ? path.slice(2) : path
  const segments = normalized.split('/')
  if (
    normalized.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('Sandbox workspace path must be a contained relative path')
  }
  return normalized
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function proofPrompts(coordinates, holdMs) {
  const path = workspaceMarkerPath(coordinates)
  const challengePath = continuityChallengePath(coordinates)
  const responsePath = continuityResponsePath(coordinates)
  const holdSeconds = Math.max(5, Math.ceil(holdMs / 1000))
  return {
    first: [
      'Use the current Tangle Sandbox working directory for every command in this turn.',
      `Create ${path} and write exactly ${coordinates.marker} followed by a newline.`,
      `Read ${path}, print its contents, and prove the workspace is usable with a shell command.`,
      'Run git -C . rev-parse --is-inside-work-tree. If it fails, run git -C . init.',
      'Then run git -C . rev-parse --is-inside-work-tree again and print its result.',
      `Execute the shell command sleep ${holdSeconds} before the final response to keep the run active.`,
      `Reply with exactly ${coordinates.marker}.`,
    ].join(' '),
    followUp: [
      'Use a shell command in the existing Tangle Sandbox workspace.',
      `Compute the SHA-256 digest of the exact bytes in ${challengePath}.`,
      `Write only the lowercase 64-character digest followed by a newline to ${responsePath}.`,
      `Read ${path} too, but do not include its contents in the response.`,
      'Reply with only the computed digest.',
    ].join(' '),
    cancel: [
      'Keep working in the same Tangle Sandbox workspace.',
      `Read ${path}, then execute the shell command sleep ${Math.max(60, holdSeconds * 2)} before replying.`,
      `Reply with exactly ${coordinates.cancelMarker} only if cancellation does not arrive.`,
    ].join(' '),
  }
}

async function retainedBox(client, controlRef, label) {
  if (!client) {
    throw new MissingIntegrationError(`${label} requires the Sandbox verification client`, {
      required: 'BRAID_TANGLE_SANDBOX_API_KEY or TANGLE_API_KEY',
    })
  }
  const box = await client.get(controlRef.environmentId)
  if (!box || !retainedResourceIdentity(box, controlRef)) {
    throw new MissingIntegrationError(`${label} did not resolve the exact retained Sandbox`, {
      environmentId: controlRef.environmentId,
    })
  }
  return box
}

async function prepareContinuityChallenge(client, controlRef, coordinates) {
  const box = await retainedBox(client, controlRef, 'Continuity challenge setup')
  const challenge = randomBytes(32).toString('hex')
  const bytes = `${challenge}\n`
  const path = continuityChallengePath(coordinates)
  const responsePath = continuityResponsePath(coordinates)
  await box.write(sandboxWorkspaceRelativePath(path), bytes)
  const readBack = await box.read(sandboxWorkspaceRelativePath(path))
  assert.equal(readBack, bytes, 'continuity challenge did not persist before the follow-up')
  return {
    path,
    responsePath,
    expectedDigest: sha256(bytes),
    bytes: Buffer.byteLength(bytes),
  }
}

async function listAllSandboxes(client) {
  const boxes = []
  const seenIds = new Set()
  let offset = 0
  for (;;) {
    const page = await client.list({ limit: SANDBOX_LIST_PAGE_SIZE, offset })
    if (!Array.isArray(page)) throw new Error('Sandbox list returned an invalid page')
    for (const box of page) {
      if (typeof box?.id === 'string') {
        if (seenIds.has(box.id)) throw new Error(`Sandbox list repeated ${box.id}`)
        seenIds.add(box.id)
      }
      boxes.push(box)
    }
    if (page.length < SANDBOX_LIST_PAGE_SIZE) return boxes
    offset += page.length
  }
}

async function verifyRetainedWorkspace(client, controlRef, coordinates, continuity) {
  const box = await retainedBox(client, controlRef, 'Workspace verification')
  const markerPath = workspaceMarkerPath(coordinates)
  const expectedMarker = `${coordinates.marker}\n`
  const [readValue, continuityResponse] = await Promise.all([
    box.read(sandboxWorkspaceRelativePath(markerPath)),
    box.read(sandboxWorkspaceRelativePath(continuity.responsePath)),
  ])
  const git = await box.exec(
    `set -eu; test "$(cat -- ${shellQuote(markerPath)})" = ${shellQuote(coordinates.marker)}; test "$(cat -- ${shellQuote(continuity.responsePath)})" = ${shellQuote(continuity.expectedDigest)}; test "$(git -C . rev-parse --is-inside-work-tree)" = true; git -C . status --short --untracked-files=no`,
  )
  const gitExitCode = Number.isInteger(git?.exitCode)
    ? git.exitCode
    : Number.isInteger(git?.code)
      ? git.code
      : undefined
  if (!Number.isInteger(gitExitCode)) {
    throw new MissingIntegrationError(
      'The Sandbox SDK did not expose the deterministic workspace Git exit code',
      { required: 'Sandbox exec exitCode' },
    )
  }
  let resourceSample
  let resourceSampleError
  try {
    resourceSample = await box.resourceUsage()
  } catch (error) {
    resourceSampleError = errorDetails(error)
  }
  return {
    environmentId: box.id,
    markerPath,
    readValue,
    readMatched: readValue === expectedMarker,
    continuity: {
      challengePath: continuity.path,
      responsePath: continuity.responsePath,
      challengeBytes: continuity.bytes,
      expectedDigest: continuity.expectedDigest,
      responseDigest: continuityResponse.trim(),
      matched: continuityResponse === `${continuity.expectedDigest}\n`,
    },
    git: {
      exitCode: gitExitCode,
      stdout: typeof git?.stdout === 'string' ? git.stdout : null,
    },
    resourceSample:
      resourceSample === undefined
        ? { status: 'missing' }
        : resourceSample === null
          ? { status: 'unavailable', value: null }
          : { status: 'observed', value: resourceSample },
    ...(resourceSampleError ? { resourceSampleError } : {}),
  }
}

function operationIds(proofId) {
  return {
    first: `op-${proofId}-turn-1`,
    reconnect: `op-${proofId}-reconnect-1`,
    followUp: `op-${proofId}-follow-up-1`,
    cancelSend: `op-${proofId}-cancel-send-1`,
    cancel: `op-${proofId}-cancel-1`,
  }
}

function runSnapshot(run, state, observation) {
  return {
    id: run?.id,
    operationId: run?.operationId,
    status: terminalStatus(run) ?? run?.status,
    environmentId: run?.environmentId,
    providerSessionId: run?.providerSessionId,
    materializationDigest: run?.materializationDigest,
    cursor: run?.cursor ?? observation?.cursor,
    controlRef: observation?.controlRef,
    observations: runObservations(run, state),
  }
}

function diagnosticText(value) {
  if (typeof value !== 'string') return undefined
  const text = [...value]
    .filter((character) => {
      const code = character.codePointAt(0)
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
    })
    .join('')
    .trim()
  if (text.length === 0) return undefined
  return text
    .replace(
      /\b(authorization|bearer|token|api[-_ ]*key|password|passphrase|secret|credential)\b\s*[:=]?\s*(?:bearer\s+)?[^\s,;]+/giu,
      '$1=[redacted]',
    )
    .slice(0, 512)
}

export function cloudFailureEventTimeline(responses, runId) {
  return (responses ?? [])
    .filter((response) => response?.type === 'event')
    .flatMap((response) => {
      const event = response.event
      if (!event || typeof event !== 'object' || Array.isArray(event)) return []
      const payload =
        event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? event.payload
          : event
      const value =
        payload.value && typeof payload.value === 'object' && !Array.isArray(payload.value)
          ? payload.value
          : undefined
      const eventRunId =
        typeof payload.runId === 'string'
          ? payload.runId
          : typeof value?.runId === 'string'
            ? value.runId
            : undefined
      if (eventRunId !== undefined && eventRunId !== runId) return []
      const kind = diagnosticText(event.kind)
      if (kind === undefined) return []
      const fields = Object.fromEntries(
        ['status', 'detail', 'error', 'reason', 'code'].flatMap((name) => {
          const field = diagnosticText(payload[name] ?? value?.[name])
          return field === undefined ? [] : [[name, field]]
        }),
      )
      return [
        {
          ...(Number.isSafeInteger(response.sequence) ? { sequence: response.sequence } : {}),
          kind,
          ...(eventRunId === undefined ? {} : { runId: eventRunId }),
          ...fields,
        },
      ]
    })
    .slice(-30)
}

function failureDiagnostics(session, runId) {
  if (!session) return undefined
  const responses = session.responses ?? []
  const stateResponse = [...responses]
    .reverse()
    .find(
      (response) =>
        response?.type === 'state' && response.state?.runs?.some((run) => run.id === runId),
    )
  const run = stateResponse?.state?.runs?.find((candidate) => candidate.id === runId)
  const errors = responses
    .filter((response) => response?.type === 'error')
    .slice(-5)
    .map((response) => ({
      requestId: response.requestId,
      code: response.code,
      message: response.message,
    }))
  const stderr = session.stderr?.slice(-8_192).trim()
  const eventTimeline = cloudFailureEventTimeline(responses, runId)
  return {
    responseCount: responses.length,
    ...(run ? { run: runSnapshot(run, stateResponse.state) } : {}),
    ...(errors.length > 0 ? { errors } : {}),
    ...(eventTimeline.length > 0 ? { eventTimeline } : {}),
    ...(stderr ? { stderr } : {}),
  }
}

function safeExecutionId(value) {
  return value.replace(/[^A-Za-z0-9._:-]/gu, '-').slice(0, 128) || 'run'
}

function expectedResourceIdentityForSession(providerSessionId, id) {
  return {
    ...(id === undefined ? {} : { id }),
    name: `braid-${safeExecutionId(providerSessionId)}`,
    metadata: {
      owner: BRAID_RESOURCE_OWNER,
      lifecycle: RETAINED_LIFECYCLE,
      providerSessionId,
    },
  }
}

function matchesResourceIdentity(box, expected) {
  return (
    typeof box?.id === 'string' &&
    (expected.id === undefined || box.id === expected.id) &&
    box.name === expected.name &&
    box.metadata?.owner === expected.metadata.owner &&
    box.metadata?.lifecycle === expected.metadata.lifecycle &&
    box.metadata?.providerSessionId === expected.metadata.providerSessionId
  )
}

function retainedResourceIdentity(box, controlRef) {
  return matchesResourceIdentity(box, expectedResourceIdentity(controlRef))
}

function expectedResourceIdentity(controlRef) {
  return expectedResourceIdentityForSession(controlRef.sessionId, controlRef.environmentId)
}

async function observeRetainedResource(client, controlRef) {
  if (!client) {
    throw new MissingIntegrationError(
      'No cleanup credential is available to verify the exact retained Braid Sandbox resource',
      { required: 'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY or TANGLE_API_KEY' },
    )
  }
  if (!controlRef?.environmentId || !controlRef.sessionId) {
    throw new MissingIntegrationError(
      'Braid did not expose the exact retained Sandbox control identity',
      { required: ['controlRef.environmentId', 'controlRef.sessionId'] },
    )
  }
  const box = await client.get(controlRef.environmentId)
  if (!box) {
    throw new MissingIntegrationError(
      `Sandbox environment ${controlRef.environmentId} was not visible to the cleanup client`,
      { environmentId: controlRef.environmentId },
    )
  }
  if (!retainedResourceIdentity(box, controlRef)) {
    throw new MissingIntegrationError(
      `Braid-created Sandbox ${controlRef.environmentId} does not match the retained Braid resource identity`,
      {
        expected: expectedResourceIdentity(controlRef),
        observed: { id: box.id, name: box.name, metadata: box.metadata },
      },
    )
  }
  return { observed: true, ...expectedResourceIdentity(controlRef) }
}

export async function cleanupRetainedResourceByRunId(client, firstRunId) {
  if (!client) {
    throw new MissingIntegrationError(
      'Fail-safe retained Braid Sandbox cleanup has no cleanup client',
      { required: 'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY or TANGLE_API_KEY' },
    )
  }
  if (typeof firstRunId !== 'string' || firstRunId.length === 0) {
    throw new MissingIntegrationError(
      'Fail-safe retained Braid Sandbox cleanup has no first local run ID',
      { required: 'first local run ID' },
    )
  }
  const providerSessionId = `session-braid-${safeExecutionId(firstRunId)}`
  const expected = expectedResourceIdentityForSession(providerSessionId)
  const matches = (await listAllSandboxes(client)).filter((box) =>
    matchesResourceIdentity(box, expected),
  )
  if (matches.length !== 1) {
    throw new MissingIntegrationError(
      'Fail-safe cleanup did not find exactly one Braid-owned retained Sandbox for the first local run',
      {
        expected,
        matches: matches.map((box) => ({ id: box.id, name: box.name, metadata: box.metadata })),
      },
    )
  }
  const listed = matches[0]
  const exact = await client.get(listed.id)
  const exactExpected = expectedResourceIdentityForSession(providerSessionId, listed.id)
  if (!exact || !matchesResourceIdentity(exact, exactExpected)) {
    throw new MissingIntegrationError(
      'Fail-safe cleanup identity changed after the exact Sandbox list lookup',
      {
        expected: exactExpected,
        observed: exact ? { id: exact.id, name: exact.name, metadata: exact.metadata } : null,
      },
    )
  }
  await exact.delete()
  const remaining = await client.get(listed.id)
  if (remaining !== null) {
    throw new Error(`Fail-safe retained Braid Sandbox ${listed.id} remained after delete`)
  }
  return {
    confirmed: true,
    mode: 'first-run-identity-lookup',
    ...exactExpected,
  }
}

function ownedByOperation(box, operationId) {
  return (
    typeof operationId === 'string' &&
    box?.metadata?.owner === BRAID_RESOURCE_OWNER &&
    box.metadata?.lifecycle === RETAINED_LIFECYCLE &&
    box.metadata?.braidOperationId === operationId
  )
}

async function deleteOwnedResource(client, box, predicate) {
  const attempts = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const exact = await client.get(box.id)
    if (exact === null) return { id: box.id, attempts, confirmed: true }
    if (!predicate(exact)) {
      throw new MissingIntegrationError(
        `Refusing to delete Sandbox ${box.id} because its exact ownership changed`,
        { id: box.id },
      )
    }
    try {
      await exact.delete()
      attempts.push({ attempt, deleted: true })
    } catch (error) {
      attempts.push({ attempt, deleted: false, error: errorDetails(error) })
    }
    const deadline = performance.now() + 5_000
    while (performance.now() < deadline) {
      if ((await client.get(box.id)) === null) return { id: box.id, attempts, confirmed: true }
      await sleep(100)
    }
  }
  return { id: box.id, attempts, confirmed: false }
}

async function cleanupOwnedRetainedResources(client, { controlRef, firstRunId, operationId }) {
  if (!client) {
    throw new MissingIntegrationError('Retained Sandbox cleanup has no authenticated client', {
      required: 'the execution Sandbox credential',
    })
  }
  const expectedSessionId =
    typeof firstRunId === 'string' ? `session-braid-${safeExecutionId(firstRunId)}` : undefined
  const predicate = (box) =>
    (controlRef !== undefined && retainedResourceIdentity(box, controlRef)) ||
    (expectedSessionId !== undefined &&
      matchesResourceIdentity(box, expectedResourceIdentityForSession(expectedSessionId))) ||
    ownedByOperation(box, operationId)
  const listed = (await listAllSandboxes(client)).filter(predicate)
  if (controlRef?.environmentId) {
    const exact = await client.get(controlRef.environmentId)
    if (exact && !listed.some((box) => box.id === exact.id)) {
      if (!predicate(exact)) {
        throw new MissingIntegrationError(
          'The exact control resource failed ownership validation',
          {
            environmentId: controlRef.environmentId,
          },
        )
      }
      listed.push(exact)
    }
  }
  const deletions = []
  for (const box of listed) deletions.push(await deleteOwnedResource(client, box, predicate))
  const remaining = (await listAllSandboxes(client)).filter(predicate)
  const confirmed = deletions.every((entry) => entry.confirmed) && remaining.length === 0
  if (!confirmed) {
    throw new MissingIntegrationError('Exact retained Sandbox cleanup did not converge', {
      deletions,
      remaining: remaining.map((box) => box.id),
    })
  }
  return {
    confirmed,
    mode: 'exact-owned-resource-set',
    matchedCount: listed.length,
    removedIds: listed.map((box) => box.id),
    deletions,
    remainingIds: [],
  }
}

async function usage(client, phase) {
  if (!client) return { phase, value: undefined, error: undefined }
  try {
    return { phase, value: await client.usage(), error: undefined }
  } catch (error) {
    return { phase, value: undefined, error: errorDetails(error) }
  }
}

function publicAccountIdentity(value) {
  if (!value || typeof value !== 'object') return undefined
  const customerId = typeof value.customerId === 'string' ? value.customerId : undefined
  const billingOwnerId = typeof value.billingOwnerId === 'string' ? value.billingOwnerId : undefined
  if (!customerId || !billingOwnerId) return undefined
  return {
    customerId,
    billingOwnerId,
    ...(typeof value.billingDelegationAuthorized === 'boolean'
      ? { billingDelegationAuthorized: value.billingDelegationAuthorized }
      : {}),
  }
}

function accountIdentityDigest(value) {
  return createHash('sha256').update(`${value.customerId}:${value.billingOwnerId}`).digest('hex')
}

function publicAccountIdentityEvidence(value) {
  return {
    identityDigest: accountIdentityDigest(value),
    ...(typeof value.billingDelegationAuthorized === 'boolean'
      ? { billingDelegationAuthorized: value.billingDelegationAuthorized }
      : {}),
  }
}

async function accountIdentity(client, phase) {
  if (!client) return { phase, value: undefined, error: undefined }
  try {
    return { phase, value: publicAccountIdentity(await client.getIdentity()), error: undefined }
  } catch (error) {
    return { phase, value: undefined, error: errorDetails(error) }
  }
}

function assertStableAccountIdentity(records) {
  const before = records.find((entry) => entry.phase === 'before')
  const after = records.find((entry) => entry.phase === 'after')
  if (!before?.value?.customerId || !before.value.billingOwnerId) {
    throw new MissingIntegrationError('Sandbox account identity was unavailable before execution', {
      observation: before,
    })
  }
  if (!after?.value?.customerId || !after.value.billingOwnerId) {
    throw new MissingIntegrationError('Sandbox account identity was unavailable after cleanup', {
      observation: after,
    })
  }
  assert.equal(after.value.customerId, before.value.customerId, 'Sandbox customer changed mid-run')
  assert.equal(
    after.value.billingOwnerId,
    before.value.billingOwnerId,
    'Sandbox billing owner changed mid-run',
  )
  return {
    stable: true,
    identityDigest: accountIdentityDigest(before.value),
  }
}

function assertSameAccount(state, run, directIdentity) {
  const environment = state.environments?.find((candidate) => candidate.id === run?.environmentId)
  const observed = environment?.accountUsage
  if (!directIdentity || !observed?.customerId || !observed.billingOwnerId) {
    throw new MissingIntegrationError(
      'Braid did not expose the Sandbox account used for execution and cleanup',
      { required: ['customerId', 'billingOwnerId'] },
    )
  }
  assert.equal(observed.customerId, directIdentity.customerId, 'Sandbox customer identity changed')
  assert.equal(
    observed.billingOwnerId,
    directIdentity.billingOwnerId,
    'Sandbox billing owner identity changed',
  )
  return {
    identityDigest: accountIdentityDigest(observed),
    usage: {
      computeMinutes: observed.computeMinutes ?? null,
      gpuSeconds: observed.gpuSeconds ?? null,
      gpuCostUsd: observed.gpuCostUsd ?? null,
      activeSandboxes: observed.activeSandboxes ?? null,
      totalSandboxes: observed.totalSandboxes ?? null,
    },
    sampledAt: observed.sampledAt,
  }
}

function toolEvidence(observation, label) {
  const events = workspaceToolEvents(observation)
  if (events.length === 0) {
    throw new MissingIntegrationError(`${label} exposed no provider-bound workspace tool event`, {
      required: ['run.tool.call', 'run.tool.result', 'run.part.updated:tool'],
    })
  }
  return events
}

export function assertExactRemoteStatus(status, controlRef, label = 'remote execution') {
  if (!status) {
    throw new MissingIntegrationError(`${label} status was unavailable`, {
      executionId: controlRef.executionId,
    })
  }
  assert.equal(
    status.latestExecutionId,
    controlRef.executionId,
    `${label} status described another execution`,
  )
  assertSameControlRef(controlRef, status.runControlRef, `${label} status`)
  return status
}

async function verifyRemoteCancellation(client, controlRef, marker, timeoutMs) {
  const box = await retainedBox(client, controlRef, 'Remote cancellation verification')
  const session = box.session(controlRef.sessionId)
  const deadline = performance.now() + Math.min(timeoutMs, 15_000)
  const samples = []
  for (;;) {
    const status = await session.status()
    assertExactRemoteStatus(status, controlRef, 'remote cancellation')
    samples.push({
      status: status.status,
      activeExecutionId: status.activeExecutionId ?? null,
      latestExecutionId: status.latestExecutionId,
      observedAt: new Date().toISOString(),
    })
    if (status?.status === 'cancelled') break
    if (performance.now() >= deadline) {
      throw new MissingIntegrationError('The exact cloud execution did not become cancelled', {
        controlRef,
        samples,
      })
    }
    await sleep(Math.min(250, Math.max(25, deadline - performance.now())))
  }
  await sleep(1_000)
  const [settledStatus, exactResult, messages] = await Promise.all([
    session.status(),
    session.result({ executionId: controlRef.executionId }),
    box.messages({ sessionId: controlRef.sessionId, limit: 100 }),
  ])
  assertExactRemoteStatus(settledStatus, controlRef, 'settled remote cancellation')
  assert.equal(settledStatus?.status, 'cancelled', 'remote cancellation did not remain terminal')
  assert.equal(
    exactResult.executionId,
    controlRef.executionId,
    'remote cancellation result described another execution',
  )
  assert.equal(exactResult.success, false, 'cancelled remote execution reported success')
  const lateResult = messages
    .filter((message) => message?.role === 'assistant')
    .some((message) => JSON.stringify(message).includes(marker))
  assert.equal(lateResult, false, 'a late provider result arrived after cancellation')
  return {
    controlRef,
    samples,
    settledStatus: settledStatus?.status ?? null,
    exactResult: {
      executionId: exactResult.executionId,
      status: exactResult.status,
      success: exactResult.success,
      ...(typeof exactResult.errorCode === 'string' ? { errorCode: exactResult.errorCode } : {}),
    },
    messageCount: messages.length,
    lateResult,
  }
}

function durationMs(run) {
  const start = Date.parse(run?.startedAt ?? '')
  const end = Date.parse(run?.terminalAt ?? run?.updatedAt ?? '')
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined
}

function runSpend(run, label) {
  const inputTokens = run?.inputTokens
  const outputTokens = run?.outputTokens
  const costUsd = run?.costUsd
  const elapsed = durationMs(run)
  const tokens =
    run?.tokensKnown === false
      ? { status: 'unavailable' }
      : Number.isSafeInteger(inputTokens) &&
          inputTokens >= 0 &&
          Number.isSafeInteger(outputTokens) &&
          outputTokens >= 0
        ? { status: 'observed', input: inputTokens, output: outputTokens }
        : { status: 'missing' }
  const cost =
    run?.usdKnown === false
      ? { status: 'unavailable' }
      : typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0
        ? {
            status: 'observed',
            usd: costUsd,
            provenance: run?.costStatus ?? 'reported',
          }
        : { status: 'missing' }
  return {
    label,
    runId: run?.id ?? null,
    operationId: run?.operationId ?? null,
    status: run?.status ?? null,
    model: run?.model ?? null,
    runner: run?.runner ?? null,
    providerSessionId: run?.providerSessionId ?? null,
    tokens,
    cost,
    duration:
      elapsed === undefined ? { status: 'missing' } : { status: 'observed', milliseconds: elapsed },
  }
}

export function spendDisclosure(runs) {
  const rows = [
    runSpend(runs.resumed, 'resumed-first-turn'),
    runSpend(runs.followUp, 'follow-up-turn'),
    runSpend(runs.cancelled, 'cancelled-turn'),
  ]
  const observedTokens = rows.filter((row) => row.tokens.status === 'observed')
  const observedCosts = rows.filter((row) => row.cost.status === 'observed')
  return {
    scope: 'all unique local runs in this cloud proof',
    rows,
    totals: {
      tokens: {
        observedRuns: observedTokens.length,
        unavailableRuns: rows.filter((row) => row.tokens.status === 'unavailable').length,
        missingRuns: rows.filter((row) => row.tokens.status === 'missing').length,
        input: observedTokens.reduce((total, row) => total + row.tokens.input, 0),
        output: observedTokens.reduce((total, row) => total + row.tokens.output, 0),
      },
      cost: {
        observedRuns: observedCosts.length,
        unavailableRuns: rows.filter((row) => row.cost.status === 'unavailable').length,
        missingRuns: rows.filter((row) => row.cost.status === 'missing').length,
        usd: observedCosts.reduce((total, row) => total + row.cost.usd, 0),
      },
    },
  }
}

export function telemetryDisclosure(
  run,
  state,
  workspaceVerification,
  account,
  { allowInFlight = false } = {},
) {
  const environment = state.environments?.find((candidate) => candidate.id === run?.environmentId)
  const unavailable = environment?.unavailableTelemetry ?? []
  const unavailableByPrefix = (prefix) => unavailable.some((entry) => entry.startsWith(prefix))
  const elapsed = durationMs(run)
  const fields = {
    tokens:
      run?.tokensKnown === false
        ? { status: 'unavailable' }
        : Number.isSafeInteger(run?.inputTokens) &&
            run.inputTokens >= 0 &&
            Number.isSafeInteger(run?.outputTokens) &&
            run.outputTokens >= 0
          ? { status: 'observed', input: run.inputTokens, output: run.outputTokens }
          : allowInFlight
            ? { status: 'in-flight' }
            : { status: 'missing' },
    cost:
      run?.usdKnown === false
        ? { status: 'unavailable' }
        : typeof run?.costUsd === 'number' && Number.isFinite(run.costUsd) && run.costUsd >= 0
          ? { status: 'observed', usd: run.costUsd }
          : allowInFlight
            ? { status: 'in-flight' }
            : { status: 'missing' },
    endToEndDuration:
      elapsed === undefined
        ? allowInFlight
          ? { status: 'in-flight' }
          : { status: 'missing' }
        : { status: 'observed', milliseconds: elapsed },
    model:
      typeof run?.model === 'string'
        ? { status: 'observed', value: run.model }
        : { status: 'missing' },
    environment:
      typeof environment?.providerEnvironmentId === 'string'
        ? { status: 'observed', value: environment.providerEnvironmentId }
        : { status: 'missing' },
    runtimeEndpoint:
      typeof environment?.runtimeEndpointHost === 'string'
        ? { status: 'observed', host: environment.runtimeEndpointHost }
        : { status: 'missing' },
    machine:
      typeof environment?.machineId === 'string'
        ? { status: 'observed', value: environment.machineId }
        : unavailableByPrefix('machine-id:')
          ? { status: 'unavailable' }
          : { status: 'missing' },
    region:
      typeof environment?.placement?.region === 'string'
        ? { status: 'observed', value: environment.placement.region }
        : unavailableByPrefix('verified-region:')
          ? { status: 'unavailable' }
          : { status: 'missing' },
    requestedResources:
      environment?.requestedResources === undefined
        ? { status: 'provider-default' }
        : { status: 'observed', value: environment.requestedResources },
    resourceSample: workspaceVerification.resourceSample,
    account: { status: 'observed', value: account },
  }
  const missing = Object.entries(fields)
    .filter(
      ([name, value]) =>
        value.status === 'missing' || (name === 'resourceSample' && value?.status === 'missing'),
    )
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new MissingIntegrationError('Required Sandbox telemetry was silently missing', {
      missing,
      unavailable,
    })
  }
  return { completeDisclosure: true, fields, unavailable }
}

export function assertVerifiedProcessCleanup(result, label) {
  if (
    result?.termination?.exited !== true ||
    result.termination.descendantsVerified !== true ||
    result?.exit?.timeout === true
  ) {
    throw new MissingIntegrationError(`${label} did not prove complete process-tree cleanup`, {
      termination: result?.termination,
      exit: result?.exit,
    })
  }
  return {
    cleanupStatus: result.termination.cleanupStatus,
    exited: true,
    descendantsVerified: true,
    exit: result.exit,
  }
}

export async function closeBraidWithProof(session, label) {
  let shutdownError
  try {
    await closeSession(session)
  } catch (error) {
    shutdownError = error
  }
  const cleanup = assertVerifiedProcessCleanup(await session.close(), label)
  if (shutdownError !== undefined) {
    if (
      shutdownError !== null &&
      (typeof shutdownError === 'object' || typeof shutdownError === 'function')
    ) {
      Object.defineProperty(shutdownError, 'processCleanup', {
        configurable: true,
        enumerable: false,
        value: cleanup,
      })
    }
    throw shutdownError
  }
  return cleanup
}

async function killFirstBraid(session) {
  if (!session?.child) throw new Error('The first Braid process was not started')
  const sent = session.child.kill('SIGKILL')
  const exit = await session.exit
  const cleanup = assertVerifiedProcessCleanup(await session.close(), 'SIGKILL Braid process')
  assert.equal(sent, true, 'SIGKILL was not sent to the first Braid process')
  assert.equal(exit.signal, 'SIGKILL', `first Braid process exited with ${JSON.stringify(exit)}`)
  return { signal: exit.signal, code: exit.code, sent, cleanup }
}

function assertAck(result, command) {
  if (result.response.type === 'error') {
    throw new Error(`${command} failed: ${result.response.code}: ${result.response.message}`)
  }
  assert.equal(result.response.type, 'ack', `${command} did not return an acknowledgement`)
  return result.response
}

export function assertRestartedCancellationRun(run, controlRef) {
  assert.ok(run, 'fresh cancellation process did not restore the cancelled run')
  assert.ok(
    ['aborted', 'cancelled'].includes(run.status),
    `fresh cancellation process restored ${run.status ?? 'missing'}`,
  )
  assertSameControlRef(controlRef, run.controlRef, 'cancellation restart')
  return run
}

function localRunCount(state, runId) {
  return (state?.runs ?? []).filter((run) => run.id === runId).length
}

function assistantMarker(state, runId) {
  return [...(state?.messages ?? [])]
    .reverse()
    .find((message) => message.runId === runId && message.role === 'assistant')?.text
}

export function runIdForOperation(state, operationId) {
  const matches = (state?.runs ?? []).filter((run) => run.operationId === operationId)
  if (matches.length > 1) {
    throw new MissingIntegrationError(
      'Durable cleanup found more than one Braid run for one operation identity',
      { operationId, runIds: matches.map((run) => run.id) },
    )
  }
  return matches[0]?.id
}

function collectIntegrationNeed(error, needs) {
  if (error instanceof MissingIntegrationError) {
    const fields = (value) => (Array.isArray(value) ? value : value === undefined ? [] : [value])
    for (const field of [...fields(error.details?.missing), ...fields(error.details?.required)])
      needs.push(String(field))
    needs.push(error.message)
  }
  if (error instanceof Error && /OPERATION_CONFLICT/iu.test(error.message)) {
    needs.push('Braid must preserve operation-body conflict semantics for retry-safe cancellation')
  }
}

export async function runBraidSandboxStress({
  environment = process.env,
  repository: suppliedRepository = repository,
  binary: suppliedBinary,
  requireZeroActiveResourceDelta = false,
} = {}) {
  const startedAt = performance.now()
  const coordinates = proofCoordinates()
  const ids = operationIds(coordinates.proofId)
  const holdMs = numberEnvironment(
    environment,
    'BRAID_TANGLE_SANDBOX_STRESS_HOLD_MS',
    DEFAULT_HOLD_MS,
  )
  const timeoutMs = numberEnvironment(
    environment,
    'BRAID_LIVE_REQUIRED_TIMEOUT_MS',
    DEFAULT_TIMEOUT_MS,
  )
  const idleTtlSeconds = numberEnvironment(
    environment,
    'BRAID_TANGLE_SANDBOX_IDLE_TTL_SECONDS',
    DEFAULT_IDLE_TTL_SECONDS,
  )
  if (!Number.isSafeInteger(idleTtlSeconds) || idleTtlSeconds < 60 || idleTtlSeconds > 604_800) {
    throw new Error('BRAID_TANGLE_SANDBOX_IDLE_TTL_SECONDS must be an integer from 60 to 604800')
  }
  const prompts = proofPrompts(coordinates, holdMs)
  const phases = {}
  const unresolvedIntegrationNeeds = []
  const usageRecords = []
  const identityRecords = []
  const values = sandboxConfiguration(environment)
  let config
  let binary
  let client
  let firstSession
  let freshSession
  let retrySession
  let firstRunId
  let cancelRunId
  let knownEnvironmentId
  let firstObservation
  let freshObservation
  let firstResponses
  let firstVisible
  let freshVisible
  let workspaceVerification
  let continuity
  let account
  let telemetry
  let followUpVisible
  let remoteCancellation
  let cancelledProcessCleanup
  let retryProcessCleanup
  let resumeFromCursor
  let finalCursor
  let resumeIntersection
  let resumeProgress
  let tagObservation
  let accountIdentityConsistency
  let accountIdentityError
  let cleanupConfirmed = false
  let cleanupMode
  let cleanupIdentity
  let cleanupError
  let failure
  let diagnostics
  let finalUsage
  let result
  let binarySha256
  let firstSendAttempted = false
  let cleanupRecovery
  const failureProcessCleanup = {}

  const phase = async (name, task) => {
    const start = performance.now()
    try {
      return await task()
    } finally {
      phases[name] = { elapsedMs: performance.now() - start }
    }
  }

  try {
    client = sandboxClient(values)
    if (!client) {
      throw new MissingIntegrationError(
        'Retained stress requires the same credential value that Braid installs for execution',
        {
          required:
            'BRAID_TANGLE_SANDBOX_API_KEY or TANGLE_API_KEY; an independent cleanup credential is not admissible proof',
        },
      )
    }
    usageRecords.push(await usage(client, 'before'))
    identityRecords.push(await accountIdentity(client, 'before'))
    binary = suppliedBinary ?? (await resolveBinary(suppliedRepository, environment))
    binarySha256 = sha256(await readFile(binary))
    config = await phase('workspace', () =>
      prepareProductionWorkspace({
        repository: suppliedRepository,
        environment: sanitizedEnvironment(environment),
        ...values,
        providerOptions: { lifecycle: RETAINED_LIFECYCLE, idleTtlSeconds },
      }),
    )

    const first = await phase('firstProcess.initialize', () => initializedSession(binary, config))
    firstSession = first.session
    const initialState = first.state.state
    firstSendAttempted = true
    const send = await phase('firstProcess.send', () =>
      rpcRoundTrip(
        firstSession,
        'send',
        {
          conversationId: initialState.conversationId,
          branchId: initialState.branchId,
          text: prompts.first,
        },
        ids.first,
        'first send acknowledgement',
      ),
    )
    const sendAck = assertAck(send, 'send')
    firstRunId = sendAck.runId
    assert.equal(typeof firstRunId, 'string', 'first send acknowledgement has no local run ID')

    firstObservation = await phase('firstProcess.observeControl', () =>
      waitForControlIdentity(firstSession, firstRunId, timeoutMs),
    )
    knownEnvironmentId = firstObservation.controlRef.environmentId
    try {
      tagObservation = await observeRetainedResource(client, firstObservation.controlRef)
    } catch (error) {
      collectIntegrationNeed(error, unresolvedIntegrationNeeds)
      tagObservation = { observed: false, error: errorDetails(error) }
    }

    const firstStateBeforeVisible = await stateRoundTrip(firstSession)
    const firstRunBeforeVisible = firstStateBeforeVisible.state.runs?.find(
      (run) => run.id === firstRunId,
    )
    assertNonTerminalRun(firstRunBeforeVisible, 'first Braid run')
    assert.equal(localRunCount(firstStateBeforeVisible.state, firstRunId), 1)
    await phase('firstProcess.waitVisible', () =>
      waitForWorkspaceToolEvents(firstSession, firstRunId, timeoutMs, 'first process'),
    )
    const firstState = await stateRoundTrip(firstSession)
    const firstRun = firstState.state.runs?.find((run) => run.id === firstRunId)
    assertNonTerminalRun(firstRun, 'first Braid run')
    assert.equal(localRunCount(firstState.state, firstRunId), 1)
    const persistedCursor = firstRun?.cursor
    resumeFromCursor = persistedCursor
    if (
      resumeFromCursor === undefined ||
      !Number.isSafeInteger(firstRun?.cursorCommittedSequence) ||
      firstRun.cursorCommittedSequence < 1 ||
      firstRun.cursorCommittedSequence > firstState.state.sequence
    ) {
      throw new MissingIntegrationError(
        'The pre-kill Braid process did not persist one acknowledged provider resume cursor',
        {
          runId: firstRunId,
          required: ['run.cursor', 'run.cursorCommittedSequence'],
        },
      )
    }
    assert.equal(
      latestCursorFromResponses(firstSession.responses, firstRunId),
      resumeFromCursor,
      'persisted cursor differs from the latest canonical provider cursor',
    )
    firstObservation = { ...firstObservation, cursor: resumeFromCursor }
    assertEnvironmentIdentity(firstRun, firstState.state, firstObservation.controlRef, 'first run')
    const firstSnapshot = runSnapshot(firstRun, firstState.state, firstObservation)
    firstResponses = [...firstSession.responses]
    firstVisible = assertUniqueVisibleEvents(firstResponses, firstRunId, 'first process')
    assertNonVacuousVisibleEvents(firstVisible, 'pre-kill replay')
    toolEvidence(firstVisible, 'First process')

    const killed = await phase('firstProcess.sigkill', () => killFirstBraid(firstSession))
    firstSession = undefined

    const fresh = await phase('freshProcess.initialize', () => initializedSession(binary, config))
    freshSession = fresh.session
    const freshInitialState = fresh.state.state
    assert.equal(
      localRunCount(freshInitialState, firstRunId),
      1,
      'fresh process created duplicate local runs',
    )
    const reconnect = await phase('freshProcess.reconnect', () =>
      rpcRoundTrip(
        freshSession,
        'reconnect',
        { runId: firstRunId },
        ids.reconnect,
        'reconnect acknowledgement',
      ),
    )
    assertAck(reconnect, 'reconnect')
    const freshTerminal = await phase('freshProcess.waitTerminal', () =>
      waitForTerminal(freshSession, firstRunId, timeoutMs),
    )
    const freshRun = freshTerminal.run
    assert.equal(
      freshRun?.status,
      'completed',
      `reconnected run ended ${freshRun?.status ?? 'missing'}`,
    )
    assert.equal(assistantMarker(freshTerminal.response.state, firstRunId), coordinates.marker)
    assert.equal(localRunCount(freshTerminal.response.state, firstRunId), 1)
    freshObservation = await phase('freshProcess.observeControl', () =>
      waitForControlIdentity(freshSession, firstRunId, timeoutMs),
    )
    assertSameControlRef(firstObservation.controlRef, freshObservation.controlRef, 'reconnect')
    assertEnvironmentIdentity(
      freshRun,
      freshTerminal.response.state,
      freshObservation.controlRef,
      'reconnected run',
    )
    finalCursor =
      latestCursorFromResponses(freshSession.responses, firstRunId) ??
      freshRun?.cursor ??
      freshObservation.cursor
    freshVisible = assertUniqueVisibleEvents(freshSession.responses, firstRunId, 'fresh process')
    assertNonVacuousVisibleEvents(freshVisible, 'fresh-process replay')
    resumeIntersection = assertExclusiveResume(firstVisible.keys, freshVisible.keys)
    resumeProgress = assertProviderResumeProgress(
      firstResponses,
      freshSession.responses,
      firstRunId,
      resumeFromCursor,
    )
    const freshState = await stateRoundTrip(freshSession)
    const firstRunCountAfterReplay = localRunCount(freshState.state, firstRunId)
    assert.equal(firstRunCountAfterReplay, 1, 'reconnect left more than one local run')

    continuity = await phase('followUp.prepareContinuityChallenge', () =>
      prepareContinuityChallenge(client, freshObservation.controlRef, coordinates),
    )

    const followUp = await phase('followUp.send', () =>
      rpcRoundTrip(
        freshSession,
        'send',
        {
          conversationId: freshState.state.conversationId,
          branchId: freshState.state.branchId,
          text: prompts.followUp,
        },
        ids.followUp,
        'follow-up send acknowledgement',
      ),
    )
    const followUpAck = assertAck(followUp, 'follow-up send')
    const followUpRunId = followUpAck.runId
    assert.equal(typeof followUpRunId, 'string', 'follow-up send acknowledgement has no run ID')
    const followUpTerminal = await phase('followUp.waitTerminal', () =>
      waitForTerminal(freshSession, followUpRunId, timeoutMs),
    )
    assert.equal(followUpTerminal.run?.status, 'completed')
    assert.equal(
      assistantMarker(followUpTerminal.response.state, followUpRunId),
      continuity.expectedDigest,
    )
    const followUpObservation = await phase('followUp.observeControl', () =>
      waitForControlIdentity(freshSession, followUpRunId, timeoutMs),
    )
    assertEnvironmentIdentity(
      followUpTerminal.run,
      followUpTerminal.response.state,
      followUpObservation.controlRef,
      'follow-up run',
    )
    assertSameCloudSession(firstObservation.controlRef, followUpObservation.controlRef, 'follow-up')
    assert.equal(
      followUpTerminal.run?.environmentId,
      firstRun?.environmentId,
      'follow-up changed the local Braid environment record',
    )
    assert.equal(
      followUpTerminal.run?.providerSessionId,
      firstRun?.providerSessionId,
      'follow-up changed the Braid provider session ID',
    )
    followUpVisible = assertUniqueVisibleEvents(
      freshSession.responses,
      followUpRunId,
      'follow-up run',
    )
    assertNonVacuousVisibleEvents(followUpVisible, 'follow-up run')
    toolEvidence(followUpVisible, 'Follow-up run')
    workspaceVerification = await phase('followUp.verifyWorkspace', () =>
      verifyRetainedWorkspace(client, followUpObservation.controlRef, coordinates, continuity),
    )
    assert.equal(workspaceVerification.readMatched, true, 'SDK read did not match the marker')
    assert.equal(
      workspaceVerification.continuity.matched,
      true,
      'follow-up did not materialize the hidden continuity challenge',
    )
    assert.equal(workspaceVerification.git.exitCode, 0, 'SDK Git/read verification failed')
    account = assertSameAccount(
      followUpTerminal.response.state,
      followUpTerminal.run,
      identityRecords[0]?.value,
    )
    const cancelSend = await phase('cancel.send', () =>
      rpcRoundTrip(
        freshSession,
        'send',
        {
          conversationId: followUpTerminal.response.state.conversationId,
          branchId: followUpTerminal.response.state.branchId,
          text: prompts.cancel,
        },
        ids.cancelSend,
        'cancel send acknowledgement',
      ),
    )
    const cancelSendAck = assertAck(cancelSend, 'cancel send')
    cancelRunId = cancelSendAck.runId
    assert.equal(typeof cancelRunId, 'string', 'cancel send acknowledgement has no run ID')
    const cancelObservation = await phase('cancel.observeControl', () =>
      waitForControlIdentity(freshSession, cancelRunId, timeoutMs),
    )
    const cancelState = await stateRoundTrip(freshSession)
    const cancelRun = cancelState.state.runs?.find((run) => run.id === cancelRunId)
    assertEnvironmentIdentity(
      cancelRun,
      cancelState.state,
      cancelObservation.controlRef,
      'cancel run before cancellation',
    )
    assertNonTerminalRun(cancelRun, 'cancel run before cancellation')
    const cancel = await phase('cancel.first', () =>
      rpcRoundTrip(
        freshSession,
        'cancel_run',
        { runId: cancelRunId, reason: `Braid live cancellation ${coordinates.proofId}` },
        ids.cancel,
        'first cancel acknowledgement',
      ),
    )
    const cancelAck = assertAck(cancel, 'cancel_run')
    assert.equal(cancelAck.runId, cancelRunId)
    const cancelled = await phase('cancel.waitTerminal', () =>
      waitForTerminal(freshSession, cancelRunId, timeoutMs),
    )
    assert.ok(
      ['aborted', 'cancelled'].includes(cancelled.run?.status),
      `cancel ended ${cancelled.run?.status}`,
    )
    remoteCancellation = await phase('cancel.verifyRemote', () =>
      verifyRemoteCancellation(
        client,
        cancelObservation.controlRef,
        coordinates.cancelMarker,
        timeoutMs,
      ),
    )

    cancelledProcessCleanup = await phase('cancel.restart.closeFirstProcess', () =>
      closeBraidWithProof(freshSession, 'pre-retry cancellation process'),
    )
    freshSession = undefined
    const retry = await phase('cancel.restart.initialize', () => initializedSession(binary, config))
    retrySession = retry.session
    const retryState = await stateRoundTrip(retrySession)
    const retryRun = retryState.state.runs?.find((run) => run.id === cancelRunId)
    assertRestartedCancellationRun(retryRun, cancelObservation.controlRef)

    const cancelRetry = await phase('cancel.retrySameBody', () =>
      rpcRoundTrip(
        retrySession,
        'cancel_run',
        { runId: cancelRunId, reason: `Braid live cancellation ${coordinates.proofId}` },
        ids.cancel,
        'same cancel retry acknowledgement',
      ),
    )
    const cancelRetryAck = assertAck(cancelRetry, 'same cancel retry')
    assert.equal(cancelRetryAck.runId, cancelRunId)
    if (cancelRetryAck.replayed !== true && cancelRetryAck.outcome !== 'already-applied') {
      throw new MissingIntegrationError(
        'same cancellation retry did not expose replay-safe acknowledgement proof',
        {
          required: ['replayed:true', 'outcome:already-applied'],
          response: cancelRetryAck,
        },
      )
    }

    const cancelConflict = await phase('cancel.retryChangedBody', () =>
      rpcRoundTrip(
        retrySession,
        'cancel_run',
        { runId: cancelRunId, reason: `changed-body-${coordinates.proofId}` },
        ids.cancel,
        'changed cancel conflict response',
      ),
    )
    assert.equal(cancelConflict.response.type, 'error', 'changed cancel body was accepted')
    assert.equal(cancelConflict.response.code, 'OPERATION_CONFLICT')
    retryProcessCleanup = await phase('cancel.restart.closeRetryProcess', () =>
      closeBraidWithProof(retrySession, 'cancellation retry process'),
    )
    retrySession = undefined

    const firstTelemetry = telemetryDisclosure(
      firstRun,
      firstState.state,
      workspaceVerification,
      assertSameAccount(firstState.state, firstRun, identityRecords[0]?.value),
      { allowInFlight: true },
    )
    const resumedTelemetry = telemetryDisclosure(
      freshRun,
      freshTerminal.response.state,
      workspaceVerification,
      assertSameAccount(freshTerminal.response.state, freshRun, identityRecords[0]?.value),
    )
    const followUpTelemetry = telemetryDisclosure(
      followUpTerminal.run,
      followUpTerminal.response.state,
      workspaceVerification,
      account,
    )
    const cancelledTelemetry = telemetryDisclosure(
      cancelled.run,
      cancelled.response.state,
      workspaceVerification,
      assertSameAccount(cancelled.response.state, cancelled.run, identityRecords[0]?.value),
    )
    telemetry = {
      ...followUpTelemetry,
      runs: {
        first: firstTelemetry,
        resumed: resumedTelemetry,
        followUp: followUpTelemetry,
        cancelled: cancelledTelemetry,
      },
    }

    const runRecords = {
      first: firstSnapshot,
      resumed: runSnapshot(freshRun, freshTerminal.response.state, freshObservation),
      followUp: runSnapshot(
        followUpTerminal.run,
        followUpTerminal.response.state,
        followUpObservation,
      ),
      cancelled: runSnapshot(cancelled.run, cancelled.response.state, cancelObservation),
    }
    const spend = spendDisclosure({
      resumed: freshRun,
      followUp: followUpTerminal.run,
      cancelled: cancelled.run,
    })
    result = {
      schemaVersion: 'braid.tangle-sandbox-braid-stress.v1',
      status: 'passed',
      proofId: coordinates.proofId,
      resourceIdentity: tagObservation,
      config: configEvidence(config),
      processes: {
        first: killed,
        cancelled: cancelledProcessCleanup,
        retry: retryProcessCleanup,
        localRunCountAfterReconnect: firstRunCountAfterReplay,
        binarySha256,
      },
      runs: runRecords,
      replay: {
        firstVisibleEventCount: firstVisible.count,
        freshVisibleEventCount: freshVisible.count,
        freshVisibleEventIdsUnique: true,
        resumeFromCursor,
        finalCursor,
        acknowledgedBeforeKillEventIds: firstVisible.keys,
        freshVisibleEventIds: freshVisible.keys,
        acknowledgedAndFreshIntersection: resumeIntersection,
        progress: resumeProgress,
        reconnectRequest: reconnect.request,
      },
      cancellation: {
        first: cancelAck,
        sameBody: cancelRetryAck,
        changedBody: cancelConflict.response,
        remote: remoteCancellation,
      },
      account,
      telemetry,
      spend,
      followUpEvidence: {
        visibleProviderEvents: followUpVisible.count,
        continuity: workspaceVerification.continuity,
      },
      workspaceVerification,
      timing: phases,
    }
  } catch (error) {
    failure = error
    diagnostics = {
      ...(firstSession ? { firstProcess: failureDiagnostics(firstSession, firstRunId) } : {}),
      ...(freshSession
        ? {
            freshProcess: failureDiagnostics(freshSession, cancelRunId ?? firstRunId),
          }
        : {}),
    }
    collectIntegrationNeed(error, unresolvedIntegrationNeeds)
  } finally {
    for (const [label, session] of [
      ['retry', retrySession],
      ['fresh', freshSession],
      ['first', firstSession],
    ]) {
      if (!session) continue
      try {
        failureProcessCleanup[label] = await closeBraidWithProof(
          session,
          `${label} failure-path Braid process`,
        )
      } catch (error) {
        if (error?.processCleanup) failureProcessCleanup[label] = error.processCleanup
        cleanupError ??= error
        collectIntegrationNeed(error, unresolvedIntegrationNeeds)
      }
    }
    if (firstRunId === undefined && firstSendAttempted && binary && config) {
      let recoverySession
      try {
        const recovered = await initializedSession(binary, config)
        recoverySession = recovered.session
        firstRunId = runIdForOperation(recovered.state.state, ids.first)
        const processCleanup = await closeBraidWithProof(
          recoverySession,
          'cleanup identity recovery Braid process',
        )
        recoverySession = undefined
        cleanupRecovery = {
          attempted: true,
          operationId: ids.first,
          runId: firstRunId ?? null,
          processCleanup,
        }
      } catch (error) {
        if (error?.processCleanup) {
          cleanupRecovery = {
            attempted: true,
            operationId: ids.first,
            runId: firstRunId ?? null,
            processCleanup: error.processCleanup,
          }
        }
        cleanupError ??= error
        collectIntegrationNeed(error, unresolvedIntegrationNeeds)
      } finally {
        if (recoverySession) {
          try {
            const processCleanup = await closeBraidWithProof(
              recoverySession,
              'failed cleanup identity recovery Braid process',
            )
            cleanupRecovery = {
              attempted: true,
              operationId: ids.first,
              runId: firstRunId ?? null,
              processCleanup,
            }
          } catch (error) {
            if (error?.processCleanup) {
              cleanupRecovery = {
                attempted: true,
                operationId: ids.first,
                runId: firstRunId ?? null,
                processCleanup: error.processCleanup,
              }
            }
            cleanupError ??= error
            collectIntegrationNeed(error, unresolvedIntegrationNeeds)
          }
        }
      }
    }
    if (client) {
      try {
        const cleanup = await cleanupOwnedRetainedResources(client, {
          controlRef: firstObservation?.controlRef,
          firstRunId,
          operationId: ids.first,
        })
        cleanupConfirmed = cleanup.confirmed
        cleanupMode = cleanup.mode
        cleanupIdentity = cleanup
        if (cleanup.matchedCount > 1) {
          const error = new MissingIntegrationError(
            'One Braid turn created more than one retained Sandbox resource',
            { matchedCount: cleanup.matchedCount, removedIds: cleanup.removedIds },
          )
          cleanupError ??= error
          collectIntegrationNeed(error, unresolvedIntegrationNeeds)
        }
        if (!cleanupConfirmed) {
          const error = new MissingIntegrationError(
            'Exact retained Braid Sandbox cleanup did not confirm deletion',
            { environmentId: knownEnvironmentId },
          )
          cleanupError ??= error
          collectIntegrationNeed(error, unresolvedIntegrationNeeds)
        }
      } catch (error) {
        cleanupError ??= error
        collectIntegrationNeed(error, unresolvedIntegrationNeeds)
      }
      finalUsage = await usage(client, 'after')
      usageRecords.push(finalUsage)
      identityRecords.push(await accountIdentity(client, 'after'))
    } else {
      const error = new MissingIntegrationError(
        'Exact-tag cleanup could not run because no Sandbox cleanup client was configured',
        { required: 'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY or TANGLE_API_KEY' },
      )
      cleanupError ??= error
      collectIntegrationNeed(error, unresolvedIntegrationNeeds)
      finalUsage = { phase: 'after', value: undefined, error: errorDetails(error) }
      usageRecords.push(finalUsage)
    }
    if (config) await config.cleanup().catch((error) => (cleanupError ??= error))
  }

  const beforeUsage = usageRecords.find((entry) => entry.phase === 'before')
  const afterUsage = usageRecords.find((entry) => entry.phase === 'after')
  const usageDelta = resourceDelta(afterUsage?.value, beforeUsage?.value)
  const usageObservationComplete =
    beforeUsage?.error === undefined &&
    beforeUsage?.value !== undefined &&
    beforeUsage.value !== null &&
    afterUsage?.error === undefined &&
    afterUsage?.value !== undefined &&
    afterUsage.value !== null &&
    usageDelta.activeSandboxes !== null
  try {
    accountIdentityConsistency = assertStableAccountIdentity(identityRecords)
  } catch (error) {
    accountIdentityError = error
    collectIntegrationNeed(error, unresolvedIntegrationNeeds)
  }
  if (tagObservation?.observed !== true) {
    const error = new MissingIntegrationError(
      'The live run did not prove the exact retained Braid Sandbox resource identity',
      { proofId: coordinates.proofId, observation: tagObservation },
    )
    cleanupError ??= error
    collectIntegrationNeed(error, unresolvedIntegrationNeeds)
  }
  if (requireZeroActiveResourceDelta && usageDelta.activeSandboxes !== 0) {
    unresolvedIntegrationNeeds.push(
      usageDelta.activeSandboxes === null
        ? 'Sandbox usage must expose activeSandboxes before and after cleanup'
        : `active Sandbox resource delta was ${usageDelta.activeSandboxes}, expected 0`,
    )
  }
  if (beforeUsage?.error) unresolvedIntegrationNeeds.push('Sandbox usage-before observation failed')
  if (afterUsage?.error) unresolvedIntegrationNeeds.push('Sandbox usage-after observation failed')
  if (!usageObservationComplete) {
    unresolvedIntegrationNeeds.push(
      'Sandbox usage must expose activeSandboxes before execution and after cleanup',
    )
  }

  const finished = {
    ...(result ?? {
      schemaVersion: 'braid.tangle-sandbox-braid-stress.v1',
      proofId: coordinates.proofId,
      config: config ? configEvidence(config) : undefined,
      timing: phases,
    }),
    status:
      failure === undefined &&
      cleanupError === undefined &&
      accountIdentityError === undefined &&
      usageObservationComplete &&
      (!requireZeroActiveResourceDelta || usageDelta.activeSandboxes === 0)
        ? 'passed'
        : 'failed',
    proofId: coordinates.proofId,
    cleanup: {
      exactResource: cleanupConfirmed,
      mode: cleanupMode,
      identity: cleanupIdentity,
      activeResourceDelta: usageDelta.activeSandboxes,
      activeResourceDeltaRequired: requireZeroActiveResourceDelta,
      accountUsageScope: 'account-wide',
      accountUsageAttribution: requireZeroActiveResourceDelta
        ? 'exclusive-proof-window'
        : 'unattributed-shared-usage',
      usageObservationComplete,
      usageDelta,
    },
    usage: usageRecords.map((entry) => ({
      phase: entry.phase,
      status:
        entry.error !== undefined
          ? 'unavailable'
          : entry.value === undefined
            ? 'missing'
            : entry.value === null
              ? 'unavailable'
              : 'observed',
      ...(entry.value === undefined ? {} : { value: entry.value }),
      ...(entry.error ? { error: entry.error } : {}),
    })),
    accountIdentities: identityRecords.map((entry) => ({
      phase: entry.phase,
      status: entry.error ? 'unavailable' : entry.value === undefined ? 'missing' : 'observed',
      ...(entry.value === undefined ? {} : { value: publicAccountIdentityEvidence(entry.value) }),
      ...(entry.error ? { error: entry.error } : {}),
    })),
    accountIdentityConsistency: accountIdentityConsistency ?? null,
    timing: { ...(result?.timing ?? {}), totalMs: performance.now() - startedAt },
    workspaceVerification: workspaceVerification ?? null,
    progress: {
      firstRunId,
      cancelRunId,
      providerEnvironmentId: knownEnvironmentId,
      firstControlRef: firstObservation?.controlRef,
      resumeFromCursor,
      freshControlRef: freshObservation?.controlRef,
      finalCursor,
    },
    ...(failure ? { failure: errorDetails(failure) } : {}),
    ...(diagnostics && Object.keys(diagnostics).length > 0 ? { diagnostics } : {}),
    ...(cleanupError ? { cleanupFailure: errorDetails(cleanupError) } : {}),
    ...(accountIdentityError ? { accountIdentityFailure: errorDetails(accountIdentityError) } : {}),
    ...(cleanupRecovery === undefined ? {} : { cleanupRecovery }),
    ...(Object.keys(failureProcessCleanup).length === 0 ? {} : { failureProcessCleanup }),
    ...(unresolvedIntegrationNeeds.length > 0
      ? { unresolvedIntegrationNeeds: [...new Set(unresolvedIntegrationNeeds)] }
      : {}),
  }
  return finished
}

async function writeOutput(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true })
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function main() {
  const proof = await runBraidSandboxStress()
  const outputPath = argument('output')
  if (outputPath) await writeOutput(outputPath, proof)
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`)
  if (proof.status !== 'passed') process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    process.stdout.write(
      `${JSON.stringify({ status: 'failed', failure: errorDetails(error) }, null, 2)}\n`,
    )
    process.exitCode = 1
  })
}
