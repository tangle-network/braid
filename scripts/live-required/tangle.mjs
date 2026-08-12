import { connectionConfiguration } from './configuration.mjs'
import {
  classifyExternalFailure,
  PROOF_OPERATIONS,
  proofInvocation,
  proofReceipt,
  scalarMeasurement,
} from './contracts.mjs'
import {
  closeSession,
  configEvidence,
  prepareProductionWorkspace,
  resolveBinary,
  runHeadlessCancellation,
  runHeadlessTurn,
} from './headless.mjs'
import { runBraidSandboxSoak } from './tangle-sandbox-braid-soak.mjs'

const TANGLE_ROWS = Object.freeze(['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'])
const MINIMUM_SANDBOX_STRESS_RUNS = 3
const MINIMUM_SANDBOX_STRESS_CONCURRENCY = 2

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
    fallbackRunner: 'cli-base',
  })
  const config = await prepareProductionWorkspace({
    repository,
    environment,
    ...values,
  })
  let normal
  let cancelled
  try {
    normal = await runHeadlessTurn({
      binary,
      config,
      marker: tokenMarker('TANGLE_INFERENCE'),
      prompt: `Reply with exactly ${tokenMarker('TANGLE_INFERENCE')}.`,
    })
    cancelled = await runHeadlessCancellation({
      binary,
      config,
      marker: 'TANGLE_INFERENCE_CANCEL',
      prompt:
        'Produce a numbered list from 1 to 10000, one short word per line, until Braid cancels this run.',
    })
    return {
      status: 'passed',
      measurement: scalarMeasurement('LIVE-06'),
      evidence: proofReceipt({
        invocationId,
        operation: PROOF_OPERATIONS.tangleInference,
        startedAt,
        completedAt: new Date().toISOString(),
        config: configEvidence(config),
        runIds: [normal.run.id, cancelled.run.id],
        materializationDigest: normal.run.materializationDigest,
        facts: {
          normalRunId: normal.run.id,
          cancelledRunId: cancelled.run.id,
        },
        checks: ['normal-turn', 'cancelled-turn', 'materialization-receipt'],
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
}) {
  const startedAt = new Date().toISOString()
  const cohort = await stressRunner({ repository, environment, binary })
  if (cohort.status !== 'passed') {
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
      observations: cohort,
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
    observations: cohort,
  }
}

export async function runMatrixAdapter({ environment }) {
  const configured =
    typeof environment.BRAID_TANGLE_LIVE_ADAPTER === 'string' &&
    environment.BRAID_TANGLE_LIVE_ADAPTER.trim().length > 0
  return {
    status: 'unavailable',
    reason: configured
      ? 'External Tangle matrix adapters are not accepted as release proof; built-in parent checks for LIVE-07 through LIVE-10 are unavailable'
      : 'Built-in parent checks for LIVE-08 through LIVE-10 are unavailable',
  }
}

export async function runTangleFlows({
  repository,
  environment,
  inferenceRunner = runInference,
  sandboxRunner = runSandbox,
  matrixRunner = runMatrixAdapter,
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
    inference = await inferenceRunner({ repository, environment, binary, invocationId })
    setFlow('LIVE-06', { row: 'LIVE-06', status: inference.status, evidence: inference.evidence })
    measurements.push(inference.measurement)
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle inference', environment)
    addUnavailable('LIVE-06', classified.message)
  }
  try {
    const sandbox = await sandboxRunner({ repository, environment, binary, invocationId })
    setFlow('LIVE-07', {
      row: 'LIVE-07',
      status: sandbox.status,
      evidence: sandbox.evidence,
      observations: sandbox.observations,
    })
    measurements.push(sandbox.measurement)
    if (sandbox.unavailable) addUnavailable(sandbox.unavailable.row, sandbox.unavailable.reason)
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle sandbox', environment)
    addUnavailable('LIVE-07', classified.message)
  }
  try {
    const matrix = await matrixRunner({ repository, environment, binary })
    for (const row of TANGLE_ROWS.slice(2)) {
      const reason = `${row} remains protected-unavailable: ${matrix.reason}`
      addUnavailable(row, reason)
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle matrix', environment)
    for (const row of TANGLE_ROWS.slice(2)) addUnavailable(row, classified.message)
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
