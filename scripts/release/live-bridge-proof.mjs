import { join } from 'node:path'

import { LIVE_BRIDGE_RELEASE_PROOFS } from '../release-check-catalog.mjs'
import { readRegularFileNoFollow } from '../release-files.mjs'
import { assertLiveEvidenceBinding } from './live-evidence-binding.mjs'

const MEASUREMENT_UNIT = 'successful-packed-live-operation'

function passedMeasurement(requirementId) {
  return {
    kind: 'scalar',
    name: requirementId,
    unit: MEASUREMENT_UNIT,
    value: 1,
  }
}

function unavailable(requirementId, reason, result = 'uncaptured') {
  return {
    result,
    measurements: [{ kind: 'uncaptured', name: requirementId, reason }],
    reason,
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.length > 0
}

function exactKeys(value, required, optional = []) {
  if (!object(value)) return false
  const allowed = new Set([...required, ...optional])
  return (
    Object.keys(value).every((key) => allowed.has(key)) && required.every((key) => key in value)
  )
}

function selectedTargets(evidence) {
  if (!Array.isArray(evidence.selectedTargets) || evidence.selectedTargets.length === 0)
    return undefined
  const targets = evidence.selectedTargets.map((target) => {
    if (
      !exactKeys(target, ['key', 'modelId'], ['label']) ||
      !text(target.key) ||
      !text(target.modelId)
    )
      return undefined
    return { key: target.key, modelId: target.modelId }
  })
  if (targets.some((target) => target === undefined)) return undefined
  if (
    new Set(targets.map(({ key }) => key)).size !== targets.length ||
    new Set(targets.map(({ modelId }) => modelId)).size !== targets.length
  )
    return undefined
  return targets
}

function targetRecords(evidence) {
  if (!Array.isArray(evidence.targets) || evidence.targets.length === 0) return undefined
  if (
    !evidence.targets.every(
      (target) =>
        object(target) &&
        target.status === 'passed' &&
        text(target.target) &&
        object(target.profile) &&
        text(target.profile.harness) &&
        (target.profile.provider === undefined || text(target.profile.provider)) &&
        text(target.profile.model) &&
        object(target.process) &&
        object(target.process.termination) &&
        target.process.termination.exited === true &&
        target.process.termination.descendantsExited === true &&
        target.process.termination.descendantsVerified === true,
    )
  )
    return undefined
  return evidence.targets
}

function targetMatches(proofTarget, target) {
  return (
    object(proofTarget) &&
    exactKeys(proofTarget, ['key', 'harness', 'model'], ['provider']) &&
    text(proofTarget.key) &&
    text(proofTarget.harness) &&
    text(proofTarget.model) &&
    proofTarget.key === target.key &&
    proofTarget.harness === target.profile.harness &&
    proofTarget.provider === target.profile.provider &&
    proofTarget.model === target.profile.model
  )
}

function measuredTargetRecords(evidence) {
  const advertisedTargets = selectedTargets(evidence)
  const targets = targetRecords(evidence)
  if (advertisedTargets === undefined || targets === undefined) return undefined
  const advertisedByModel = new Map(advertisedTargets.map((target) => [target.modelId, target]))
  const measured = targets.map((target) => {
    const advertised = advertisedByModel.get(target.target)
    if (advertised === undefined) return undefined
    const route = [
      target.profile.harness,
      ...(target.profile.provider === undefined ? [] : [target.profile.provider]),
      target.profile.model,
    ].join('/')
    if (route !== target.target) return undefined
    return { ...target, key: advertised.key }
  })
  if (measured.some((target) => target === undefined)) return undefined
  if (
    measured.length !== advertisedTargets.length ||
    new Set(measured.map(({ key }) => key)).size !== measured.length
  )
    return undefined
  return { advertisedTargets, measured }
}

function targetCandidates(mode, targetValue, targets) {
  if (mode === 'harness') return targets.filter((target) => target.profile.harness === targetValue)
  if (mode === 'one-advertised-runner' || mode === 'all-advertised-runners') return targets
  return []
}

function proofEntries(evidence, requirementId, specification) {
  if (!Array.isArray(evidence.releaseProofs)) return undefined
  const entries = evidence.releaseProofs.filter((proof) => proof?.requirementId === requirementId)
  if (entries.length === 0) return undefined
  const measuredTargets = measuredTargetRecords(evidence)
  if (measuredTargets === undefined) return undefined
  const { advertisedTargets, measured } = measuredTargets
  if (new Set(entries.map((entry) => entry.target?.key)).size !== entries.length) return undefined

  const candidates = targetCandidates(
    specification.target.mode,
    specification.target.value,
    measured,
  )
  if (
    (specification.target.mode === 'harness' &&
      (candidates.length !== 1 || entries.length !== 1)) ||
    (specification.target.mode === 'one-advertised-runner' && entries.length !== 1)
  )
    return undefined
  if (
    specification.target.mode === 'all-advertised-runners' &&
    entries.length !== advertisedTargets.length
  )
    return undefined

  for (const entry of entries) {
    if (
      !exactKeys(entry, [
        'requirementId',
        'operation',
        'target',
        'status',
        'packed',
        'runId',
        'measurement',
      ]) ||
      entry.operation !== specification.operation ||
      entry.status !== 'passed' ||
      entry.packed !== true ||
      !text(entry.runId) ||
      !exactKeys(entry.measurement, ['kind', 'name', 'unit', 'value']) ||
      entry.measurement.kind !== 'scalar' ||
      entry.measurement.name !== requirementId ||
      entry.measurement.unit !== MEASUREMENT_UNIT ||
      entry.measurement.value !== 1
    )
      return undefined
    const target = measured.find(
      (candidate) =>
        candidate.key === entry.target.key &&
        candidate.profile.harness === entry.target.harness &&
        candidate.profile.model === entry.target.model,
    )
    if (target === undefined || !targetMatches(entry.target, target)) return undefined
    if (
      specification.target.mode === 'harness' &&
      entry.target.harness !== specification.target.value
    )
      return undefined
  }

  if (specification.target.mode === 'all-advertised-runners') {
    const entryKeys = new Set(entries.map((entry) => entry.target.key))
    if (
      entryKeys.size !== advertisedTargets.length ||
      advertisedTargets.some(({ key }) => !entryKeys.has(key))
    )
      return undefined
  }
  return entries
}

function hasPackedRun(evidence, requirementId) {
  if (!object(evidence) || evidence.schemaVersion !== 1 || evidence.status !== 'passed')
    return 'The packed CLI Bridge run did not pass'
  if (!object(evidence.provider) || !text(evidence.provider.package))
    return 'The packed CLI Bridge provider receipt is missing'
  if (!object(evidence.bridge)) return 'The packed CLI Bridge receipt is missing'
  if (!object(evidence.cleanup) || evidence.cleanup.ok !== true)
    return 'The packed CLI Bridge cleanup receipt is incomplete'
  if (!object(evidence.scope) || !Array.isArray(evidence.scope.excludes))
    return 'The packed CLI Bridge proof scope is missing'
  if (
    evidence.scope.excludes.some(
      (claim) =>
        typeof claim === 'string' &&
        (claim.includes(requirementId) || claim.includes('LIVE-01..05')),
    )
  )
    return `${requirementId} remains excluded from the packed CLI Bridge proof scope`
  return undefined
}

/** Validates one exact LIVE requirement against the retained packed CLI Bridge receipt. */
export function evaluateLiveBridgeProof(evidence, requirementId) {
  const specification = LIVE_BRIDGE_RELEASE_PROOFS[requirementId]
  if (specification === undefined) return undefined
  const packedRunError = hasPackedRun(evidence, requirementId)
  if (packedRunError !== undefined) {
    const unavailableResult = evidence?.status === 'unavailable' ? 'unavailable' : 'uncaptured'
    return unavailable(requirementId, packedRunError, unavailableResult)
  }
  if (proofEntries(evidence, requirementId, specification) === undefined)
    return unavailable(
      requirementId,
      `${requirementId} has no unique passed ${specification.operation} proof for its target scope`,
    )
  return { result: 'passed', measurements: [passedMeasurement(requirementId)], reason: null }
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

/** Reads the live artifact only after the catalog command itself completed successfully. */
export async function readLiveBridgeProof({ artifactRoot, checkId, processResult, identity } = {}) {
  if (LIVE_BRIDGE_RELEASE_PROOFS[checkId] === undefined) return undefined
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
    return unavailable(
      checkId,
      'The packed CLI Bridge command did not emit a passed release result',
    )
  if (typeof artifactRoot !== 'string' || artifactRoot.length === 0)
    return unavailable(checkId, 'The packed CLI Bridge evidence root is missing')
  let evidence
  try {
    evidence = JSON.parse(
      (
        await readRegularFileNoFollow(join(artifactRoot, 'live', 'bridge', 'evidence.json'))
      ).toString('utf8'),
    )
  } catch {
    return unavailable(checkId, 'The packed CLI Bridge evidence artifact is missing or invalid')
  }
  if (identity !== undefined) {
    try {
      assertLiveEvidenceBinding(evidence.releaseBinding, identity, `${checkId} live evidence`)
    } catch (error) {
      return unavailable(
        checkId,
        error instanceof Error ? error.message : `${checkId} live evidence binding is invalid`,
      )
    }
  }
  return evaluateLiveBridgeProof(evidence, checkId)
}

export { MEASUREMENT_UNIT }
