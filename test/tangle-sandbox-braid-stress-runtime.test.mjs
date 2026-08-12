import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertExactRemoteStatus,
  assertRestartedCancellationRun,
  assertVerifiedProcessCleanup,
  closeBraidWithProof,
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

test('every telemetry field is observed, unavailable, provider-default, or explicitly in flight', () => {
  const state = { environments: [environment()] }
  const complete = telemetryDisclosure(terminalRun(), state, workspaceVerification, account)
  assert.equal(complete.completeDisclosure, true)
  assert.equal(complete.fields.tokens.status, 'observed')
  assert.equal(complete.fields.endToEndDuration.status, 'observed')

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
