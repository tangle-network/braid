import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { safeJson, safeMessage } from './contracts.mjs'
import { runBraidSandboxStress } from './tangle-sandbox-braid-stress.mjs'
import { resourceDelta } from './tangle-sandbox-braid-stress-support.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repository = resolve(dirname(scriptPath), '../..')
const DEFAULT_RUNS = 3
const DEFAULT_CONCURRENCY = 2
const MAX_RUNS = 20
const MAX_CONCURRENCY = 4
const ACCOUNT_USAGE_FIELDS = [
  'activeSandboxes',
  'totalSandboxes',
  'computeMinutes',
  'gpuSeconds',
  'gpuCostUsd',
]
const TELEMETRY_FIELDS = [
  'tokens',
  'cost',
  'endToEndDuration',
  'model',
  'environment',
  'runtimeEndpoint',
  'machine',
  'region',
  'requestedResources',
  'resourceSample',
  'account',
]
const CONTROL_REF_FIELDS = [
  'provider',
  'environmentId',
  'sessionId',
  'executionId',
  'runId',
  'requestDigest',
]
const RUN_SNAPSHOT_NAMES = ['first', 'resumed', 'followUp', 'cancelled']

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function exactControlRef(value) {
  return (
    record(value) !== undefined &&
    value.provider === 'tangle-sandbox' &&
    CONTROL_REF_FIELDS.every((field) => nonEmptyString(value[field])) &&
    /^sha256:[0-9a-f]{64}$/u.test(value.requestDigest)
  )
}

function sameControlRef(left, right) {
  return CONTROL_REF_FIELDS.every((field) => left?.[field] === right?.[field])
}

function usageEntry(proof, phase) {
  return Array.isArray(proof?.usage)
    ? proof.usage.find((entry) => entry?.phase === phase)
    : undefined
}

function measuredUsageDelta(proof) {
  const before = usageEntry(proof, 'before')
  const after = usageEntry(proof, 'after')
  return {
    before,
    after,
    delta: resourceDelta(after?.value, before?.value),
  }
}

function declaredDeltaExpectation(proof, field) {
  const sources = [
    proof?.cleanup?.usageDeltaExpectations,
    proof?.usageDeltaExpectations,
    proof?.accountDeltaExpectations,
  ]
  for (const source of sources) {
    const declaration = source?.[field]
    const expectedMax =
      declaration?.expectedMax ?? declaration?.max ?? declaration?.expected ?? undefined
    if (
      record(declaration) !== undefined &&
      nonEmptyString(declaration.classification) &&
      finiteNonNegative(expectedMax)
    ) {
      return { classification: declaration.classification, expectedMax }
    }
  }
  return undefined
}

function cumulativeExpectation(proof, field, maxConcurrentRuns, aggregate = false) {
  const measuredMs = proof?.timing?.totalMs
  const durationMinutes =
    typeof measuredMs === 'number' && Number.isFinite(measuredMs) && measuredMs > 0
      ? Math.max(1, Math.ceil(measuredMs / 60_000))
      : undefined
  const durationSeconds =
    typeof measuredMs === 'number' && Number.isFinite(measuredMs) && measuredMs > 0
      ? Math.max(1, Math.ceil(measuredMs / 1_000))
      : undefined
  const concurrencyFactor = aggregate ? 1 : Math.max(1, maxConcurrentRuns)
  const declared = declaredDeltaExpectation(proof, field)

  if (field === 'totalSandboxes') {
    const matchedCount = proof?.cleanup?.identity?.matchedCount
    if (!Number.isSafeInteger(matchedCount) || matchedCount < 0) return undefined
    return {
      classification: 'retained-resource-creation',
      expectedMax: matchedCount * concurrencyFactor,
    }
  }
  if (field === 'computeMinutes') {
    if (durationMinutes === undefined) return undefined
    return {
      classification: 'measured-proof-work',
      expectedMax: durationMinutes * concurrencyFactor,
    }
  }
  if (field === 'gpuSeconds') {
    if (declared === undefined) return { classification: 'no-measured-gpu-work', expectedMax: 0 }
    if (durationSeconds === undefined) return undefined
    return {
      classification: declared.classification,
      expectedMax: Math.min(declared.expectedMax, durationSeconds * concurrencyFactor),
    }
  }
  if (field === 'gpuCostUsd') {
    if (declared === undefined) return { classification: 'no-measured-gpu-work', expectedMax: 0 }
    return {
      classification: declared.classification,
      expectedMax: declared.expectedMax * concurrencyFactor,
    }
  }
  return undefined
}

