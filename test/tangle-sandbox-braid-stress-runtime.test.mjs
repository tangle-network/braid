import assert from 'node:assert/strict'
import test from 'node:test'
import { NetworkError } from '@tangle-network/sandbox'

import {
  assertExactRemoteStatus,
  assertRestartedCancellationRun,
  assertVerifiedProcessCleanup,
  closeBraidWithProof,
  cleanupOwnedRetainedResources,
  telemetryDisclosure,
} from '../scripts/live-required/tangle-sandbox-braid-stress.mjs'

const controlRef = {
  provider: 'tangle-sandbox',
  environmentId: 'sandbox-runtime-proof',
  sessionId: 'session-runtime-proof',
  executionId: 'execution-runtime-proof',
  runId: 'provider-run-runtime-proof',
  requestDigest: `sha256:${'a'.repeat(64)}`,
}

function environment() {
  return {
    id: 'environment-local-runtime-proof',
    providerEnvironmentId: controlRef.environmentId,
    runtimeEndpointHost: 'runtime.internal',
    machineId: 'machine-runtime-proof',
    placement: { region: 'us-west-2' },
    unavailableTelemetry: [],
  }
}

function terminalRun() {
  return {
    id: 'run-runtime-proof',
    environmentId: 'environment-local-runtime-proof',
    model: 'tangle-router/glm-5.2',
    inputTokens: 12,
    outputTokens: 3,
    tokensKnown: true,
    costUsd: 0.01,
    usdKnown: true,
    startedAt: '2026-08-12T00:00:00.000Z',
    terminalAt: '2026-08-12T00:00:01.000Z',
  }
}

const workspaceVerification = {
  resourceSample: { status: 'observed', value: { cpuPercent: 2 } },
}
const account = { customerId: 'customer-proof', billingOwnerId: 'billing-proof' }

test('remote cancellation status stays bound to one exact provider run', () => {
  const status = {
    status: 'cancelled',
    latestExecutionId: controlRef.executionId,
    runControlRef: controlRef,
  }
  assert.equal(assertExactRemoteStatus(status, controlRef), status)
  assert.throws(
    () =>
      assertExactRemoteStatus({ ...status, latestExecutionId: 'foreign-execution' }, controlRef),
    /another execution/iu,
  )
  assert.throws(
    () =>
      assertExactRemoteStatus(
        { ...status, runControlRef: { ...controlRef, runId: 'foreign-provider-run' } },
        controlRef,
      ),
    /changed provider control identity/iu,
  )
})

test('cancellation retry requires a terminal run with the saved exact control reference', () => {
  const run = { status: 'cancelled', controlRef }
  assert.equal(assertRestartedCancellationRun(run, controlRef), run)
  assert.throws(
    () =>
      assertRestartedCancellationRun(
        { ...run, controlRef: { ...controlRef, executionId: 'foreign-execution' } },
        controlRef,
      ),
    /changed provider control identity/iu,
  )
  assert.throws(
    () => assertRestartedCancellationRun({ ...run, status: 'running' }, controlRef),
    /restored running/iu,
  )
})

test('process proof rejects surviving descendants and an unbounded exit', () => {
  const complete = {
    termination: {
      exited: true,
      descendantsVerified: true,
      cleanupStatus: 'kill',
    },
    exit: { signal: 'SIGKILL', code: null },
  }
  assert.deepEqual(assertVerifiedProcessCleanup(complete, 'test process'), {
    cleanupStatus: 'kill',
    exited: true,
    descendantsVerified: true,
    exit: complete.exit,
  })
  assert.throws(
    () =>
      assertVerifiedProcessCleanup(
        {
          ...complete,
          termination: { ...complete.termination, descendantsVerified: false },
        },
        'test process',
      ),
    /process-tree cleanup/iu,
  )
  assert.throws(
    () => assertVerifiedProcessCleanup({ ...complete, exit: { timeout: true } }, 'test process'),
    /process-tree cleanup/iu,
  )
})

test('shutdown failures retain verified process-tree cleanup evidence', async () => {
  const shutdownError = new Error('shutdown acknowledgement was lost')
  const complete = {
    termination: {
      cleanupStatus: 'term',
      exited: true,
      descendantsVerified: true,
    },
    exit: { code: 0, signal: null },
  }
  const session = {
    closed: false,
    send() {},
    async waitFor() {
      throw shutdownError
    },
    async close() {
      return complete
    },
  }

  await assert.rejects(
    () => closeBraidWithProof(session, 'test process'),
    (error) => {
      assert.equal(error, shutdownError)
      assert.deepEqual(error.processCleanup, {
        cleanupStatus: 'term',
        exited: true,
        descendantsVerified: true,
        exit: complete.exit,
      })
      return true
    },
  )
})

test('retained cleanup retries transient provider reads before deleting the exact resource', async () => {
  let listCalls = 0
  let deleted = false
  const resource = {
    id: controlRef.environmentId,
    name: `braid-${controlRef.sessionId}`,
    metadata: {
      owner: 'braid',
      lifecycle: 'retained',
      providerSessionId: controlRef.sessionId,
    },
    async delete() {
      deleted = true
    },
  }
  const client = {
    async list() {
      listCalls += 1
      if (listCalls === 1) throw new NetworkError('temporary provider outage')
      return deleted ? [] : [resource]
    },
    async get(id) {
      assert.equal(id, controlRef.environmentId)
      return deleted ? null : resource
    },
  }

  const result = await cleanupOwnedRetainedResources(client, { controlRef })

  assert.equal(result.confirmed, true)
  assert.equal(deleted, true)
  assert.equal(listCalls, 3)
  assert.deepEqual(result.remainingIds, [])
})

test('every telemetry field is observed, unavailable, provider-default, or explicitly in flight', () => {
  const state = { environments: [environment()] }
  const complete = telemetryDisclosure(terminalRun(), state, workspaceVerification, account)
  assert.equal(complete.completeDisclosure, true)
  assert.equal(complete.fields.tokens.status, 'observed')
  assert.equal(complete.fields.endToEndDuration.status, 'observed')

  const {
    costUsd: _costUsd,
    startedAt: _startedAt,
    terminalAt: _terminalAt,
    ...headlessRun
  } = terminalRun()
  const unavailable = telemetryDisclosure(
    {
      ...headlessRun,
      tokensKnown: false,
      usdKnown: false,
      durationMs: 1_000,
    },
    state,
    workspaceVerification,
    account,
  )
  assert.equal(unavailable.completeDisclosure, true)
  assert.equal(unavailable.fields.tokens.status, 'unavailable')
  assert.equal(unavailable.fields.cost.status, 'unavailable')
  assert.equal(unavailable.fields.endToEndDuration.status, 'observed')

  const inFlight = telemetryDisclosure(
    {
      id: 'run-runtime-proof',
      environmentId: 'environment-local-runtime-proof',
      model: 'tangle-router/glm-5.2',
    },
    state,
    workspaceVerification,
    account,
    { allowInFlight: true },
  )
  assert.equal(inFlight.fields.tokens.status, 'in-flight')
  assert.equal(inFlight.fields.cost.status, 'in-flight')
  assert.equal(inFlight.fields.endToEndDuration.status, 'in-flight')

  assert.throws(
    () =>
      telemetryDisclosure(terminalRun(), state, { resourceSample: { status: 'missing' } }, account),
    /silently missing/iu,
  )
})
