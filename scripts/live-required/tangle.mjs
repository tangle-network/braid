import { connectionConfiguration } from './configuration.mjs'
import {
  PROOF_OPERATIONS,
  classifyExternalFailure,
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

const TANGLE_ROWS = Object.freeze(['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'])

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

async function runSandbox({ repository, environment, binary, invocationId }) {
  const startedAt = new Date().toISOString()
  const values = connectionConfiguration(environment, {
    prefix: 'BRAID_TANGLE_SANDBOX',
    kind: 'tangle-sandbox',
    endpointNames: ['BRAID_TANGLE_SANDBOX_ENDPOINT', 'BRAID_TANGLE_ENDPOINT'],
    modelNames: ['BRAID_TANGLE_SANDBOX_MODEL', 'BRAID_TANGLE_MODEL'],
    runnerNames: ['BRAID_TANGLE_SANDBOX_RUNNER'],
    providerNames: ['BRAID_TANGLE_SANDBOX_PROVIDER'],
  })
  const config = await prepareProductionWorkspace({
    repository,
    environment,
    ...values,
  })
  let turn
  try {
    turn = await runHeadlessTurn({
      binary,
      config,
      marker: tokenMarker('TANGLE_SANDBOX'),
      prompt: `Reply with exactly ${tokenMarker('TANGLE_SANDBOX')} after creating and reading a temporary workspace file.`,
    })
    const environmentId = turn.run.environmentId
    if (typeof environmentId !== 'string' || environmentId.length === 0) {
      throw new Error('sandbox turn completed without a materialized environment id')
    }
    return {
      status: 'partial',
      evidence: proofReceipt({
        invocationId,
        operation: PROOF_OPERATIONS.tangleSandbox,
        status: 'partial',
        startedAt,
        completedAt: new Date().toISOString(),
        config: configEvidence(config),
        runIds: [turn.run.id],
        environmentId,
        facts: { environmentId },
        checks: ['marker', 'environment-id'],
      }),
      unavailable: {
        row: 'LIVE-07',
        reason:
          'The direct Braid path does not independently prove replay, workspace read/write/exec/git, cancellation, retained environment, or cleanup. No parent-owned operation is available for the full matrix.',
      },
    }
  } finally {
    if (turn?.session) await closeSession(turn.session).catch(() => undefined)
    await config.cleanup()
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

export async function runTangleFlows({ repository, environment }) {
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
    inference = await runInference({ repository, environment, binary, invocationId })
    setFlow('LIVE-06', { row: 'LIVE-06', status: inference.status, evidence: inference.evidence })
    measurements.push(inference.measurement)
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle inference', environment)
    addUnavailable('LIVE-06', classified.message)
  }
  try {
    const sandbox = await runSandbox({ repository, environment, binary, invocationId })
    setFlow('LIVE-07', { row: 'LIVE-07', status: sandbox.status, evidence: sandbox.evidence })
    if (sandbox.unavailable) addUnavailable(sandbox.unavailable.row, sandbox.unavailable.reason)
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle sandbox', environment)
    addUnavailable('LIVE-07', classified.message)
  }
  try {
    const matrix = await runMatrixAdapter({ repository, environment, binary })
    for (const row of TANGLE_ROWS.slice(1)) {
      const reason = `${row} remains protected-unavailable: ${matrix.reason}`
      addUnavailable(row, reason)
    }
  } catch (error) {
    const classified = classifyExternalFailure(error, 'Tangle matrix', environment)
    for (const row of TANGLE_ROWS.slice(1)) addUnavailable(row, classified.message)
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