function addUsageFailures(failures, proof, label, maxConcurrentRuns, aggregate = false) {
  const { before, after, delta } = measuredUsageDelta(proof)
  if (before?.status !== 'observed' || record(before?.value) === undefined) {
    failures.push(`${label} usage-before observation was missing`)
  }
  if (after?.status !== 'observed' || record(after?.value) === undefined) {
    failures.push(`${label} usage-after observation was missing`)
  }
  for (const entry of [before, after]) {
    for (const field of ACCOUNT_USAGE_FIELDS) {
      if (!finiteNonNegative(entry?.value?.[field])) {
        failures.push(`${label} usage ${entry?.phase ?? 'unknown'} ${field} was unknown`)
      }
    }
  }

  if (!Array.isArray(delta?.unknownFields) || delta.unknownFields.length > 0) {
    failures.push(
      `${label} account usage delta had unknown fields: ${delta?.unknownFields?.join(', ') ?? 'unavailable'}`,
    )
  }
  if (proof?.cleanup?.activeResourceDeltaRequired === true && delta?.activeSandboxes !== 0) {
    failures.push(
      `${label} account active-resource delta was ${delta?.activeSandboxes ?? 'unknown'}, expected 0`,
    )
  }
  if (
    !aggregate &&
    proof?.cleanup?.activeResourceDeltaRequired === true &&
    proof?.cleanup?.activeResourceDelta !== 0
  ) {
    failures.push(
      `${label} cleanup activeResourceDelta was ${proof?.cleanup?.activeResourceDelta ?? 'unknown'}, expected 0`,
    )
  }

  const reported = proof?.cleanup?.usageDelta
  if (record(reported) === undefined) {
    failures.push(`${label} cleanup usage delta was missing`)
  } else {
    for (const field of ACCOUNT_USAGE_FIELDS) {
      if (reported[field] !== delta?.[field]) {
        failures.push(
          `${label} cleanup usage delta ${field} did not match before/after observations`,
        )
      }
    }
    if (
      !Array.isArray(reported.unknownFields) ||
      JSON.stringify(reported.unknownFields) !== JSON.stringify(delta?.unknownFields ?? [])
    ) {
      failures.push(`${label} cleanup usage delta unknown-field disclosure was invalid`)
    }
  }

  for (const field of ACCOUNT_USAGE_FIELDS.slice(1)) {
    const value = delta?.[field]
    if (!finiteNonNegative(value)) {
      failures.push(`${label} account ${field} delta was unknown`)
      continue
    }
    if (proof?.cleanup?.activeResourceDeltaRequired !== true) continue
    const expectation = cumulativeExpectation(proof, field, maxConcurrentRuns, aggregate)
    if (expectation === undefined) {
      failures.push(`${label} account ${field} delta had no measured-work bound`)
      continue
    }
    if (value > expectation.expectedMax) {
      failures.push(
        `${label} account ${field} delta ${value} exceeded ${expectation.classification} bound ${expectation.expectedMax}`,
      )
    }
    if (value > 0 && !nonEmptyString(expectation.classification)) {
      failures.push(`${label} account ${field} delta lacked an explicit classification`)
    }
    if (field === 'gpuCostUsd' && value > 0 && delta?.gpuSeconds <= 0) {
      failures.push(`${label} account gpuCostUsd delta was not tied to measured GPU work`)
    }
  }
  return { before, after, delta }
}

