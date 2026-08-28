import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { PROOF_OPERATIONS, proofReceipt } from '../scripts/live-required/contracts.mjs'
import { MULTIRUN_REQUIRED_PHASES } from '../scripts/live-required/multirun-contract.mjs'
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

function passedMultirunProof() {
  const runs = [
    {
      runId: 'multirun-a',
      conversationId: 'conversation-a',
      branchId: 'branch-a',
      eventCount: 2,
      eventIdsUnique: true,
      environmentId: 'environment-a',
      identifiers: [
        { kind: 'provider-environment', id: 'environment-a' },
        { kind: 'provider-session', id: 'session-a' },
        { kind: 'provider-execution', id: 'execution-a' },
        { kind: 'provider-run', id: 'multirun-a' },
      ],
      status: 'completed',
    },
    {
      runId: 'multirun-b',
      conversationId: 'conversation-b',
      branchId: 'branch-b',
      eventCount: 2,
      eventIdsUnique: true,
      environmentId: 'environment-b',
      identifiers: [
        { kind: 'provider-environment', id: 'environment-b' },
        { kind: 'provider-session', id: 'session-b' },
        { kind: 'provider-execution', id: 'execution-b' },
        { kind: 'provider-run', id: 'multirun-b' },
      ],
      status: 'cancelled',
    },
  ]
  return {
    schemaVersion: 'braid.live-required.multirun.v1',
    status: 'passed',
    provider: {
      endpoint: 'https://sandbox.tangle.tools',
      runner: 'opencode',
      model: 'tangle-router/glm-5.2',
      lifecycle: 'retained',
      credentialConfigured: true,
    },
    conversations: {
      first: { conversationId: 'conversation-a', branchId: 'branch-a' },
      second: { conversationId: 'conversation-b', branchId: 'branch-b' },
    },
    runs,
    overlap: {
      activeRunCount: 2,
      streamEventCounts: runs.map(({ runId, eventCount }) => ({ runId, count: eventCount })),
      workStripCount: 2,
      renderedWorkStripCount: 2,
      independentConversations: true,
    },
    focus: {
      beforeRunId: 'multirun-b',
      firstSwitchRunId: 'multirun-a',
      secondSwitchRunId: 'multirun-b',
      firstSwitchPreservedStatuses: true,
      secondSwitchPreservedStatuses: true,
    },
    cancellation: {
      targetRunId: 'multirun-b',
      targetStatus: 'cancelled',
      unaffectedRunId: 'multirun-a',
      unaffectedStatusAtAck: 'streaming',
      unaffectedFinalStatus: 'completed',
    },
    replay: { restartedRunCount: 2, noDuplicateEventIds: true, eventSetsStable: true },
    cleanup: {
      exact: true,
      errors: [],
      resources: [
        {
          runId: 'multirun-a',
          environmentId: 'environment-a',
          id: 'resource-a',
          confirmed: true,
        },
        {
          runId: 'multirun-b',
          environmentId: 'environment-b',
          id: 'resource-b',
          confirmed: true,
        },
      ],
      activeResourceDelta: 0,
      accountStable: true,
      workspace: { protectedStoreClean: true, temporaryRootRemoved: true },
    },
    error: null,
    phases: Object.fromEntries(
      MULTIRUN_REQUIRED_PHASES.map((name) => [name, { status: 'passed' }]),
    ),
  }
}

