import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProofWindow, createProtectedWork, protectedSpan } from '../proof-tools.mjs'
import { connectionConfiguration } from './configuration.mjs'
import {
  classifyExternalFailure,
  PROOF_OPERATIONS,
  proofInvocation,
  proofReceipt,
  safeJson,
  scalarMeasurement,
} from './contracts.mjs'
import {
  admittedCancellationSupport,
  closeSession,
  configEvidence,
  prepareProductionWorkspace,
  resolveBinary,
  runHeadlessCancellation,
  runHeadlessTurn,
  verifyUnavailableCancellation,
} from './headless.mjs'
import { assertMultirunProof } from './multirun-contract.mjs'
import {
  interactiveFailureMessages,
  runInteractiveProof,
} from './tangle-sandbox-braid-interactive.mjs'
import { runProof as runMultirunProof } from './tangle-sandbox-braid-multirun.mjs'
import { runBraidSandboxSoak } from './tangle-sandbox-braid-soak.mjs'
import { runConfidentialProof, runWorkspaceForkProof } from './tangle-workspace-proof.mjs'

const TANGLE_ROWS = Object.freeze(['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'])
const MINIMUM_SANDBOX_STRESS_RUNS = 3
const MINIMUM_SANDBOX_STRESS_CONCURRENCY = 2
const SANDBOX_SOAK_DIAGNOSTIC_PREFIX = 'BRAID_SANDBOX_SOAK_DIAGNOSTIC_JSON='
const SOAK_PHASES = new Set([
  'workspace',
  'firstProcess.initialize',
  'firstProcess.send',
  'firstProcess.observeControl',
  'firstProcess.waitVisible',
  'firstProcess.sigkill',
  'freshProcess.initialize',
  'freshProcess.reconnect',
  'freshProcess.observeControl',
  'freshProcess.waitTerminal',
  'followUp.send',
  'followUp.observeControl',
  'followUp.waitTerminal',
  'followUp.prepareContinuityChallenge',
  'followUp.verifyWorkspace',
  'cancel.send',
  'cancel.observeControl',
  'cancel.retrySameBody',
  'cancel.retryChangedBody',
  'cancel.waitCompletion',
  'cancel.verifyRemote',
  'cancel.verifySessionExecutions',
  'cancel.restart.closeFirstProcess',
  'cancel.restart.closeRetryProcess',
  'cancel.restart.initialize',
  'cancel.first',
])
const SOAK_FAILURE_CODES = new Set([
  'MISSING_INTEGRATION',
  'RPC_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

function soakFailureFingerprint(failure) {
  let fingerprint = failure?.fingerprint
  let httpStatus = null
  let code = null
  for (
    let depth = 0;
    depth < 5 && fingerprint !== null && typeof fingerprint === 'object';
    depth++
  ) {
    if (
      httpStatus === null &&
      Number.isSafeInteger(fingerprint.status) &&
      fingerprint.status >= 100 &&
      fingerprint.status <= 599
    ) {
      httpStatus = fingerprint.status
    }
    if (code === null && SOAK_FAILURE_CODES.has(fingerprint.code)) code = fingerprint.code
    fingerprint = fingerprint.cause
  }
  return { httpStatus, code }
}

function soakFailureCategory(failure, fingerprint) {
  if (fingerprint.httpStatus !== null) {
    return fingerprint.httpStatus >= 500 ? 'external-http-5xx' : 'external-http-non-5xx'
  }
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(fingerprint.code)) {
    return 'network'
  }
  if (fingerprint.code === 'RPC_TIMEOUT') return 'rpc-timeout'
  if (failure?.name === 'MissingIntegrationError') return 'integration-contract'
  if (failure?.name === 'AssertionError') return 'assertion'
  return 'unclassified'
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function sandboxSoakDiagnostic(cohort) {
  return {
    schema: 'braid.live07.sandbox-soak-diagnostic.v1',
    requestedRuns: nonnegativeInteger(cohort?.requestedRuns),
    attemptedRuns: nonnegativeInteger(cohort?.attemptedRuns),
    stoppedAfterCanary: cohort?.stoppedAfterCanary === true,
    attempts: (cohort?.attempts ?? []).slice(0, 20).map((attempt) => {
      const proof = attempt?.proof
      const failure = proof?.failure
      const fingerprint = soakFailureFingerprint(failure)
      const completedPhases = Object.keys(proof?.timing ?? {}).filter((name) =>
        SOAK_PHASES.has(name),
      )
      const cleanup = proof?.cleanup
      const cleanupFailure = proof?.cleanupFailure
      const cleanupFingerprint = soakFailureFingerprint(cleanupFailure)
      const progress = proof?.progress
      return {
        index: nonnegativeInteger(attempt?.index),
        status: ['passed', 'failed'].includes(proof?.status) ? proof.status : null,
        failureCategory:
          failure === undefined || failure === null
            ? null
            : soakFailureCategory(failure, fingerprint),
        failureHttpStatus: fingerprint.httpStatus,
        failureCode: fingerprint.code,
        lastCompletedPhase: completedPhases.at(-1) ?? null,
        firstRunAdmitted:
          progress === undefined || progress === null
            ? null
            : typeof progress.firstRunId === 'string',
        controlObserved:
          progress === undefined || progress === null
            ? null
            : progress.firstControlRef !== undefined,
        cleanup:
          cleanup === undefined || cleanup === null
            ? null
            : {
                exactResource:
                  typeof cleanup.exactResource === 'boolean' ? cleanup.exactResource : null,
                matchedCount: nonnegativeInteger(cleanup?.identity?.matchedCount),
                remainingCount: Array.isArray(cleanup?.identity?.remainingIds)
                  ? cleanup.identity.remainingIds.length
                  : null,
                activeResourceDelta: finiteNumber(cleanup?.activeResourceDelta),
                usageObservationComplete:
                  typeof cleanup.usageObservationComplete === 'boolean'
                    ? cleanup.usageObservationComplete
                    : null,
                failureCategory:
                  cleanupFailure === undefined || cleanupFailure === null
                    ? null
                    : soakFailureCategory(cleanupFailure, cleanupFingerprint),
                failureHttpStatus: cleanupFingerprint.httpStatus,
              },
      }
    }),
  }
}

function requiredMeasurement(row, result) {
  if (result?.status === 'unavailable') return undefined
  if (result?.status !== 'passed') {
    throw new Error(
      `${row} live proof returned invalid status ${String(result?.status ?? 'missing')}`,
    )
  }
  if (result.measurement?.name !== row) {
    throw new Error(`${row} live proof passed without its required measurement`)
  }
  return result.measurement
}

function tokenMarker(name) {
  return `LIVE_BRAID_${name}_OK`
}

async function runInference({ repository, environment, binary, invocationId }) {
  const startedAt = new Date().toISOString()
  const values = connectionConfiguration(environment, {
    prefix: 'BRAID_TANGLE',
    kind: 'tangle-inference',
    endpointNames: ['BRAID_TANGLE_INFERENCE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_INFERENCE_MODEL'],
    runnerNames: ['BRAID_TANGLE_INFERENCE_RUNNER'],
    providerNames: ['BRAID_TANGLE_INFERENCE_PROVIDER'],
    fallbackModelProvider: 'tangle-router',
    fallbackRunner: 'cli-base',
  })
  const config = await prepareProductionWorkspace({
    repository,
    environment,
    ...values,
  })
  let normal
  let cancelled
  let cancellation
  try {
    normal = await runHeadlessTurn({
      binary,
      config,
      marker: tokenMarker('TANGLE_INFERENCE'),
      prompt: `Reply with exactly ${tokenMarker('TANGLE_INFERENCE')}.`,
    })
    if (admittedCancellationSupport(normal.run, normal.response.admission)) {
      cancelled = await runHeadlessCancellation({
        binary,
        config,
        marker: 'TANGLE_INFERENCE_CANCEL',
        prompt:
          'Produce a numbered list from 1 to 10000, one short word per line, until Braid cancels this run.',
      })
      cancellation = { status: 'confirmed', runId: cancelled.run.id }
    } else {
      cancellation = await verifyUnavailableCancellation({
        session: normal.session,
        run: normal.run,
        admission: normal.response.admission,
        marker: 'TANGLE_INFERENCE_CANCEL',
      })
    }
    const runIds = [normal.run.id, cancelled?.run.id].filter((runId) => typeof runId === 'string')
    return {
      status: 'passed',
      measurement: scalarMeasurement('LIVE-06'),
      evidence: proofReceipt({
        invocationId,
        operation: PROOF_OPERATIONS.tangleInference,
        startedAt,
        completedAt: new Date().toISOString(),
        config: configEvidence(config),
        runIds,
        materializationDigest: normal.run.materializationDigest,
        facts: {
          normalRunId: normal.run.id,
          cancelledRunId: cancelled?.run.id ?? null,
          cancellationStatus: cancellation.status,
          cancellationResponseCode: cancellation.code ?? null,
        },
        checks: [
          'normal-turn',
          cancellation.status === 'confirmed'
            ? 'cancelled-turn'
            : 'cancellation-reported-unavailable',
          'materialization-receipt',
        ],
      }),
    }
  } finally {
    if (normal?.session) await closeSession(normal.session).catch(() => undefined)
    if (cancelled?.session) await closeSession(cancelled.session).catch(() => undefined)
    await config.cleanup()
  }
}

export async function runSandbox({
  repository,
  environment,
  binary,
  invocationId,
  stressRunner = runBraidSandboxSoak,
  multirunRunner = runMultirunProof,
  diagnosticWriter = (line) => process.stderr.write(line),
  work,
}) {
  const startedAt = new Date().toISOString()
  let multirunPromise
  let proofWindow
  const overlap = work?.overlap === true
  let cohort
  let cohortError
  try {
    cohort = await protectedSpan('cohort', () =>
      stressRunner({
        repository,
        environment,
        binary,
        ...(overlap
          ? {
              afterCanary: async () => {
                proofWindow = new ProofWindow(['stress-1', 'stress-2', 'multirun'])
                multirunPromise = protectedSpan('multirun', () =>
                  multirunRunner({
                    targetRepository: repository,
                    environment,
                    proofWindow,
                    proofScope: 'multirun',
                  }),
                ).then(
                  (value) => ({ status: 'fulfilled', value }),
                  (reason) => {
                    proofWindow.cleaned('multirun', false)
                    return { status: 'rejected', reason }
                  },
                )
                return proofWindow
              },
            }
          : {}),
      }),
    )
  } catch (error) {
    cohortError = error
    proofWindow?.fail()
  }
  // Join the sibling before interpreting cohort failure; its cleanup remains mandatory.
  const overlappedMultirun = await multirunPromise
  if (cohortError !== undefined) throw cohortError
  if (cohort.status !== 'passed') {
    diagnosticWriter(
      `${SANDBOX_SOAK_DIAGNOSTIC_PREFIX}${safeJson(sandboxSoakDiagnostic(cohort), environment)}\n`,
    )
    const unresolved = cohort.failures?.join('; ')
    throw new Error(
      `LIVE-07 Braid Tangle Sandbox stress failed: ${unresolved ?? 'no failure details'}`,
    )
  }
  if (
    !Number.isSafeInteger(cohort.requestedRuns) ||
    cohort.requestedRuns < MINIMUM_SANDBOX_STRESS_RUNS ||
    cohort.attemptedRuns !== cohort.requestedRuns ||
    !Number.isSafeInteger(cohort.concurrency) ||
    cohort.concurrency < MINIMUM_SANDBOX_STRESS_CONCURRENCY ||
    !Array.isArray(cohort.attempts) ||
    cohort.attempts.length !== cohort.requestedRuns ||
    cohort.cleanup?.exactProofs !== cohort.requestedRuns ||
    cohort.cleanup?.exactResourcesRemaining !== 0 ||
    cohort.cleanup?.activeResourceDelta !== 0
  ) {
    throw new Error(
      'LIVE-07 requires at least three complete cloud proofs, two-way concurrency, and exact zero-resource cleanup',
    )
  }
  const proof = cohort.attempts?.find((attempt) => attempt.index === 0)?.proof
  if (proof?.status !== 'passed') {
    throw new Error('LIVE-07 Braid Tangle Sandbox stress has no passing canary proof')
  }
  if (overlappedMultirun?.status === 'rejected') throw overlappedMultirun.reason
  const multirun =
    overlappedMultirun?.value ??
    (await protectedSpan('multirun', () =>
      multirunRunner({
        targetRepository: repository,
        environment,
      }),
    ))
  assertMultirunProof(multirun)
  const firstRun = proof.runs?.first
  const runIds = [
    ...new Set([
      firstRun?.id,
      proof.runs?.resumed?.id,
      proof.runs?.followUp?.id,
      proof.runs?.cancelled?.id,
    ]),
  ].filter((runId) => typeof runId === 'string' && runId.length > 0)
  const localEnvironmentId = firstRun?.environmentId ?? null
  const activeResourceDelta = cohort.cleanup?.activeResourceDelta
  const cloudControl = proof.progress?.firstControlRef ?? null
  const facts = {
    environmentId: localEnvironmentId,
    resumedRunId: proof.runs?.resumed?.id ?? null,
    followUpRunId: proof.runs?.followUp?.id ?? null,
    cancelledRunId: proof.runs?.cancelled?.id ?? null,
    resumeFromCursor: proof.replay?.resumeFromCursor ?? null,
    finalCursor: proof.replay?.finalCursor ?? null,
    cloudControl,
    exactResource: cohort.cleanup?.exactResourcesRemaining === 0,
    activeResourceDelta: typeof activeResourceDelta === 'number' ? activeResourceDelta : null,
  }
  // Keep the measured spend in release evidence without treating its field name as a credential.
  const { sessionSpend, ...stress } = cohort
  const observations = {
    stress: { ...stress, ...(sessionSpend === undefined ? {} : { spend: sessionSpend }) },
    multirun,
  }
  return {
    status: 'passed',
    measurement: scalarMeasurement('LIVE-07'),
    evidence: proofReceipt({
      invocationId,
      operation: PROOF_OPERATIONS.tangleSandbox,
      startedAt,
      completedAt: new Date().toISOString(),
      config: proof.config,
      runIds,
      environmentId: localEnvironmentId,
      materializationDigest: firstRun?.materializationDigest ?? null,
      facts,
      observations,
      environment,
      checks: [
        'marker',
        'environment-id',
        'workspace-read-write-exec-git',
        'sigkill-reconnect',
        'exclusive-replay',
        'follow-up-session',
        'cancel-retry-conflict',
        'exact-resource-cleanup',
      ],
    }),
    observations,
  }
}

export async function runMatrixAdapter({
  repository,
  environment,
  binary,
  invocationId = proofInvocation('live-tangle-matrix'),
  work,
}) {
  const configured =
    typeof environment.BRAID_TANGLE_LIVE_ADAPTER === 'string' &&
    environment.BRAID_TANGLE_LIVE_ADAPTER.trim().length > 0
  const flows = []
  const measurements = []
  const unavailable = []
  const setFlow = (row, result) => {
    const flow = {
      row,
      status: result.status,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.evidence === undefined ? {} : { evidence: result.evidence }),
      ...(result.observations === undefined ? {} : { observations: result.observations }),
    }
    const index = flows.findIndex((candidate) => candidate.row === row)
    if (index === -1) flows.push(flow)
    else flows[index] = flow
  }
  const addUnavailable = (row, reason) => {
    const detail = configured
      ? `External Tangle matrix adapters are not accepted as release proof; ${reason}`
      : reason
    unavailable.push({ row, reason: detail })
    setFlow(row, { status: 'unavailable', reason: detail })
  }
  const runBuiltIn = async (row, runner) => {
    try {
      const result = await (work === undefined
        ? runner({ repository, environment, binary, invocationId })
        : work.span(row, 'row', () => runner({ repository, environment, binary, invocationId })))
      if (result.status === 'failed') throw new Error(`${row} built-in proof failed`)
      if (result.status !== 'passed') {
        addUnavailable(row, result.reason ?? `${row} built-in proof is unavailable`)
        return
      }
      setFlow(row, result)
      if (result.measurement !== undefined) measurements.push(result.measurement)
    } catch (error) {
      const classified = classifyExternalFailure(error, `${row} built-in Tangle proof`, environment)
      addUnavailable(row, classified.message)
    }
  }
  await runBuiltIn('LIVE-09', runWorkspaceForkProof)
  await runBuiltIn('LIVE-10', runConfidentialProof)
  const status =
    flows.length === 2 && flows.every((flow) => flow.status === 'passed')
      ? 'passed'
      : flows.every((flow) => flow.status === 'unavailable')
        ? 'unavailable'
        : 'partial'
  return {
    status,
    flows,
    measurements,
    unavailable,
    ...(unavailable.length === 0
      ? {}
      : { reason: unavailable.map((entry) => entry.reason).join('; ') }),
  }
}

async function runTangleFlowsCore({
  repository,
  environment,
  inferenceRunner = runInference,
  sandboxRunner = runSandbox,
  interactiveRunner = runInteractiveProof,
  matrixRunner = runMatrixAdapter,
  work,
}) {
  const binary = await resolveBinary(repository, environment)
  const invocationId = proofInvocation('live-tangle')
  const flows = []
  const measurements = []
  const unavailable = []
  const setFlow = (row, flow) => {
    const index = flows.findIndex((candidate) => candidate.row === row)
    if (index === -1) flows.push(flow)
    else flows[index] = flow
  }
  const addUnavailable = (row, reason) => {
    if (!unavailable.some((candidate) => candidate.row === row)) unavailable.push({ row, reason })
    if (!flows.some((candidate) => candidate.row === row))
      flows.push({ row, status: 'unavailable', reason })
  }
  let inference
  try {
    inference = await (work === undefined
      ? inferenceRunner({ repository, environment, binary, invocationId })
      : work.span('LIVE-06', 'row', () =>
          inferenceRunner({ repository, environment, binary, invocationId }),
        ))
    const measurement = requiredMeasurement('LIVE-06', inference)
    if (measurement === undefined) {
      addUnavailable('LIVE-06', inference.reason ?? 'Tangle inference proof is unavailable')
    } else {
      setFlow('LIVE-06', { row: 'LIVE-06', status: inference.status, evidence: inference.evidence })
      measurements.push(measurement)
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle inference', environment)
    addUnavailable('LIVE-06', classified.message)
  }
  try {
    const sandbox = await (work === undefined
      ? sandboxRunner({ repository, environment, binary, invocationId })
      : work.span('LIVE-07', 'row', () =>
          sandboxRunner({ repository, environment, binary, invocationId, work }),
        ))
    const measurement = requiredMeasurement('LIVE-07', sandbox)
    if (measurement === undefined) {
      addUnavailable('LIVE-07', sandbox.reason ?? 'Tangle Sandbox proof is unavailable')
    } else {
      setFlow('LIVE-07', {
        row: 'LIVE-07',
        status: sandbox.status,
        evidence: sandbox.evidence,
        observations: sandbox.observations,
      })
      measurements.push(measurement)
      if (sandbox.unavailable) addUnavailable(sandbox.unavailable.row, sandbox.unavailable.reason)
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle sandbox', environment)
    addUnavailable('LIVE-07', classified.message)
  }
  try {
    const interactive = await (work === undefined
      ? interactiveRunner({ repository, environment, invocationId })
      : work.span('LIVE-08', 'row', () =>
          interactiveRunner({ repository, environment, invocationId }),
        ))
    const measurement = requiredMeasurement('LIVE-08', interactive)
    if (measurement === undefined) {
      addUnavailable('LIVE-08', interactive.reason ?? 'Tangle interactive proof is unavailable')
    } else {
      setFlow('LIVE-08', {
        row: 'LIVE-08',
        status: interactive.status,
        evidence: interactive.evidence,
      })
      measurements.push(measurement)
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle interactive session', environment)
    const messages = interactiveFailureMessages(error, environment)
    addUnavailable('LIVE-08', messages.join('; ') || classified.message)
  }
  try {
    const matrix = await matrixRunner({ repository, environment, binary, invocationId, work })
    for (const row of TANGLE_ROWS.slice(3)) {
      const result = matrix.flows?.find((candidate) => candidate.row === row)
      if (result?.status === 'passed') {
        setFlow(result.row, result)
        const measurement = matrix.measurements?.find((candidate) => candidate.name === row)
        if (measurement !== undefined) measurements.push(measurement)
      } else if (result?.status === 'failed') {
        throw new Error(result.reason ?? `${row} matrix proof failed`)
      } else {
        addUnavailable(row, result?.reason ?? matrix.reason ?? `${row} matrix proof unavailable`)
      }
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle matrix', environment)
    for (const row of TANGLE_ROWS.slice(3)) addUnavailable(row, classified.message)
  }
  const complete = TANGLE_ROWS.every((row) =>
    measurements.some((measurement) => measurement.name === row),
  )
  return {
    status: complete ? 'passed' : 'partial',
    flows,
    measurements,
    unavailable,
  }
}

export async function runTangleFlows(input) {
  const work = createProtectedWork(input.environment)
  try {
    return await runTangleFlowsCore({ ...input, work })
  } finally {
    if (work !== undefined) {
      const evidence = {
        ...work.snapshot(),
        workflowRunId: input.environment.GITHUB_RUN_ID ?? null,
        sourceCommit: input.environment.GITHUB_SHA ?? null,
        tarballSha256: input.environment.BRAID_LIVE_TARBALL_SHA256 ?? null,
      }
      const bytes = `${safeJson(evidence, input.environment)}\n`
      const destination = input.environment.BRAID_PROTECTED_WORK_EVIDENCE
      if (destination !== undefined) {
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
        await writeFile(destination, bytes, { mode: 0o600 })
      }
      process.stdout.write(`BRAID_PROTECTED_WORK_JSON=${bytes}`)
    }
  }
}