function addRunSnapshotFailures(failures, runs, name) {
  const snapshot = runs?.[name]
  if (record(snapshot) === undefined) {
    failures.push(`runs.${name} durable snapshot was missing`)
    return undefined
  }
  for (const field of ['id', 'operationId', 'environmentId', 'providerSessionId', 'status']) {
    if (!nonEmptyString(snapshot[field])) failures.push(`runs.${name}.${field} was missing`)
  }
  if (!exactControlRef(snapshot.controlRef)) {
    failures.push(`runs.${name}.controlRef was incomplete`)
  }
  const observations = snapshot.observations
  if (record(observations) === undefined) {
    failures.push(`runs.${name}.observations were missing`)
  } else {
    if (observations.localEnvironmentId !== snapshot.environmentId) {
      failures.push(`runs.${name}.observations.localEnvironmentId was not durable`)
    }
    if (observations.providerEnvironmentId !== snapshot.controlRef?.environmentId) {
      failures.push(`runs.${name}.observations.providerEnvironmentId was not durable`)
    }
    for (const field of ['environmentRecord', 'run', 'environment']) {
      if (record(observations[field]) === undefined) {
        failures.push(`runs.${name}.observations.${field} was missing`)
      }
    }
  }
  if (!nonEmptyString(snapshot.cursor)) failures.push(`runs.${name}.cursor was missing`)
  return snapshot
}

