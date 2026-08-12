import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { runBraidSandboxSoak } from '../scripts/live-required/tangle-sandbox-braid-soak.mjs'

function passedProof(index, overrides = {}) {
  return {
    status: 'passed',
    proofId: `proof-${index}`,
    processes: { binarySha256: 'b'.repeat(64) },
    progress: {
      firstControlRef: {
        provider: 'tangle-sandbox',
        environmentId: `sandbox-${index}`,
        sessionId: `session-${index}`,
        executionId: `execution-${index}`,
        runId: `provider-run-${index}`,
        requestDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
    cleanup: {
      exactResource: true,
      activeResourceDelta: 0,
      identity: { confirmed: true, remainingIds: [] },
    },
    accountIdentityConsistency: {
      stable: true,
      customerId: 'customer-1',
      billingOwnerId: 'billing-owner-1',
    },
    usage: [
      {
        phase: 'before',
        status: 'observed',
        value: { activeSandboxes: 0, totalSandboxes: index, computeMinutes: index },
      },
      {
        phase: 'after',
        status: 'observed',
        value: { activeSandboxes: 0, totalSandboxes: index + 1, computeMinutes: index + 1 },
      },
    ],
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
    ...overrides,
  }
}

test('sandbox soak stops after a failed canary before spending on more runs', async () => {
  let calls = 0
  const result = await runBraidSandboxSoak({
    runs: 5,
    concurrency: 3,
    stressRunner: async ({ attemptIndex, requireZeroActiveResourceDelta }) => {
      calls += 1
      assert.equal(attemptIndex, 0)
      assert.equal(requireZeroActiveResourceDelta, true)
      return passedProof(0, { status: 'failed' })
    },
  })

  assert.equal(calls, 1)
  assert.equal(result.status, 'failed')
  assert.equal(result.attemptedRuns, 1)
  assert.equal(result.stoppedAfterCanary, true)
  assert.match(result.failures[0], /attempted 1 of 5/u)
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
  assert.deepEqual(strictness, [true, false, false, false, false])
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

test('sandbox soak rejects reused cloud identity despite individually passing proofs', async () => {
  const result = await runBraidSandboxSoak({
    runs: 2,
    concurrency: 1,
    stressRunner: async ({ attemptIndex }) =>
      passedProof(attemptIndex, {
        progress: {
          firstControlRef: {
            provider: 'tangle-sandbox',
            environmentId: 'sandbox-reused',
            sessionId: `session-${attemptIndex}`,
            executionId: `execution-${attemptIndex}`,
            runId: `provider-run-${attemptIndex}`,
            requestDigest: `sha256:${'a'.repeat(64)}`,
          },
        },
      }),
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
