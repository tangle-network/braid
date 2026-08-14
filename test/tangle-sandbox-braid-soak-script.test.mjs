import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runBraidSandboxSoak } from '../scripts/live-required/tangle-sandbox-braid-soak.mjs'

function mergeRecords(base, override) {
  if (
    base !== null &&
    typeof base === 'object' &&
    !Array.isArray(base) &&
    override !== null &&
    typeof override === 'object' &&
    !Array.isArray(override)
  ) {
    return Object.fromEntries(
      [...new Set([...Object.keys(base), ...Object.keys(override)])].map((key) => [
        key,
        mergeRecords(base[key], override[key]),
      ]),
    )
  }
  return override === undefined ? base : override
}

function passedProof(index, overrides = {}) {
  const accountIdentityDigest = 'd'.repeat(64)
  const environmentId = `sandbox-${index}`
  const localEnvironmentId = `local-environment-${index}`
  const sessionId = `session-${index}`
  const firstRunId = `local-run-${index}`
  const followUpRunId = `follow-up-run-${index}`
  const cancelRunId = `cancel-run-${index}`
  const firstControlRef = {
    provider: 'tangle-sandbox',
    environmentId,
    sessionId,
    executionId: `execution-${index}`,
    runId: `provider-run-${index}`,
    requestDigest: `sha256:${'a'.repeat(64)}`,
  }
  const followUpControlRef = {
    ...firstControlRef,
    executionId: `follow-up-execution-${index}`,
    runId: `follow-up-provider-run-${index}`,
    requestDigest: `sha256:${'b'.repeat(64)}`,
  }
  const cancelControlRef = {
    ...firstControlRef,
    executionId: `cancel-execution-${index}`,
    runId: `cancel-provider-run-${index}`,
    requestDigest: `sha256:${'c'.repeat(64)}`,
  }
  const snapshot = ({ id, operationId, status, controlRef, cursor }) => ({
    id,
    operationId,
    status,
    environmentId: localEnvironmentId,
    providerSessionId: sessionId,
    cursor,
    controlRef,
    observations: {
      localEnvironmentId,
      providerEnvironmentId: environmentId,
      environmentRecord: { id: localEnvironmentId, providerEnvironmentId: environmentId },
      run: { id, status },
      environment: { id: localEnvironmentId, providerEnvironmentId: environmentId },
    },
  })
  const beforeUsage = {
    activeSandboxes: 0,
    totalSandboxes: index,
    computeMinutes: index,
    gpuSeconds: 0,
    gpuCostUsd: 0,
  }
  const afterUsage = {
    activeSandboxes: 0,
    totalSandboxes: index + 1,
    computeMinutes: index + 1,
    gpuSeconds: 0,
    gpuCostUsd: 0,
  }
  const verifiedProcessCleanup = {
    exited: true,
    descendantsVerified: true,
    exit: { code: 0, signal: null },
  }
  const telemetryFields = {
    tokens: { status: 'observed', input: 10, output: 2 },
    cost: { status: 'observed', usd: 0.001 },
    endToEndDuration: { status: 'observed', milliseconds: 100 },
    model: { status: 'observed', value: 'test-model' },
    environment: { status: 'observed', value: environmentId },
    runtimeEndpoint: { status: 'observed', host: 'sandbox.test' },
    machine: { status: 'unavailable' },
    region: { status: 'observed', value: 'test-region' },
    requestedResources: { status: 'provider-default' },
    resourceSample: { status: 'observed', value: { activeSandboxes: 0 } },
    account: {
      status: 'observed',
      value: { identityDigest: accountIdentityDigest },
    },
  }
  const telemetryDisclosure = {
    completeDisclosure: true,
    unavailable: ['machine-id:not-supported'],
    fields: telemetryFields,
  }
  return mergeRecords(
    {
      status: 'passed',
      proofId: `proof-${index}`,
      resourceIdentity: {
        observed: true,
        id: environmentId,
        name: `braid-${sessionId}`,
        metadata: {
          owner: 'braid',
          lifecycle: 'retained',
          providerSessionId: sessionId,
        },
      },
      processes: {
        first: { signal: 'SIGKILL', code: null, sent: true, cleanup: verifiedProcessCleanup },
        cancelled: { cleanup: verifiedProcessCleanup },
        retry: { cleanup: verifiedProcessCleanup },
        localRunCountAfterReconnect: 1,
        binarySha256: 'b'.repeat(64),
      },
      runs: {
        first: snapshot({
          id: firstRunId,
          operationId: `op-${index}-first`,
          status: 'running',
          controlRef: firstControlRef,
          cursor: `cursor-first-${index}`,
        }),
        resumed: snapshot({
          id: firstRunId,
          operationId: `op-${index}-first`,
          status: 'completed',
          controlRef: firstControlRef,
          cursor: `cursor-resumed-${index}`,
        }),
        followUp: snapshot({
          id: followUpRunId,
          operationId: `op-${index}-follow-up`,
          status: 'completed',
          controlRef: followUpControlRef,
          cursor: `cursor-follow-up-${index}`,
        }),
        cancelled: snapshot({
          id: cancelRunId,
          operationId: `op-${index}-cancel`,
          status: 'cancelled',
          controlRef: cancelControlRef,
          cursor: `cursor-cancel-${index}`,
        }),
      },
      progress: {
        firstRunId,
        cancelRunId,
        providerEnvironmentId: environmentId,
        firstControlRef,
        resumeFromCursor: `cursor-first-${index}`,
        freshControlRef: firstControlRef,
        finalCursor: `cursor-resumed-${index}`,
      },
      replay: {
        firstVisibleEventCount: 2,
        freshVisibleEventCount: 2,
        freshVisibleEventIdsUnique: true,
        resumeFromCursor: `cursor-first-${index}`,
        finalCursor: `cursor-resumed-${index}`,
        acknowledgedBeforeKillEventIds: [`event-first-${index}`],
        freshVisibleEventIds: [`event-fresh-${index}`],
        acknowledgedAndFreshIntersection: [],
        progress: { acknowledgedSequence: 2, firstFreshSequence: 3 },
        reconnectRequest: {
          command: 'reconnect',
          operationId: `op-${index}-reconnect`,
          params: { runId: firstRunId },
        },
      },
      cancellation: {
        first: { type: 'ack', runId: cancelRunId, operationId: `op-${index}-cancel` },
        sameBody: {
          type: 'ack',
          runId: cancelRunId,
          operationId: `op-${index}-cancel`,
          replayed: true,
        },
        changedBody: { type: 'error', code: 'OPERATION_CONFLICT' },
        remote: {
          controlRef: cancelControlRef,
          samples: [{ status: 'running' }, { status: 'cancelled' }],
          settledStatus: 'cancelled',
          messageCount: 1,
          lateResult: false,
        },
      },
      cleanup: {
        exactResource: true,
        mode: 'exact-owned-resource-set',
        activeResourceDelta: 0,
        activeResourceDeltaRequired: false,
        accountUsageScope: 'account-wide',
        accountUsageAttribution: 'unattributed-shared-usage',
        usageObservationComplete: true,
        usageDelta: {
          activeSandboxes: 0,
          totalSandboxes: 1,
          computeMinutes: 1,
          gpuSeconds: 0,
          gpuCostUsd: 0,
          unknownFields: [],
        },
        identity: {
          confirmed: true,
          mode: 'exact-owned-resource-set',
          matchedCount: 1,
          removedIds: [environmentId],
          deletions: [{ id: environmentId, confirmed: true }],
          remainingIds: [],
        },
      },
      accountIdentityConsistency: {
        stable: true,
        identityDigest: accountIdentityDigest,
      },
      accountIdentities: [
        {
          phase: 'before',
          status: 'observed',
          value: { identityDigest: accountIdentityDigest },
        },
        {
          phase: 'after',
          status: 'observed',
          value: { identityDigest: accountIdentityDigest },
        },
      ],
      account: {
        identityDigest: accountIdentityDigest,
        usage: afterUsage,
      },
      usage: [
        {
          phase: 'before',
          status: 'observed',
          value: beforeUsage,
        },
        {
          phase: 'after',
          status: 'observed',
          value: afterUsage,
        },
      ],
      telemetry: {
        ...telemetryDisclosure,
        runs: {
          first: telemetryDisclosure,
          resumed: telemetryDisclosure,
          followUp: telemetryDisclosure,
          cancelled: telemetryDisclosure,
        },
      },
      workspaceVerification: {
        readMatched: true,
        continuity: { matched: true },
        git: { exitCode: 0 },
        resourceSample: { status: 'observed', value: { activeSandboxes: 0 } },
      },
      followUpEvidence: {
        visibleProviderEvents: 1,
        continuity: { matched: true },
      },
      spend: {
        rows: [
          {
            label: 'resumed-first-turn',
            tokens: { status: 'observed', input: 10 + index, output: 2 + index },
            cost: { status: 'observed', usd: 0.001 + index / 1_000 },
          },
          {
            label: 'follow-up-turn',
            tokens: { status: 'observed', input: 5, output: 1 },
            cost: { status: 'unavailable' },
          },
          {
            label: 'cancelled-turn',
            tokens: { status: 'unavailable' },
            cost: { status: 'unavailable' },
          },
        ],
      },
      timing: {
        totalMs: 100 + index,
        workspace: { elapsedMs: 20 + index },
        reconnect: { elapsedMs: 30 + index },
      },
    },
    overrides,
  )
}