export function proofFailures(proof, { maxConcurrentRuns = 1 } = {}) {
  if (proof?.status !== 'passed') return ['status was not passed']
  const failures = []
  const progress = proof.progress
  const firstControlRef = progress?.firstControlRef
  const freshControlRef = progress?.freshControlRef
  if (record(progress) === undefined) {
    failures.push('progress identity was missing')
  } else {
    for (const field of [
      'firstRunId',
      'cancelRunId',
      'providerEnvironmentId',
      'resumeFromCursor',
      'finalCursor',
    ]) {
      if (!nonEmptyString(progress[field])) failures.push(`progress.${field} was missing`)
    }
    if (!exactControlRef(firstControlRef)) failures.push('progress.firstControlRef was incomplete')
    if (!exactControlRef(freshControlRef)) failures.push('progress.freshControlRef was incomplete')
    if (exactControlRef(firstControlRef) && exactControlRef(freshControlRef)) {
      if (!sameControlRef(firstControlRef, freshControlRef)) {
        failures.push('restart changed the durable provider control identity')
      }
      if (progress.providerEnvironmentId !== firstControlRef.environmentId) {
        failures.push('progress.providerEnvironmentId did not match firstControlRef')
      }
    }
  }

  const runs = proof.runs
  if (record(runs) === undefined) {
    failures.push('durable run snapshots were missing')
  } else {
    const snapshots = Object.fromEntries(
      RUN_SNAPSHOT_NAMES.map((name) => [name, addRunSnapshotFailures(failures, runs, name)]),
    )
    const first = snapshots.first
    const resumed = snapshots.resumed
    const followUp = snapshots.followUp
    const cancelled = snapshots.cancelled
    if (first && progress?.firstRunId !== first.id)
      failures.push('first run identity was not durable')
    if (first && resumed && first.id !== resumed.id)
      failures.push('restart changed the local run identity')
    if (cancelled && progress?.cancelRunId !== cancelled.id) {
      failures.push('cancellation run identity was not durable')
    }
    if (
      first &&
      resumed &&
      exactControlRef(first.controlRef) &&
      exactControlRef(resumed.controlRef)
    ) {
      if (!sameControlRef(first.controlRef, resumed.controlRef)) {
        failures.push('restart changed the run control identity')
      }
    }
    if (exactControlRef(firstControlRef)) {
      for (const [name, snapshot] of [
        ['first', first],
        ['resumed', resumed],
      ]) {
        if (
          snapshot &&
          exactControlRef(snapshot.controlRef) &&
          !sameControlRef(snapshot.controlRef, firstControlRef)
        ) {
          failures.push(`${name} control identity did not match progress.firstControlRef`)
        }
      }
    }
    if (
      exactControlRef(freshControlRef) &&
      resumed &&
      exactControlRef(resumed.controlRef) &&
      !sameControlRef(resumed.controlRef, freshControlRef)
    ) {
      failures.push('progress.freshControlRef did not match the resumed run')
    }
    if (first && followUp && cancelled) {
      for (const [name, snapshot] of [
        ['followUp', followUp],
        ['cancelled', cancelled],
      ]) {
        if (!exactControlRef(snapshot.controlRef)) continue
        if (snapshot.controlRef.environmentId !== first.controlRef?.environmentId) {
          failures.push(`${name} changed the retained environment identity`)
        }
        if (snapshot.controlRef.sessionId !== first.controlRef?.sessionId) {
          failures.push(`${name} changed the retained session identity`)
        }
        if (snapshot.controlRef.executionId === first.controlRef?.executionId) {
          failures.push(`${name} reused the first execution identity`)
        }
        if (snapshot.controlRef.runId === first.controlRef?.runId) {
          failures.push(`${name} reused the first provider run identity`)
        }
      }
    }
    if (resumed?.status !== 'completed') failures.push('resumed run was not completed')
    if (followUp?.status !== 'completed') failures.push('follow-up run was not completed')
    if (!['cancelled', 'aborted'].includes(cancelled?.status)) {
      failures.push('cancelled run did not reach a cancellation terminal state')
    }
  }

  const processes = proof.processes
  if (record(processes) === undefined) {
    failures.push('restart process proof was missing')
  } else {
    if (processes.first?.signal !== 'SIGKILL' || processes.first?.sent !== true) {
      failures.push('restart did not prove active-process disconnect')
    }
    if (processes.first?.code !== null) failures.push('restart exit signal was not durable')
    for (const field of ['first', 'cancelled', 'retry']) {
      const cleanup = processes[field]?.cleanup
      if (
        cleanup?.exited !== true ||
        cleanup?.descendantsVerified !== true ||
        record(cleanup?.exit) === undefined
      ) {
        failures.push(`processes.${field}.cleanup was incomplete`)
      }
    }
    if (processes.localRunCountAfterReconnect !== 1) {
      failures.push('restart did not preserve one local run')
    }
    if (!/^[0-9a-f]{64}$/u.test(processes.binarySha256 ?? '')) {
      failures.push('Braid binary identity was missing')
    }
  }

  const replay = proof.replay
  if (record(replay) === undefined) {
    failures.push('restart/replay proof was missing')
  } else {
    for (const field of ['firstVisibleEventCount', 'freshVisibleEventCount']) {
      if (!Number.isSafeInteger(replay[field]) || replay[field] < 1) {
        failures.push(`replay.${field} was not non-vacuous`)
      }
    }
    for (const field of [
      'resumeFromCursor',
      'finalCursor',
      'acknowledgedBeforeKillEventIds',
      'freshVisibleEventIds',
      'acknowledgedAndFreshIntersection',
      'progress',
      'reconnectRequest',
    ]) {
      if (replay[field] === undefined || replay[field] === null) {
        failures.push(`replay.${field} was missing`)
      }
    }
    for (const field of ['resumeFromCursor', 'finalCursor']) {
      if (!nonEmptyString(replay[field])) failures.push(`replay.${field} was not durable`)
    }
    for (const field of ['acknowledgedBeforeKillEventIds', 'freshVisibleEventIds']) {
      if (
        !Array.isArray(replay[field]) ||
        replay[field].length < 1 ||
        replay[field].some((value) => !nonEmptyString(value))
      ) {
        failures.push(`replay.${field} was not a durable event set`)
      }
    }
    if (replay.freshVisibleEventIdsUnique !== true) {
      failures.push('replay fresh event uniqueness was missing')
    }
    if (!Array.isArray(replay.acknowledgedAndFreshIntersection)) {
      failures.push('replay exclusive resume proof was missing')
    } else if (replay.acknowledgedAndFreshIntersection.length !== 0) {
      failures.push('replay reused an acknowledged provider event')
    }
    if (
      !Number.isSafeInteger(replay.progress?.acknowledgedSequence) ||
      !Number.isSafeInteger(replay.progress?.firstFreshSequence) ||
      replay.progress.firstFreshSequence <= replay.progress.acknowledgedSequence
    ) {
      failures.push('replay cursor progress was missing')
    }
    if (
      replay.reconnectRequest?.command !== 'reconnect' ||
      replay.reconnectRequest?.params?.runId !== progress?.firstRunId
    ) {
      failures.push('replay reconnect request was not durable')
    }
  }

  const cancellation = proof.cancellation
  if (record(cancellation) === undefined) {
    failures.push('cancellation proof was missing')
  } else {
    if (cancellation.first?.type !== 'ack' || !nonEmptyString(cancellation.first.runId)) {
      failures.push('first cancellation acknowledgement was missing')
    }
    if (
      cancellation.sameBody?.type !== 'ack' ||
      (!cancellation.sameBody.replayed && cancellation.sameBody.outcome !== 'already-applied')
    ) {
      failures.push('same-body cancellation replay proof was missing')
    }
    if (
      cancellation.changedBody?.type !== 'error' ||
      cancellation.changedBody.code !== 'OPERATION_CONFLICT'
    ) {
      failures.push('changed-body cancellation conflict proof was missing')
    }
    if (
      cancellation.remote?.settledStatus !== 'cancelled' ||
      cancellation.remote?.lateResult !== false ||
      !exactControlRef(cancellation.remote?.controlRef) ||
      !Array.isArray(cancellation.remote?.samples) ||
      cancellation.remote.samples.length < 1
    ) {
      failures.push('remote cancellation proof was incomplete')
    } else if (
      record(runs?.cancelled) !== undefined &&
      exactControlRef(runs.cancelled.controlRef) &&
      !sameControlRef(cancellation.remote.controlRef, runs.cancelled.controlRef)
    ) {
      failures.push('remote cancellation identity did not match the cancelled run')
    }
  }

  const telemetry = proof.telemetry
  const validateTelemetryDisclosure = (disclosure, label) => {
    if (record(disclosure) === undefined || disclosure.completeDisclosure !== true) {
      failures.push(`${label} complete disclosure was missing`)
      return
    }
    if (!Array.isArray(disclosure.unavailable) || record(disclosure.fields) === undefined) {
      failures.push(`${label} availability disclosure was missing`)
      return
    }
    for (const field of TELEMETRY_FIELDS) {
      const value = disclosure.fields[field]
      if (
        record(value) === undefined ||
        !nonEmptyString(value.status) ||
        value.status === 'missing'
      ) {
        failures.push(`${label}.fields.${field} was missing or silently unavailable`)
      }
    }
  }
  validateTelemetryDisclosure(telemetry, 'telemetry')
  if (record(telemetry?.runs) === undefined) {
    failures.push('telemetry disclosure for every retained run was missing')
  } else {
    for (const name of RUN_SNAPSHOT_NAMES) {
      validateTelemetryDisclosure(telemetry.runs[name], `telemetry.runs.${name}`)
    }
  }

  const workspace = proof.workspaceVerification
  const continuity = proof.followUpEvidence?.continuity
  if (
    workspace?.readMatched !== true ||
    workspace?.continuity?.matched !== true ||
    workspace?.git?.exitCode !== 0 ||
    workspace?.executionAttempt?.matched !== true ||
    workspace?.executionAttempt?.lineCount !== 1 ||
    !nonEmptyString(workspace?.executionAttempt?.path) ||
    continuity?.matched !== true ||
    !Number.isSafeInteger(proof.followUpEvidence?.visibleProviderEvents) ||
    proof.followUpEvidence.visibleProviderEvents < 1
  ) {
    failures.push('retained workspace continuity or exactly-once proof was incomplete')
  }

  const resourceIdentity = proof.resourceIdentity
  if (
    resourceIdentity?.observed !== true ||
    !nonEmptyString(resourceIdentity.id) ||
    !nonEmptyString(resourceIdentity.name) ||
    resourceIdentity.metadata?.owner !== 'braid' ||
    resourceIdentity.metadata?.lifecycle !== 'retained' ||
    resourceIdentity.metadata?.providerSessionId !== firstControlRef?.sessionId ||
    resourceIdentity.id !== firstControlRef?.environmentId
  ) {
    failures.push('retained resource identity was incomplete')
  }

  const cleanup = proof.cleanup
  if (record(cleanup) === undefined) {
    failures.push('cleanup proof was missing')
  } else {
    if (cleanup.exactResource !== true || cleanup.mode !== 'exact-owned-resource-set') {
      failures.push('exact retained cleanup was not proven')
    }
    if (cleanup.activeResourceDeltaRequired === true && cleanup.activeResourceDelta !== 0) {
      failures.push(
        `cleanup activeResourceDelta was ${cleanup.activeResourceDelta ?? 'unknown'}, expected 0`,
      )
    }
    if (typeof cleanup.activeResourceDeltaRequired !== 'boolean') {
      failures.push('cleanup active-resource requirement was not durable')
    }
    if (
      cleanup.accountUsageScope !== 'account-wide' ||
      !['exclusive-proof-window', 'unattributed-shared-usage'].includes(
        cleanup.accountUsageAttribution,
      )
    ) {
      failures.push('cleanup account usage attribution was missing')
    }
    if (cleanup.usageObservationComplete !== true) {
      failures.push('cleanup usage observation was incomplete')
    }
    const identity = cleanup.identity
    if (
      identity?.confirmed !== true ||
      !Number.isSafeInteger(identity.matchedCount) ||
      identity.matchedCount !== 1 ||
      !Array.isArray(identity.removedIds) ||
      identity.removedIds.length !== 1 ||
      identity.removedIds[0] !== resourceIdentity?.id ||
      !Array.isArray(identity.remainingIds) ||
      identity.remainingIds.length !== 0 ||
      !Array.isArray(identity.deletions) ||
      identity.deletions.length < 1 ||
      identity.deletions.some((deletion) => deletion?.confirmed !== true)
    ) {
      failures.push('durable exact cleanup identity was incomplete')
    }
  }

  const accountIdentity = proof.accountIdentityConsistency
  if (accountIdentity?.stable !== true || !nonEmptyString(accountIdentity.identityDigest)) {
    failures.push('stable account identity was missing')
  }
  const identities = proof.accountIdentities
  if (!Array.isArray(identities)) {
    failures.push('durable account identity observations were missing')
  } else {
    for (const phase of ['before', 'after']) {
      const entry = identities.find((candidate) => candidate?.phase === phase)
      if (entry?.status !== 'observed' || !nonEmptyString(entry.value?.identityDigest)) {
        failures.push(`account identity ${phase} observation was incomplete`)
      }
    }
  }
  if (
    record(proof.account) === undefined ||
    proof.account.identityDigest !== accountIdentity?.identityDigest
  ) {
    failures.push('execution account identity was not tied to the stable account')
  }

  addUsageFailures(failures, proof, 'proof', maxConcurrentRuns)
  return [...new Set(failures)]
}