function passedInteractiveProof(
  invocationId,
  {
    runner = 'pi',
    observations = {
      checks: {},
      configuration: {},
      run: {},
      sandbox: {},
      identityContinuity: {},
      processCleanup: {},
    },
  } = {},
) {
  const cloudControl = {
    provider: 'tangle-sandbox',
    environmentId: 'environment-cloud-interactive',
    sessionId: 'session-cloud-interactive',
    executionId: 'execution-cloud-interactive',
    runId: 'run-cloud-interactive',
    requestDigest: `sha256:${'b'.repeat(64)}`,
  }
  return {
    status: 'passed',
    measurement: { kind: 'scalar', name: 'LIVE-08', unit: 'verified-flow', value: 1 },
    evidence: proofReceipt({
      invocationId,
      operation: PROOF_OPERATIONS.tangleSandboxInteractive,
      startedAt: '2026-08-19T00:00:00.000Z',
      completedAt: '2026-08-19T00:01:00.000Z',
      config: {
        endpoint: 'https://sandbox.tangle.tools',
        connectionId: 'connection-live-08',
        connectionKind: 'tangle-sandbox',
        credentialConfigured: true,
        model: 'tangle-router/glm-5.2',
        runner,
      },
      runIds: ['run-interactive'],
      environmentId: 'environment-cloud-interactive',
      facts: {
        environmentId: 'environment-cloud-interactive',
        localRunId: 'run-interactive',
        stoppedStatus: 'aborted',
        cloudControl,
        exactResource: true,
        processExitedBeforeWorkspaceCleanup: true,
        terminalResize: true,
        processGroupExitedBeforeWorkspaceCleanup: true,
      },
      checks: [
        'packed-binary',
        'interactive-command',
        'input',
        'detach',
        'reconnect',
        'terminal-resize',
        'same-local-run',
        'same-provider-control-ref',
        'sandbox-observed-before-stop',
        'stop-through-braid',
        'sandbox-observed-stopped',
        'exact-resource-cleanup',
        'process-exited-before-cleanup',
        'process-group-exited-before-cleanup',
      ],
      observations,
    }),
  }
}

test('built-in LIVE-07 and LIVE-08 wiring emits evidence and deduped dispatch', async () => {
  const stressRunner = async () => passedStressCohort()
  const dispatches = []
  const sandbox = await runSandbox({
    repository,
    environment: {},
    binary: 'unused-injected-binary',
    invocationId: 'live-required-test-invocation',
    stressRunner,
    multirunRunner: async () => passedMultirunProof(),
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
    sandboxRunner: (input) =>
      runSandbox({ ...input, stressRunner, multirunRunner: async () => passedMultirunProof() }),
    interactiveRunner: async (input) => {
      dispatches.push(input)
      return passedInteractiveProof(input.invocationId)
    },
    matrixRunner: async () => ({ status: 'unavailable', reason: 'not in LIVE-09 scope' }),
  })

  assert.deepEqual(
    flows.measurements.map((measurement) => measurement.name),
    ['LIVE-06', 'LIVE-07', 'LIVE-08'],
  )
  assert.equal(flows.flows.find((flow) => flow.row === 'LIVE-07')?.evidence?.status, 'passed')
  assert.equal(flows.flows.find((flow) => flow.row === 'LIVE-08')?.evidence?.status, 'passed')
  assert.equal(dispatches.length, 1)
  assert.equal(dispatches[0]?.repository, repository)
  assert.equal(typeof dispatches[0]?.invocationId, 'string')
  assert.deepEqual(
    flows.unavailable.map((entry) => entry.row),
    ['LIVE-09', 'LIVE-10'],
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

test('LIVE-07 requires passed, complete, and exact multirun evidence', async () => {
  const cases = [
    ['missing', undefined, /multirun evidence is missing/u],
    ['failed', { ...passedMultirunProof(), status: 'failed' }, /multirun evidence did not pass/u],
    [
      'unclean',
      { ...passedMultirunProof(), cleanup: { ...passedMultirunProof().cleanup, exact: false } },
      /multirun cleanup was not exact/u,
    ],
  ]
  for (const [label, multirun, expected] of cases) {
    await assert.rejects(
      runSandbox({
        repository,
        environment: {},
        binary: 'unused-injected-binary',
        invocationId: `live-required-test-${label}`,
        stressRunner: async () => passedStressCohort(),
        multirunRunner: async () => multirun,
      }),
      expected,
      label,
    )
  }
})

test('LIVE-08 rejects a non-Pi runner from the native interactive proof', () => {
  assert.throws(
    () => passedInteractiveProof('live-required-non-pi-runner', { runner: 'codex' }),
    /native Pi harness/u,
  )
})

test('LIVE-08 rejects status-only observations from a passed receipt', () => {
  assert.throws(
    () =>
      passedInteractiveProof('live-required-status-only-observations', {
        observations: { status: 'passed' },
      }),
    /observations\.checks/u,
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