function proofWithUsage(index, beforeOverrides = {}, afterOverrides = {}) {
  const base = passedProof(index)
  const before = { ...base.usage[0].value, ...beforeOverrides }
  const after = { ...base.usage[1].value, ...afterOverrides }
  const delta = Object.fromEntries(
    Object.keys(base.cleanup.usageDelta)
      .filter((field) => field !== 'unknownFields')
      .map((field) => [
        field,
        typeof before[field] === 'number' &&
        Number.isFinite(before[field]) &&
        typeof after[field] === 'number' &&
        Number.isFinite(after[field])
          ? after[field] - before[field]
          : null,
      ]),
  )
  delta.unknownFields = Object.keys(delta).filter((field) => delta[field] === null)
  return mergeRecords(base, {
    usage: [
      { phase: 'before', status: 'observed', value: before },
      { phase: 'after', status: 'observed', value: after },
    ],
    cleanup: {
      activeResourceDelta: delta.activeSandboxes,
      usageDelta: delta,
    },
  })
}

function proofWithCloudEnvironment(index, environmentId) {
  const proof = structuredClone(passedProof(index))
  const rewriteControlRef = (controlRef) => {
    controlRef.environmentId = environmentId
  }
  rewriteControlRef(proof.progress.firstControlRef)
  rewriteControlRef(proof.progress.freshControlRef)
  proof.progress.providerEnvironmentId = environmentId
  for (const snapshot of Object.values(proof.runs)) {
    rewriteControlRef(snapshot.controlRef)
    snapshot.observations.providerEnvironmentId = environmentId
    snapshot.observations.environmentRecord.providerEnvironmentId = environmentId
    snapshot.observations.environment.providerEnvironmentId = environmentId
  }
  proof.resourceIdentity.id = environmentId
  proof.cleanup.identity.removedIds = [environmentId]
  proof.cancellation.remote.controlRef.environmentId = environmentId
  proof.telemetry.fields.environment.value = environmentId
  for (const disclosure of Object.values(proof.telemetry.runs)) {
    disclosure.fields.environment.value = environmentId
  }
  return proof
}