function argument(name, argv = process.argv) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined
}

function boundedInteger(value, fallback, maximum, label) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}`)
  }
  return parsed
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right)
  if (sorted.length === 0) return { n: 0, min: null, median: null, p90: null, max: null }
  return {
    n: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.at(-1),
  }
}

function proofPassed(proof, maxConcurrentRuns = 1) {
  return proofFailures(proof, { maxConcurrentRuns }).length === 0
}

function proofIdentity(proof) {
  return proof?.progress?.firstControlRef?.environmentId
}

function accountKey(proof) {
  const account = proof?.accountIdentityConsistency
  return account?.stable === true ? account.identityDigest : undefined
}

function latencySummary(attempts) {
  const phases = new Set()
  for (const attempt of attempts) {
    for (const phase of Object.keys(attempt.proof?.timing ?? {})) {
      if (phase !== 'totalMs') phases.add(phase)
    }
  }
  return {
    totalMs: distribution(attempts.map((attempt) => attempt.proof?.timing?.totalMs)),
    phases: Object.fromEntries(
      [...phases]
        .sort()
        .map((phase) => [
          phase,
          distribution(attempts.map((attempt) => attempt.proof?.timing?.[phase]?.elapsedMs)),
        ]),
    ),
  }
}

function sessionSpend(attempts) {
  const rows = attempts.flatMap((attempt) =>
    (attempt.proof?.spend?.rows ?? []).map((row) => ({ attempt: attempt.index, ...row })),
  )
  const tokenRows = rows.map((row) => row.tokens)
  const costRows = rows.map((row) => row.cost)
  const observedTokens = tokenRows.filter((row) => row?.status === 'observed')
  const observedCosts = costRows.filter((row) => row?.status === 'observed')
  return {
    scope: 'every unique local run in every cloud proof',
    rows,
    tokens: {
      observedRuns: observedTokens.length,
      unavailableRuns: tokenRows.filter((row) => row?.status === 'unavailable').length,
      missingRuns: tokenRows.filter((row) => row?.status === 'missing').length,
      input: observedTokens.reduce((total, row) => total + (row.input ?? 0), 0),
      output: observedTokens.reduce((total, row) => total + (row.output ?? 0), 0),
    },
    cost: {
      observedRuns: observedCosts.length,
      unavailableRuns: costRows.filter((row) => row?.status === 'unavailable').length,
      missingRuns: costRows.filter((row) => row?.status === 'missing').length,
      usd: observedCosts.reduce((total, row) => total + (row.usd ?? 0), 0),
    },
  }
}

function cohortUsage(attempts) {
  const beforeEntry = attempts[0]?.proof?.usage?.find((entry) => entry.phase === 'before')
  const finalAttempt = attempts
    .toSorted((left, right) => left.completionSequence - right.completionSequence)
    .at(-1)
  const afterEntry = finalAttempt?.proof?.usage?.find((entry) => entry.phase === 'after')
  const before = beforeEntry?.value
  const after = afterEntry?.value
  const delta = resourceDelta(after, before)
  return {
    complete:
      beforeEntry?.status === 'observed' &&
      afterEntry?.status === 'observed' &&
      record(before) !== undefined &&
      record(after) !== undefined &&
      delta.unknownFields.length === 0,
    before: before ?? null,
    after: after ?? null,
    delta,
  }
}

function cohortAccountFailures(usage) {
  const failures = []
  if (!usage.complete) {
    failures.push('cohort account usage delta was unavailable or unknown')
    return failures
  }
  for (const field of ACCOUNT_USAGE_FIELDS) {
    const value = usage.delta[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      failures.push(`cohort account ${field} delta was unknown`)
    }
  }
  return failures
}

function cohortFailures(attempts, requestedRuns, concurrency, usage) {
  const failures = []
  if (attempts.length !== requestedRuns) {
    failures.push(`attempted ${attempts.length} of ${requestedRuns} requested runs`)
  }
  for (const attempt of attempts) {
    const proofErrors = proofFailures(attempt.proof, { maxConcurrentRuns: concurrency })
    if (proofErrors.length > 0) {
      failures.push(`run ${attempt.index + 1} did not pass exact proof`)
      failures.push(...proofErrors.map((error) => `run ${attempt.index + 1}: ${error}`))
    }
  }

  const uniqueField = (label, values) => {
    if (values.some((value) => typeof value !== 'string' || value.length === 0)) {
      failures.push(`${label} was missing`)
      return
    }
    if (new Set(values).size !== values.length) failures.push(`${label} was reused across runs`)
  }
  uniqueField(
    'proof identity',
    attempts.map((attempt) => attempt.proof?.proofId),
  )
  uniqueField(
    'cloud environment identity',
    attempts.map((attempt) => proofIdentity(attempt.proof)),
  )

  const binaries = attempts.map((attempt) => attempt.proof?.processes?.binarySha256)
  if (binaries.some((value) => typeof value !== 'string' || value.length === 0)) {
    failures.push('Braid binary digest was missing')
  } else if (new Set(binaries).size !== 1) {
    failures.push('Braid binary changed during the cohort')
  }

  const accounts = attempts.map((attempt) => accountKey(attempt.proof))
  if (accounts.some((value) => value === undefined)) {
    failures.push('Sandbox account identity was missing')
  } else if (new Set(accounts).size !== 1) {
    failures.push('Sandbox account identity changed during the cohort')
  }
  failures.push(...cohortAccountFailures(usage))
  return [...new Set(failures)]
}

function finish({ attempts, requestedRuns, concurrency, startedAt, stoppedAfterCanary }) {
  const usage = cohortUsage(attempts)
  const failures = cohortFailures(attempts, requestedRuns, concurrency, usage)
  const activeResourceDeltas = attempts.map(
    (attempt) => attempt.proof?.cleanup?.activeResourceDelta ?? null,
  )
  const remainingResourceCounts = attempts.map((attempt) => {
    const remainingIds = attempt.proof?.cleanup?.identity?.remainingIds
    return Array.isArray(remainingIds) ? remainingIds.length : null
  })
  return {
    schemaVersion: 'braid.tangle-sandbox-braid-soak.v1',
    status: failures.length === 0 ? 'passed' : 'failed',
    startedAt,
    completedAt: new Date().toISOString(),
    requestedRuns,
    attemptedRuns: attempts.length,
    concurrency,
    stoppedAfterCanary,
    failures,
    cleanup: {
      exactProofs: attempts.filter((attempt) => attempt.proof?.cleanup?.exactResource === true)
        .length,
      exactResourcesRemaining: remainingResourceCounts.includes(null)
        ? null
        : remainingResourceCounts.reduce((total, count) => total + count, 0),
      resourceProofsUnavailable: remainingResourceCounts.filter((count) => count === null).length,
      activeResourceDelta: usage.delta.activeSandboxes,
      activeResourceDeltas,
    },
    accountUsage: usage,
    latency: latencySummary(attempts),
    sessionSpend: sessionSpend(attempts),
    attempts,
  }
}

export async function runBraidSandboxSoak({
  environment = process.env,
  repository: suppliedRepository = repository,
  binary,
  runs = boundedInteger(
    environment.BRAID_TANGLE_SANDBOX_STRESS_RUNS,
    DEFAULT_RUNS,
    MAX_RUNS,
    'runs',
  ),
  concurrency = boundedInteger(
    environment.BRAID_TANGLE_SANDBOX_STRESS_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY,
    'concurrency',
  ),
  stressRunner = runBraidSandboxStress,
} = {}) {
  const requestedRuns = boundedInteger(runs, DEFAULT_RUNS, MAX_RUNS, 'runs')
  const requestedConcurrency = Math.min(
    boundedInteger(concurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, 'concurrency'),
    requestedRuns,
  )
  const startedAt = new Date().toISOString()
  const attempts = []
  let completionSequence = 0

  const attempt = async (index, requireZeroActiveResourceDelta) => {
    const attemptStartedAt = new Date().toISOString()
    let proof
    try {
      proof = await stressRunner({
        environment,
        repository: suppliedRepository,
        binary,
        requireZeroActiveResourceDelta,
        attemptIndex: index,
      })
    } catch (error) {
      if (error && typeof error === 'object' && error.unavailable === true) throw error
      proof = {
        status: 'failed',
        failure: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
    return {
      index,
      completionSequence: completionSequence++,
      startedAt: attemptStartedAt,
      completedAt: new Date().toISOString(),
      requireZeroActiveResourceDelta,
      proof,
    }
  }

  const canary = await attempt(0, false)
  attempts.push(canary)
  if (!proofPassed(canary.proof, requestedConcurrency) || requestedRuns === 1) {
    return finish({
      attempts,
      requestedRuns,
      concurrency: requestedConcurrency,
      startedAt,
      stoppedAfterCanary: !proofPassed(canary.proof, requestedConcurrency),
    })
  }

  let nextIndex = 1
  let stop = false
  const workers = Array.from(
    { length: Math.min(requestedConcurrency, requestedRuns - 1) },
    async () => {
      while (!stop) {
        const index = nextIndex
        nextIndex += 1
        if (index >= requestedRuns) return
        const completed = await attempt(index, false)
        attempts.push(completed)
        if (!proofPassed(completed.proof, requestedConcurrency)) stop = true
      }
    },
  )
  await Promise.all(workers)
  attempts.sort((left, right) => left.index - right.index)
  return finish({
    attempts,
    requestedRuns,
    concurrency: requestedConcurrency,
    startedAt,
    stoppedAfterCanary: false,
  })
}

async function writeOutput(path, value) {
  const resolved = resolve(path)
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 })
  await writeFile(resolved, `${safeJson(value)}\n`, { mode: 0o600 })
}

async function main() {
  const result = await runBraidSandboxSoak({
    runs: boundedInteger(argument('runs'), DEFAULT_RUNS, MAX_RUNS, 'runs'),
    concurrency: boundedInteger(
      argument('concurrency'),
      DEFAULT_CONCURRENCY,
      MAX_CONCURRENCY,
      'concurrency',
    ),
  })
  const output = argument('output')
  if (output) await writeOutput(output, result)
  process.stdout.write(`${safeJson(result)}\n`)
  if (result.status !== 'passed') process.exitCode = 1
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${safeMessage(error)}\n`)
    process.exitCode = 1
  })
}
