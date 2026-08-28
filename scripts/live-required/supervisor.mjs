import { createHash } from 'node:crypto'

import {
  PROOF_OPERATIONS,
  proofInvocation,
  proofReceipt,
  protectedUnavailable,
  scalarMeasurement,
} from './contracts.mjs'

const SUPERVISOR_CHECKS = Object.freeze([
  'snapshot',
  'spend-status',
  'steering',
  'steering-acknowledged',
  'cancellation',
  'reconnect',
  'terminal-takeover',
])
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 100
const SPEND_FIELDS = Object.freeze(['iterations', 'tokensInput', 'tokensOutput', 'usd', 'ms'])
const TOTAL_FIELDS = Object.freeze([
  'tokensInput',
  'tokensOutput',
  'tokensTotal',
  'usd',
  'latencyMs',
])

function requiredText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function requiredProtectedText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw protectedUnavailable(
      'PROTECTED_SUPERVISOR_CONFIGURATION_REQUIRED',
      `Supervisor proof requires ${name}`,
    )
  return value.trim()
}

function configuredDuration(environment, names, fallback, label) {
  const configured = names
    .map((name) => environment[name])
    .find((value) => typeof value === 'string' && value.trim().length > 0)
  if (configured === undefined) return fallback
  const value = Number(configured)
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000)
    throw protectedUnavailable(
      'PROTECTED_SUPERVISOR_CONFIGURATION_INVALID',
      `${label} must be an integer between 1 and 300000 milliseconds`,
    )
  return value
}

function publicRuntimeApi(runtime) {
  if (runtime !== undefined) return runtime
  return Promise.all([
    import('@tangle-network/agent-runtime/kernel'),
    import('@tangle-network/agent-runtime/tui'),
  ]).then(([kernel, tui]) => ({ ...kernel, ...tui }))
}

async function loadPublicRuntimeApi(runtime) {
  try {
    const api = await publicRuntimeApi(runtime)
    if (api === null || typeof api !== 'object')
      throw new Error('public runtime API is not an object')
    return api
  } catch (error) {
    throw protectedUnavailable(
      'RUNTIME_SUPERVISOR_API_REQUIRED',
      'The installed agent-runtime package does not expose the public supervisor APIs',
      error,
    )
  }
}

function requireRuntimeFunctions(runtime) {
  const required = [
    'loadTopSnapshot',
    'supervisorRunDir',
    'writeWorkerSteer',
    'readWorkerSteerAcknowledgement',
    'cancelWorker',
    'readWorkerCancellation',
  ]
  for (const name of required) {
    if (typeof runtime[name] !== 'function')
      throw protectedUnavailable(
        'RUNTIME_SUPERVISOR_API_REQUIRED',
        `The installed agent-runtime package is missing public supervisor API '${name}'`,
      )
  }
}

function findTarget(snapshot, supervisorId, workerId) {
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    snapshot.completeness !== 'complete' ||
    !Array.isArray(snapshot.diagnostics) ||
    snapshot.diagnostics.length !== 0
  ) {
    throw new Error(
      `runtime supervisor snapshot is incomplete: ${JSON.stringify({
        completeness: snapshot?.completeness ?? null,
        diagnostics: Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : null,
      })}`,
    )
  }
  const supervisor = Array.isArray(snapshot.supervisors)
    ? snapshot.supervisors.find((candidate) => candidate?.id === supervisorId)
    : undefined
  const worker = supervisor?.workers?.find((candidate) => candidate?.id === workerId)
  if (supervisor === undefined || worker === undefined) {
    throw new Error(
      `runtime snapshot contains no exact supervisor '${supervisorId}' and worker '${workerId}'`,
    )
  }
  if (typeof supervisor.status !== 'string' || supervisor.status.length === 0)
    throw new Error(`runtime supervisor '${supervisorId}' has no status`)
  if (!['running', 'done', 'down', 'cancelled'].includes(worker.status))
    throw new Error(`runtime worker '${workerId}' has an unknown status`)
  return { snapshot, supervisor, worker }
}

function readTarget(runtime, rootDir, supervisorId, workerId) {
  return findTarget(runtime.loadTopSnapshot(rootDir), supervisorId, workerId)
}

function numericFields(value, fields) {
  return (
    value !== null &&
    typeof value === 'object' &&
    fields.every((field) => typeof value[field] === 'number' && Number.isFinite(value[field]))
  )
}