test('sandbox soak stops after a failed canary before spending on more runs', async () => {
  let calls = 0
  const result = await runBraidSandboxSoak({
    runs: 5,
    concurrency: 3,
    stressRunner: async ({ attemptIndex, requireZeroActiveResourceDelta }) => {
      calls += 1
      assert.equal(attemptIndex, 0)
      assert.equal(requireZeroActiveResourceDelta, false)
      return passedProof(0, { status: 'failed' })
    },
  })

  assert.equal(calls, 1)
  assert.equal(result.status, 'failed')
  assert.equal(result.attemptedRuns, 1)
  assert.equal(result.stoppedAfterCanary, true)
  assert.match(result.failures[0], /attempted 1 of 5/u)
})

test('sandbox soak keeps an unavailable cleanup count distinct from a measured leak', async () => {
  const result = await runBraidSandboxSoak({
    runs: 1,
    concurrency: 1,
    stressRunner: async () => ({
      status: 'failed',
      proofId: 'proof-unavailable-cleanup',
      cleanup: { exactResource: false, activeResourceDelta: null },
      accountIdentityConsistency: null,
      usage: [],
      timing: { totalMs: 1 },
    }),
  })

  assert.equal(result.cleanup.exactResourcesRemaining, null)
  assert.equal(result.cleanup.resourceProofsUnavailable, 1)
})

test('sandbox soak preserves protected-provider unavailability', async () => {
  const unavailable = new Error('protected credential is unavailable')
  unavailable.unavailable = true
  await assert.rejects(
    runBraidSandboxSoak({
      runs: 3,
      stressRunner: async () => {
        throw unavailable
      },
    }),
    (error) => error === unavailable,
  )
})

test('sandbox soak runs one canary then a bounded parallel cohort with full summaries', async () => {
  let active = 0
  let maximumActive = 0
  const strictness = []
  const result = await runBraidSandboxSoak({
    runs: 5,
    concurrency: 2,
    stressRunner: async ({ attemptIndex, requireZeroActiveResourceDelta }) => {
      strictness[attemptIndex] = requireZeroActiveResourceDelta
      active += 1
      maximumActive = Math.max(maximumActive, active)
      if (attemptIndex > 0) await delay(5)
      active -= 1
      return passedProof(attemptIndex)
    },
  })

  assert.equal(result.status, 'passed')
  assert.equal(result.attemptedRuns, 5)
  assert.equal(maximumActive, 2)
  assert.deepEqual(strictness, [false, false, false, false, false])
  assert.deepEqual(result.latency.totalMs, {
    n: 5,
    min: 100,
    median: 102,
    p90: 104,
    max: 104,
  })
  assert.equal(result.latency.phases.workspace.n, 5)
  assert.equal(result.cleanup.exactProofs, 5)
  assert.equal(result.cleanup.exactResourcesRemaining, 0)
  assert.equal(result.cleanup.resourceProofsUnavailable, 0)
  assert.deepEqual(result.sessionSpend.tokens, {
    observedRuns: 10,
    unavailableRuns: 5,
    missingRuns: 0,
    input: 85,
    output: 25,
  })
  assert.equal(result.sessionSpend.cost.observedRuns, 5)
  assert.equal(result.sessionSpend.cost.unavailableRuns, 10)
  assert.ok(Math.abs(result.sessionSpend.cost.usd - 0.015) < Number.EPSILON)
})

