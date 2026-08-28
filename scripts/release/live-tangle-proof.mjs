import { join } from 'node:path'

import { assertMultirunProof } from '../live-required/multirun-contract.mjs'
import { structuredChildEvidence } from './collection-contract.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'

const TANGLE_CHECK_IDS = new Set([
  'live-tangle',
  'LIVE-06',
  'LIVE-07',
  'LIVE-08',
  'LIVE-09',
  'LIVE-10',
])

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

async function readProof(artifactRoot) {
  const bytes = await readRegularFileNoFollow(join(artifactRoot, 'live', 'tangle', 'evidence.json'))
  const proof = JSON.parse(bytes.toString('utf8'))
  assertMultirunProof(proof)
  return proof
}

/** Validates the mandatory LIVE-07 multirun artifact after the command passes. */
export async function readLiveTangleProof({
  artifactRoot,
  checkId,
  processResult,
  redactionSecrets = [],
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
    await readProof(artifactRoot)
  } catch (error) {
    return unavailable(
      checkId,
      `The mandatory Tangle Sandbox multirun artifact is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return childEvidence
}

export { TANGLE_CHECK_IDS }
