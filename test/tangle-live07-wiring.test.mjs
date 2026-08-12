import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { runSandbox, runTangleFlows } from '../scripts/live-required/tangle.mjs'
import { cleanupRetainedResourceByRunId } from '../scripts/live-required/tangle-sandbox-braid-stress.mjs'

const repository = resolve(new URL('../', import.meta.url).pathname)

function passedStressProof() {
  const first = { id: 'run-first', environmentId: 'environment-local' }
  return {
    status: 'passed',
    config: {
      endpoint: 'https://sandbox.tangle.tools',
      connectionId: 'connection-live-07',
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      runner: 'pi',
    },
    runs: {
      first,
      resumed: { id: first.id, environmentId: first.environmentId },
      followUp: { id: 'run-follow-up', environmentId: first.environmentId },
      cancelled: { id: 'run-cancelled', environmentId: first.environmentId },
    },
    replay: {
      resumeFromCursor: 'cursor-before-kill',
      finalCursor: 'cursor-final',
    },
    cleanup: { exactResource: true, activeResourceDelta: 0 },
    progress: {
      firstControlRef: {
        provider: 'tangle-sandbox',
        environmentId: 'environment-cloud',
        sessionId: 'session-cloud',
        executionId: 'execution-cloud',
        runId: 'run-cloud',
        requestDigest: `sha256:${'a'.repeat(64)}`,
      },
    },
  }
}

function passedStressCohort() {
  const attempts = Array.from({ length: 3 }, (_, index) => ({
    index,
    proof: {
      ...passedStressProof(),
      proofId: `proof-${index}`,
      progress: {
        firstControlRef: {
          ...passedStressProof().progress.firstControlRef,
          environmentId: `environment-cloud-${index}`,
        },
      },
    },
  }))
  return {
    status: 'passed',
    failures: [],
    requestedRuns: 3,
    attemptedRuns: 3,
    concurrency: 2,
    cleanup: { exactProofs: 3, exactResourcesRemaining: 0, activeResourceDelta: 0 },
    attempts,
  }
}

test('built-in LIVE-07 wiring emits evidence and one measurement with deduped run IDs', async () => {
  const stressRunner = async () => passedStressCohort()
  const sandbox = await runSandbox({
    repository,
    environment: {},
    binary: 'unused-injected-binary',
    invocationId: 'live-required-test-invocation',
    stressRunner,
  })

  assert.equal(sandbox.status, 'passed')
  assert.equal(sandbox.measurement.name, 'LIVE-07')
  assert.equal(sandbox.evidence.status, 'passed')
  assert.deepEqual(sandbox.evidence.run.ids, ['run-first', 'run-follow-up', 'run-cancelled'])

  const flows = await runTangleFlows({
    repository,
    environment: {},
    inferenceRunner: async () => ({
      status: 'passed',
      measurement: { kind: 'scalar', name: 'LIVE-06', unit: 'verified-flow', value: 1 },
      evidence: null,
    }),
    sandboxRunner: (input) => runSandbox({ ...input, stressRunner }),
    matrixRunner: async () => ({ status: 'unavailable', reason: 'not in LIVE-07 scope' }),
  })

  assert.deepEqual(
    flows.measurements.map((measurement) => measurement.name),
    ['LIVE-06', 'LIVE-07'],
  )
  assert.equal(flows.flows.find((flow) => flow.row === 'LIVE-07')?.evidence?.status, 'passed')
  assert.deepEqual(
    flows.unavailable.map((entry) => entry.row),
    ['LIVE-08', 'LIVE-09', 'LIVE-10'],
  )
})

test('LIVE-07 rejects a passing canary presented as a stress cohort', async () => {
  const cohort = passedStressCohort()
  await assert.rejects(
    runSandbox({
      repository,
      environment: {},
      binary: 'unused-injected-binary',
      invocationId: 'live-required-test-underpowered-cohort',
      stressRunner: async () => ({
        ...cohort,
        requestedRuns: 1,
        attemptedRuns: 1,
        concurrency: 1,
        cleanup: { exactProofs: 1, exactResourcesRemaining: 0, activeResourceDelta: 0 },
        attempts: cohort.attempts.slice(0, 1),
      }),
    }),
    /at least three complete cloud proofs/u,
  )
})

test('fail-safe cleanup derives one exact Braid resource from the first local run ID', async () => {
  const firstRunId = 'local/run-1'
  const box = {
    id: 'environment-fallback',
    name: 'braid-session-braid-local-run-1',
    metadata: {
      owner: 'braid',
      lifecycle: 'retained',
      providerSessionId: 'session-braid-local-run-1',
    },
    deleted: false,
    async delete() {
      this.deleted = true
    },
  }
  const other = {
    id: 'environment-other',
    name: box.name,
    metadata: {
      owner: 'other',
      lifecycle: 'retained',
      providerSessionId: box.metadata.providerSessionId,
    },
  }
  const client = {
    async list() {
      return [other, box]
    },
    async get(id) {
      return id === box.id && !box.deleted ? box : null
    },
  }

  const cleanup = await cleanupRetainedResourceByRunId(client, firstRunId)
  assert.equal(cleanup.confirmed, true)
  assert.equal(cleanup.id, box.id)
  assert.equal(box.deleted, true)
})