test('sandbox soak rejects a passed proof with missing durable retained fields', async () => {
  const result = await runBraidSandboxSoak({
    runs: 1,
    stressRunner: async () =>
      passedProof(0, {
        progress: { freshControlRef: null },
        replay: { resumeFromCursor: '' },
      }),
  })

  assert.equal(result.status, 'failed')
  assert.ok(result.failures.some((failure) => /freshControlRef.*incomplete/u.test(failure)))
  assert.ok(result.failures.some((failure) => /replay\.resumeFromCursor/u.test(failure)))
})

test('sandbox soak does not attribute shared account churn to exact owned resources', async () => {
  const result = await runBraidSandboxSoak({
    runs: 3,
    concurrency: 2,
    stressRunner: async ({ attemptIndex }) => {
      if (attemptIndex === 0) return passedProof(0)
      if (attemptIndex === 1) {
        await delay(5)
        return proofWithUsage(1, { activeSandboxes: 0 }, { activeSandboxes: 1 })
      }
      await delay(15)
      return proofWithUsage(2, { activeSandboxes: 1 }, { activeSandboxes: 0 })
    },
  })

  assert.equal(result.status, 'passed')
  assert.equal(result.cleanup.activeResourceDelta, 0)
  assert.equal(result.cleanup.exactResourcesRemaining, 0)
})

test('sandbox soak rejects unknown account deltas instead of treating them as zero', async () => {
  const result = await runBraidSandboxSoak({
    runs: 1,
    stressRunner: async () => proofWithUsage(0, {}, { computeMinutes: null }),
  })

  assert.equal(result.status, 'failed')
  assert.ok(result.failures.some((failure) => /computeMinutes.*unknown/u.test(failure)))
  assert.ok(result.failures.some((failure) => /unknown fields.*computeMinutes/u.test(failure)))
})

test('sandbox soak reports shared cumulative account increases without claiming ownership', async () => {
  const result = await runBraidSandboxSoak({
    runs: 1,
    stressRunner: async () => proofWithUsage(0, { totalSandboxes: 0 }, { totalSandboxes: 99 }),
  })

  assert.equal(result.status, 'passed')
  assert.equal(result.accountUsage.delta.totalSandboxes, 99)
})

test('sandbox soak enforces account deltas only for an explicit exclusive window', async () => {
  const proof = proofWithUsage(0, { activeSandboxes: 0 }, { activeSandboxes: 1 })
  const exclusive = await runBraidSandboxSoak({
    runs: 1,
    stressRunner: async () => ({
      ...proof,
      cleanup: {
        ...proof.cleanup,
        activeResourceDeltaRequired: true,
        accountUsageAttribution: 'exclusive-proof-window',
      },
    }),
  })
  assert.equal(exclusive.status, 'failed')
  assert.ok(exclusive.failures.some((failure) => /active-resource delta was 1/u.test(failure)))
})

test('sandbox soak rejects reused cloud identity despite individually passing proofs', async () => {
  const result = await runBraidSandboxSoak({
    runs: 2,
    concurrency: 1,
    stressRunner: async ({ attemptIndex }) =>
      proofWithCloudEnvironment(attemptIndex, 'sandbox-reused'),
  })

  assert.equal(result.status, 'failed')
  assert.ok(result.failures.includes('cloud environment identity was reused across runs'))
})

test('sandbox soak stops scheduling after a post-canary failure', async () => {
  const started = []
  const result = await runBraidSandboxSoak({
    runs: 8,
    concurrency: 2,
    stressRunner: async ({ attemptIndex }) => {
      started.push(attemptIndex)
      if (attemptIndex === 1) return passedProof(attemptIndex, { status: 'failed' })
      if (attemptIndex > 1) await delay(10)
      return passedProof(attemptIndex)
    },
  })

  assert.equal(result.status, 'failed')
  assert.ok(started.length <= 3)
  assert.ok(started.includes(0))
  assert.ok(started.includes(1))
})
