import { join } from 'node:path'
import {
  assertProofReceipt,
  PROOF_OPERATIONS,
  TANGLE_RECEIPTS_SCHEMA,
} from '../live-required/contracts.mjs'
import { assertMultirunProof } from '../live-required/multirun-contract.mjs'
import { assertExactKeys } from '../release-evidence.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'
import { structuredChildEvidence } from './collection-contract.mjs'
import { assertLiveEvidenceBinding } from './live-evidence-binding.mjs'

const TANGLE_CHECK_IDS = new Set([
  'live-tangle',
  'LIVE-06',
  'LIVE-07',
  'LIVE-08',
  'LIVE-09',
  'LIVE-10',
])
const TANGLE_ROWS = Object.freeze(['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'])
const TANGLE_ROW_OPERATIONS = Object.freeze({
  'LIVE-06': PROOF_OPERATIONS.tangleInference,
  'LIVE-07': PROOF_OPERATIONS.tangleSandbox,
  'LIVE-08': PROOF_OPERATIONS.tangleSandboxInteractive,
  'LIVE-09': PROOF_OPERATIONS.tangleWorkspaceFork,
  'LIVE-10': PROOF_OPERATIONS.tangleConfidential,
})

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unavailable(checkId, reason) {
  return {
    result: 'uncaptured',
    measurements: [{ kind: 'uncaptured', name: checkId, reason }],
    reason,
  }
}

function resultMarkerStatus(stdoutBytes) {
  const markers = String(Buffer.from(stdoutBytes ?? Buffer.alloc(0)))
    .split('\n')
    .filter((line) => line.startsWith('BRAID_RELEASE_RESULT_JSON='))
  if (markers.length !== 1) return undefined
  try {
    const marker = JSON.parse(markers[0].slice('BRAID_RELEASE_RESULT_JSON='.length))
    return object(marker) && typeof marker.status === 'string' ? marker.status : undefined
  } catch {
    return undefined
  }
}

async function readProof(artifactRoot, identity) {
  const bytes = await readRegularFileNoFollow(join(artifactRoot, 'live', 'tangle', 'evidence.json'))
  const proof = JSON.parse(bytes.toString('utf8'))
  assertMultirunProof(proof)
  if (identity !== undefined)
    assertLiveEvidenceBinding(proof.releaseBinding, identity, 'LIVE-07 multirun evidence')
  return proof
}

export function assertTangleReceipts(value, identity) {
  assertExactKeys(value, ['schema', 'flows'], [], 'Tangle receipt evidence')
  if (value.schema !== TANGLE_RECEIPTS_SCHEMA)
    throw new Error('Tangle receipt evidence has an unsupported schema')
  if (!Array.isArray(value.flows)) throw new Error('Tangle receipt evidence has no flow list')
  const rows = new Set()
  for (const flow of value.flows) {
    assertExactKeys(
      flow,
      ['row', 'status'],
      ['reason', 'evidence'],
      `Tangle receipt ${String(flow?.row)}`,
    )
    if (!TANGLE_ROWS.includes(flow.row)) throw new Error(`Tangle receipt names ${String(flow.row)}`)
    if (rows.has(flow.row)) throw new Error(`Tangle receipt repeats ${flow.row}`)
    rows.add(flow.row)
    if (!['passed', 'partial', 'failed', 'unavailable'].includes(flow.status))
      throw new Error(`Tangle receipt ${flow.row} has an invalid status`)
    if (flow.evidence !== undefined) {
      assertProofReceipt(flow.evidence)
      if (flow.evidence.operation !== TANGLE_ROW_OPERATIONS[flow.row])
        throw new Error(`${flow.row} receipt uses the wrong proof operation`)
      if (flow.evidence.status !== flow.status)
        throw new Error(`${flow.row} receipt status differs from its proof receipt`)
      if (identity !== undefined)
        assertLiveEvidenceBinding(
          flow.evidence.releaseBinding,
          identity,
          `${flow.row} live evidence`,
        )
    }
    if (flow.status === 'passed' && flow.evidence === undefined)
      throw new Error(`Passed ${flow.row} has no proof receipt`)
  }
  if (rows.size !== TANGLE_ROWS.length || TANGLE_ROWS.some((row) => !rows.has(row)))
    throw new Error('Tangle receipt evidence does not cover every live row')
  return value
}

async function readReceipts(artifactRoot, identity) {
  const bytes = await readRegularFileNoFollow(join(artifactRoot, 'live', 'tangle', 'receipts.json'))
  const receipts = JSON.parse(bytes.toString('utf8'))
  return assertTangleReceipts(receipts, identity)
}

function assertPassedRows(receipts, checkId) {
  const rows = checkId === 'live-tangle' ? TANGLE_ROWS : [checkId]
  for (const row of rows) {
    const receipt = receipts.flows.find((flow) => flow.row === row)
    if (receipt?.status !== 'passed')
      throw new Error(`${row} does not have a passed live proof receipt`)
  }
}

/** Validates the mandatory LIVE-07 multirun artifact after the command passes. */
export async function readLiveTangleProof({
  artifactRoot,
  checkId,
  processResult,
  redactionSecrets = [],
  identity,
} = {}) {
  if (!TANGLE_CHECK_IDS.has(checkId)) return undefined
  if (
    processResult?.exitCode !== 0 ||
    processResult.signal !== null ||
    processResult.timedOut !== false ||
    processResult.spawnError !== null ||
    processResult.cleanupConfirmed !== true ||
    processResult.stdout?.redactionFailClosed !== false ||
    processResult.stderr?.redactionFailClosed !== false
  )
    return undefined
  if (
    resultMarkerStatus(processResult.structuredStdout?.bytes ?? processResult.stdout?.bytes) !==
    'passed'
  )
    return unavailable(checkId, 'The Tangle live command did not emit a passed release result')
  let childEvidence
  try {
    childEvidence = structuredChildEvidence(
      'live',
      processResult.structuredStdout?.bytes ?? processResult.stdout?.bytes,
      processResult.durationMs,
      checkId,
      processResult.structuredStdout?.error,
      redactionSecrets,
    )
  } catch (error) {
    return unavailable(checkId, error instanceof Error ? error.message : String(error))
  }
  if (childEvidence.result !== 'passed') return childEvidence
  try {
    await readProof(artifactRoot, identity)
    if (identity !== undefined) {
      const receipts = await readReceipts(artifactRoot, identity)
      assertPassedRows(receipts, checkId)
    }
  } catch (error) {
    return unavailable(
      checkId,
      `The mandatory Tangle Sandbox multirun artifact is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return childEvidence
}

export { TANGLE_CHECK_IDS }