function numericView(value, fields) {
  if (!numericFields(value, fields)) return null
  return Object.fromEntries(fields.map((field) => [field, value[field]]))
}

function spendView(supervisor, worker) {
  const workerSpend = numericView(worker.spend, SPEND_FIELDS)
  const workerMetered = numericView(worker.metered, SPEND_FIELDS)
  const driverSpend = numericView(supervisor.driverSpend, SPEND_FIELDS)
  const totals = numericView(supervisor.totals, TOTAL_FIELDS)
  return { workerSpend, workerMetered, driverSpend, totals }
}

function knownSpend(view) {
  return view.workerSpend !== null && view.workerMetered !== null
}

function changedSpend(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after)
}

function snapshotObservation(target) {
  const spend = spendView(target.supervisor, target.worker)
  return {
    generatedAt: target.snapshot.generatedAt,
    completeness: target.snapshot.completeness,
    diagnostics: target.snapshot.diagnostics.length,
    supervisor: {
      id: target.supervisor.id,
      status: target.supervisor.status,
      workers: target.supervisor.workers.length,
      totals: spend.totals,
    },
    worker: {
      id: target.worker.id,
      status: target.worker.status,
      spend: spend.workerSpend,
      metered: spend.workerMetered,
    },
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForSnapshot({
  runtime,
  rootDir,
  supervisorId,
  workerId,
  predicate,
  label,
  timeoutMs,
  pollMs,
}) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (true) {
    latest = readTarget(runtime, rootDir, supervisorId, workerId)
    if (predicate(latest)) return latest
    if (Date.now() >= deadline)
      throw new Error(
        `${label} was not observed before ${timeoutMs}ms: ${JSON.stringify(snapshotObservation(latest))}`,
      )
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

async function waitForAcknowledgement({ read, eventDir, operationId, label, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (true) {
    latest = read(eventDir, operationId)
    if (latest !== undefined) return latest
    if (Date.now() >= deadline)
      throw new Error(
        `${label} was not acknowledged before ${timeoutMs}ms: ${JSON.stringify({ operationId, response: latest })}`,
      )
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
  }
}

function assertSteerResult(result, workerId, operationId, message) {
  if (
    result === null ||
    typeof result !== 'object' ||
    result.worker !== workerId ||
    result.request?.operationId !== operationId ||
    result.request?.message !== message ||
    !/^sha256:[0-9a-f]{64}$/u.test(result.request?.requestDigest ?? '')
  )
    throw new Error('runtime supervisor returned an invalid worker steer admission')
}

function assertSteerAcknowledgement(acknowledgement, request, workerId, operationId) {
  if (
    acknowledgement === null ||
    typeof acknowledgement !== 'object' ||
    acknowledgement.operationId !== operationId ||
    acknowledgement.worker !== workerId ||
    acknowledgement.requestDigest !== request.requestDigest ||
    acknowledgement.effect !== 'delivered'
  )
    throw new Error(
      `worker steer '${operationId}' did not report delivered effect: ${JSON.stringify({
        worker: acknowledgement.worker,
        effect: acknowledgement.effect,
        requestDigest: acknowledgement.requestDigest,
      })}`,
    )
}

function assertCancellationAcknowledgement(acknowledgement, workerId, operationId) {
  if (
    acknowledgement === null ||
    typeof acknowledgement !== 'object' ||
    acknowledgement.operationId !== operationId ||
    acknowledgement.worker !== workerId ||
    acknowledgement.effect !== 'cancelled' ||
    !Array.isArray(acknowledgement.terminated) ||
    !acknowledgement.terminated.includes(workerId)
  )
    throw new Error(
      `worker cancellation '${operationId}' did not report a proven effect: ${JSON.stringify({
        worker: acknowledgement.worker,
        effect: acknowledgement.effect,
        terminated: acknowledgement.terminated,
      })}`,
    )
}

function configuredOperation(environment, name, invocationId) {
  return requiredText(
    environment[`BRAID_SUPERVISOR_${name}_OPERATION_ID`] ??
      `braid-live-supervisor-${invocationId}-${name.toLowerCase()}`,
    `${name} operation id`,
  )
}

function proofConfig(environment) {
  return {
    endpoint: environment.BRAID_SUPERVISOR_ENDPOINT ?? null,
    connectionId: environment.BRAID_SUPERVISOR_CONNECTION_ID ?? null,
    connectionKind: environment.BRAID_SUPERVISOR_CONNECTION_KIND ?? null,
    credentialConfigured:
      environment.BRAID_SUPERVISOR_CREDENTIAL_CONFIGURED === undefined
        ? null
        : environment.BRAID_SUPERVISOR_CREDENTIAL_CONFIGURED === '1',
    model: environment.BRAID_SUPERVISOR_MODEL ?? null,
    runner: environment.BRAID_SUPERVISOR_RUNNER ?? null,
  }
}

/**
 * Prove one Runtime supervisor through its published read and control APIs.
 *
 * The optional `providers` value enables exact terminal takeover when the provider publishes an
 * interactive reconnect contract. A missing provider is recorded as unavailable capability, not
 * converted into a false attachment.
 */
export async function runSupervisorFlow({
  environment = process.env,
  invocationId = proofInvocation('live-supervisor'),
  runtime,
  providers,
} = {}) {
  const startedAt = new Date().toISOString()
  const rootDir = requiredProtectedText(environment.BRAID_SUPERVISOR_ROOT, 'BRAID_SUPERVISOR_ROOT')
  const supervisorId = requiredProtectedText(environment.BRAID_SUPERVISOR_ID, 'BRAID_SUPERVISOR_ID')
  const workerId = requiredProtectedText(
    environment.BRAID_SUPERVISOR_WORKER,
    'BRAID_SUPERVISOR_WORKER',
  )
  const timeoutMs = configuredDuration(
    environment,
    ['BRAID_SUPERVISOR_TIMEOUT_MS', 'BRAID_LIVE_REQUIRED_TIMEOUT_MS'],
    DEFAULT_TIMEOUT_MS,
    'Supervisor proof timeout',
  )
  const pollMs = configuredDuration(
    environment,
    ['BRAID_SUPERVISOR_POLL_MS'],
    DEFAULT_POLL_INTERVAL_MS,
    'Supervisor proof poll interval',
  )
  const steerOperationId = configuredOperation(environment, 'STEER', invocationId)
  const cancelOperationId = configuredOperation(environment, 'CANCEL', invocationId)
  const message = requiredText(
    environment.BRAID_SUPERVISOR_MESSAGE ?? `Braid live supervisor ${invocationId}`,
    'BRAID_SUPERVISOR_MESSAGE',
  )
  const runtimeApi = await loadPublicRuntimeApi(runtime)
  requireRuntimeFunctions(runtimeApi)

  const initial = readTarget(runtimeApi, rootDir, supervisorId, workerId)
  if (initial.supervisor.status !== 'running')
    throw new Error(
      `configured supervisor '${supervisorId}' is ${initial.supervisor.status}; cancellation proof requires a running supervisor`,
    )
  if (initial.worker.status !== 'running')
    throw new Error(
      `configured supervisor worker '${workerId}' is ${initial.worker.status}; cancellation proof requires a live worker`,
    )
  const initialSpend = spendView(initial.supervisor, initial.worker)
  if (!knownSpend(initialSpend))
    throw new Error(`runtime worker '${workerId}' did not report complete spend fields`)

  const spendUpdated = await waitForSnapshot({
    runtime: runtimeApi,
    rootDir,
    supervisorId,
    workerId,
    label: 'worker spend update',
    timeoutMs,
    pollMs,
    predicate: (candidate) => {
      const spend = spendView(candidate.supervisor, candidate.worker)
      return (
        candidate.worker.status === 'running' &&
        knownSpend(spend) &&
        changedSpend(initialSpend, spend)
      )
    },
  })
  const updatedSpend = spendView(spendUpdated.supervisor, spendUpdated.worker)

  const reconnected = readTarget(runtimeApi, rootDir, supervisorId, workerId)
  if (reconnected.worker.status !== 'running')
    throw new Error(
      `worker '${workerId}' stopped before reconnectable control proof: ${reconnected.worker.status}`,
    )
  const eventDir = requiredText(
    runtimeApi.supervisorRunDir(rootDir, supervisorId),
    'Runtime supervisor event directory',
  )

  let terminalTakeover
  if (typeof runtimeApi.attachWorker !== 'function') {
    terminalTakeover = { status: 'unavailable', reason: 'Runtime has no public attachWorker API' }
  } else if (providers === undefined) {
    terminalTakeover = {
      status: 'unavailable',
      reason: 'No environment provider source was supplied for exact terminal takeover',
    }
  } else {
    const attachment = await runtimeApi.attachWorker(eventDir, workerId, { providers })
    if (attachment?.status === 'available' && attachment.handle !== undefined) {
      terminalTakeover = { status: 'attached' }
    } else {
      terminalTakeover = {
        status: 'unavailable',
        reason: attachment?.reason ?? 'Runtime did not return an exact interactive handle',
      }
    }
  }

  const steer = runtimeApi.writeWorkerSteer(rootDir, supervisorId, workerId, {
    operationId: steerOperationId,
    message,
    source: 'braid-live-supervisor',
    interrupt: true,
  })
  assertSteerResult(steer, workerId, steerOperationId, message)
  const steerReplay = runtimeApi.writeWorkerSteer(rootDir, supervisorId, workerId, {
    operationId: steerOperationId,
    message,
    source: 'braid-live-supervisor',
    interrupt: true,
  })
  assertSteerResult(steerReplay, workerId, steerOperationId, message)
  if (
    steerReplay.replayed !== true ||
    steerReplay.request.requestDigest !== steer.request.requestDigest
  )
    throw new Error('worker steer retry did not replay the same admitted operation')
  const steerAcknowledgement = await waitForAcknowledgement({
    read: runtimeApi.readWorkerSteerAcknowledgement,
    eventDir,
    operationId: steerOperationId,
    label: 'worker steer acknowledgement',
    timeoutMs,
    pollMs,
  })
  assertSteerAcknowledgement(steerAcknowledgement, steer.request, workerId, steerOperationId)

  const beforeCancel = readTarget(runtimeApi, rootDir, supervisorId, workerId)
  if (beforeCancel.worker.status !== 'running')
    throw new Error(
      `worker '${workerId}' stopped before cancellation dispatch: ${beforeCancel.worker.status}`,
    )
  const cancel = runtimeApi.cancelWorker(eventDir, workerId, cancelOperationId, {
    reason: 'Braid live supervisor cancellation proof',
    source: 'braid-live-supervisor',
  })
  const cancelReplay = runtimeApi.cancelWorker(eventDir, workerId, cancelOperationId, {
    reason: 'Braid live supervisor cancellation proof',
    source: 'braid-live-supervisor',
  })
  if (
    cancel?.operationId !== cancelOperationId ||
    cancelReplay?.operationId !== cancelOperationId ||
    cancelReplay?.worker !== workerId
  )
    throw new Error('worker cancellation retry did not preserve its operation identity')
  const cancellationAcknowledgement = await waitForAcknowledgement({
    read: runtimeApi.readWorkerCancellation,
    eventDir,
    operationId: cancelOperationId,
    label: 'worker cancellation acknowledgement',
    timeoutMs,
    pollMs,
  })
  assertCancellationAcknowledgement(cancellationAcknowledgement, workerId, cancelOperationId)

  const final = await waitForSnapshot({
    runtime: runtimeApi,
    rootDir,
    supervisorId,
    workerId,
    label: 'cancelled worker snapshot',
    timeoutMs,
    pollMs,
    predicate: (candidate) => ['cancelled', 'down'].includes(candidate.worker.status),
  })
  const persistedCancellation = runtimeApi.readWorkerCancellation(eventDir, cancelOperationId)
  assertCancellationAcknowledgement(persistedCancellation, workerId, cancelOperationId)

  const proof = proofReceipt({
    invocationId,
    operation: PROOF_OPERATIONS.supervisor,
    startedAt,
    completedAt: new Date().toISOString(),
    config: proofConfig(environment),
    facts: {
      supervisorId,
      workerId,
      steeringRequestId: steer.request.operationId,
      steeringOperationId: steerOperationId,
      steeringEffect: steerAcknowledgement.effect,
      cancellationOperationId: cancelOperationId,
      cancellationEffect: cancellationAcknowledgement.effect,
      initialStatus: initial.worker.status,
      finalStatus: final.worker.status,
      spendObserved: true,
      statusObserved: true,
      reconnectable: true,
      terminalTakeover: terminalTakeover.status,
      cancellationAvailable: true,
    },
    checks: SUPERVISOR_CHECKS,
    observations: {
      snapshots: [
        snapshotObservation(initial),
        snapshotObservation(spendUpdated),
        snapshotObservation(reconnected),
        snapshotObservation(beforeCancel),
        snapshotObservation(final),
      ],
      spend: { initial: initialSpend, updated: updatedSpend },
      steering: {
        operationId: steerOperationId,
        requestDigest: steer.request.requestDigest,
        replayed: steerReplay.replayed === true,
        acknowledgement: {
          operationId: steerAcknowledgement.operationId,
          worker: steerAcknowledgement.worker,
          effect: steerAcknowledgement.effect,
          detail: steerAcknowledgement.detail,
        },
      },
      cancellation: {
        operationId: cancelOperationId,
        acknowledgement: {
          operationId: cancellationAcknowledgement.operationId,
          worker: cancellationAcknowledgement.worker,
          effect: cancellationAcknowledgement.effect,
          terminated: cancellationAcknowledgement.terminated,
          detail: cancellationAcknowledgement.detail,
        },
        replay: {
          effect: cancelReplay.effect,
          terminated: cancelReplay.terminated,
        },
      },
      terminalTakeover,
    },
    environment,
  })
  return {
    status: 'passed',
    measurements: [scalarMeasurement('LIVE-11')],
    supervisor: supervisorId,
    worker: workerId,
    steering: {
      operationId: steerOperationId,
      effect: steerAcknowledgement.effect,
      replayed: steerReplay.replayed === true,
    },
    cancellation: {
      operationId: cancelOperationId,
      effect: cancellationAcknowledgement.effect,
      replayed: cancelReplay.operationId === cancelOperationId,
    },
    reconnect: true,
    terminalTakeover,
    proof,
  }
}

export async function runSupervisorCheck({ environment }) {
  const direct = await runSupervisorFlow({ environment })
  return {
    status: direct.status,
    measurements: direct.measurements,
    evidence: direct.proof,
  }
}

function fixtureSpend(iteration) {
  return {
    iterations: iteration,
    tokensInput: iteration * 2,
    tokensOutput: iteration,
    usd: iteration / 1000,
    ms: iteration * 10,
  }
}

function fixtureDigest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/**
 * Build a deterministic public-runtime substitute for self-tests.
 *
 * It models the published API and acknowledgement boundaries, including replay-safe operations;
 * it never creates or reads Runtime supervisor files.
 */
export function createSupervisorProofFixture({
  rootDir = 'fixture-root',
  supervisorId = 'fixture-supervisor',
  workerId = 'fixture-worker',
  steerAcknowledgement = true,
  steerEffect = 'delivered',
  cancellationAcknowledgement = true,
  cancellationEffect = 'cancelled',
  terminalTakeover = 'unavailable',
  snapshotCompleteness = 'complete',
  snapshotDiagnostics = [],
} = {}) {
  let snapshotCount = 0
  let workerStatus = 'running'
  let supervisorStatus = 'running'
  let spendIteration = 1
  const steerRequests = new Map()
  const steerAcks = new Map()
  const cancellationAcks = new Map()
  const calls = []
  const eventDir = `fixture-event-dir:${supervisorId}`

  function snapshot() {
    snapshotCount += 1
    if (workerStatus === 'running' && snapshotCount > 1) spendIteration += 1
    const spend = fixtureSpend(spendIteration)
    const worker = {
      id: workerId,
      label: 'fixture worker',
      status: workerStatus,
      latencyMs: spend.ms,
      spend,
      metered: { ...spend },
      liveTail: ['fixture worker is active'],
    }
    const totals = {
      workers: 1,
      running: workerStatus === 'running' ? 1 : 0,
      done: 0,
      down: 0,
      cancelled: workerStatus === 'cancelled' ? 1 : 0,
      inFlight: workerStatus === 'running' ? 1 : 0,
      settled: workerStatus === 'running' ? 0 : 1,
      tokensInput: spend.tokensInput,
      tokensOutput: spend.tokensOutput,
      tokensTotal: spend.tokensInput + spend.tokensOutput,
      usd: spend.usd,
      latencyMs: spend.ms,
      workerLatency: { n: 1, min: spend.ms, median: spend.ms, p90: spend.ms, max: spend.ms },
    }
    return {
      root: rootDir,
      generatedAt: snapshotCount,
      supervisors: [
        {
          id: supervisorId,
          status: supervisorStatus,
          task: 'deterministic supervisor proof',
          workspaceDir: rootDir,
          budget: 1,
          stateDir: eventDir,
          workers: [worker],
          progressTail: ['fixture progress'],
          journalTail: [],
          driverSpend: { ...spend },
          totals,
        },
      ],
      completeness: snapshotCompleteness,
      diagnostics: snapshotDiagnostics,
      discovered: 1,
      loaded: 1,
    }
  }

  const api = {
    loadTopSnapshot(root) {
      calls.push({ name: 'loadTopSnapshot', root })
      return snapshot()
    },
    supervisorRunDir(root, id) {
      calls.push({ name: 'supervisorRunDir', root, id })
      if (root !== rootDir || id !== supervisorId) throw new Error('fixture event lookup mismatch')
      return eventDir
    },
    writeWorkerSteer(root, id, worker, options) {
      calls.push({ name: 'writeWorkerSteer', root, id, worker, options: { ...options } })
      if (root !== rootDir || id !== supervisorId || worker !== workerId)
        throw new Error('fixture steer target mismatch')
      const operation = {
        operationId: options.operationId,
        worker,
        message: options.message,
        source: options.source ?? 'human',
        interrupt: options.interrupt === true,
      }
      const requestDigest = fixtureDigest(operation)
      const prior = steerRequests.get(options.operationId)
      if (prior !== undefined && prior.request.requestDigest !== requestDigest)
        throw new Error('fixture steer operation body changed on retry')
      const request = prior?.request ?? {
        schemaVersion: 1,
        operationId: options.operationId,
        requestDigest,
        at: '2026-08-28T00:00:00.000Z',
        source: operation.source,
        worker,
        message: options.message,
        interrupt: operation.interrupt,
      }
      steerRequests.set(options.operationId, { request })
      if (steerAcknowledgement && !steerAcks.has(options.operationId))
        steerAcks.set(options.operationId, {
          schemaVersion: 1,
          operationId: options.operationId,
          requestDigest,
          worker,
          effect: steerEffect,
          requestedAt: request.at,
          observedAt: '2026-08-28T00:00:00.001Z',
          detail: `fixture steer ${steerEffect}`,
        })
      return {
        worker,
        file: `fixture-steer-request:${options.operationId}`,
        request,
        replayed: prior !== undefined,
        ...(steerAcks.has(options.operationId)
          ? { acknowledgement: steerAcks.get(options.operationId) }
          : {}),
      }
    },
    readWorkerSteerAcknowledgement(event, operationId) {
      calls.push({ name: 'readWorkerSteerAcknowledgement', event, operationId })
      return steerAcks.get(operationId)
    },
    cancelWorker(event, worker, operationId, options) {
      calls.push({ name: 'cancelWorker', event, worker, operationId, options: { ...options } })
      if (event !== eventDir || worker !== workerId)
        throw new Error('fixture cancel target mismatch')
      if (cancellationAcks.has(operationId)) return cancellationAcks.get(operationId)
      if (cancellationAcknowledgement) {
        workerStatus = cancellationEffect === 'cancelled' ? 'cancelled' : 'done'
        supervisorStatus = 'completed'
        const acknowledgement = {
          operationId,
          worker,
          effect: cancellationEffect,
          requestedAt: '2026-08-28T00:00:00.002Z',
          observedAt: '2026-08-28T00:00:00.003Z',
          reason: options?.reason,
          detail: `fixture cancellation ${cancellationEffect}`,
          terminated: cancellationEffect === 'cancelled' ? [workerId] : [],
        }
        cancellationAcks.set(operationId, acknowledgement)
        return acknowledgement
      }
      return {
        operationId,
        worker,
        effect: 'unknown',
        requestedAt: '2026-08-28T00:00:00.002Z',
        observedAt: '2026-08-28T00:00:00.002Z',
        terminated: [],
      }
    },
    readWorkerCancellation(event, operationId) {
      calls.push({ name: 'readWorkerCancellation', event, operationId })
      return cancellationAcks.get(operationId)
    },
    async attachWorker(event, worker, options) {
      calls.push({ name: 'attachWorker', event, worker, providers: options?.providers })
      if (event !== eventDir || worker !== workerId)
        throw new Error('fixture attach target mismatch')
      if (terminalTakeover === 'attached') return { status: 'available', handle: { fixture: true } }
      return { status: 'unavailable', reason: 'fixture has no interactive process' }
    },
  }

  return {
    api,
    calls,
    rootDir,
    supervisorId,
    workerId,
  }
}
