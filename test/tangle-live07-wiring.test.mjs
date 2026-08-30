import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { toEvent } from '../dist/adapters/tui/ui-projection.js'
import { PROOF_OPERATIONS, proofReceipt } from '../scripts/live-required/contracts.mjs'
import { prepareProductionWorkspace } from '../scripts/live-required/headless.mjs'
import {
  DEFAULT_TANGLE_ROUTER_MODEL,
  DEFAULT_TANGLE_ROUTER_MODEL_ID,
} from '../scripts/live-required/model-defaults.mjs'
import { MULTIRUN_REQUIRED_PHASES } from '../scripts/live-required/multirun-contract.mjs'
import { supervisorProfile } from '../scripts/live-required/supervisor.mjs'
import { runSandbox, runTangleFlows } from '../scripts/live-required/tangle.mjs'
import { sandboxEnvironment } from '../scripts/live-required/tangle-sandbox-braid-execution-soak.mjs'
import {
  assertInteractiveTelemetry,
  assertProviderBoundEvidence,
  finalizeInteractiveProof,
  interactiveFailureMessages,
  interactiveMaterializationEvidence,
  interactiveProofCommandSequence,
  sandboxConfiguration as interactiveSandboxConfiguration,
  waitForInteractiveIdentityFrame,
} from '../scripts/live-required/tangle-sandbox-braid-interactive.mjs'
import { sandboxConfiguration as multirunSandboxConfiguration } from '../scripts/live-required/tangle-sandbox-braid-multirun.mjs'
import { assertSingleExecutionAttemptLedger } from '../scripts/live-required/tangle-sandbox-braid-stress.mjs'
import { backendConfiguration as workerBackendConfiguration } from '../scripts/live-required/tangle-sandbox-worker.mjs'
import { sandboxConfiguration as workspaceSandboxConfiguration } from '../scripts/live-required/tangle-workspace-proof.mjs'

const repository = resolve(new URL('../', import.meta.url).pathname)

test('active Tangle Sandbox checks share the current router model default', () => {
  const environment = {
    BRAID_TANGLE_SANDBOX_API_KEY: 'test-only-placeholder',
    BRAID_TANGLE_SANDBOX_MODEL_API_KEY: 'test-only-placeholder',
  }
  const expectedProfileModel = DEFAULT_TANGLE_ROUTER_MODEL
  assert.equal(DEFAULT_TANGLE_ROUTER_MODEL_ID, 'glm-5.3')
  assert.equal(workspaceSandboxConfiguration(environment).model, expectedProfileModel)
  assert.equal(workspaceSandboxConfiguration(environment).modelProvider, 'tangle-router')
  assert.equal(multirunSandboxConfiguration(environment).model, expectedProfileModel)
  assert.equal(multirunSandboxConfiguration(environment).modelProvider, 'tangle-router')
  assert.equal(interactiveSandboxConfiguration(environment).model, expectedProfileModel)
  assert.equal(interactiveSandboxConfiguration(environment).modelProvider, 'tangle-router')
  assert.equal(sandboxEnvironment({}).BRAID_TANGLE_SANDBOX_MODEL, expectedProfileModel)
  assert.equal(workerBackendConfiguration(environment).model.model, DEFAULT_TANGLE_ROUTER_MODEL_ID)
  assert.equal(workerBackendConfiguration(environment).profile.model.default, expectedProfileModel)
  assert.equal(supervisorProfile({}).model.default, expectedProfileModel)
})

test('Tangle Sandbox workspace profiles pin model identity separately from connection kind', async () => {
  const values = interactiveSandboxConfiguration({
    BRAID_TANGLE_SANDBOX_CREDENTIAL_REF: 'credential-ref-live-provider-split',
  })
  const config = await prepareProductionWorkspace({
    repository,
    environment: {},
    ...values,
  })
  try {
    assert.equal(config.connection.kind, 'tangle-sandbox')
    assert.equal(config.profile.model.provider, 'tangle-router')
    assert.equal(config.profile.model.default, DEFAULT_TANGLE_ROUTER_MODEL)
  } finally {
    await config.cleanup()
  }
})

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
      modelProvider: 'tangle-router',
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
      localEnvironmentId: 'local-environment-a',
      providerEnvironmentId: 'environment-a',
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
      localEnvironmentId: 'local-environment-b',
      providerEnvironmentId: 'environment-b',
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
    schemaVersion: 'braid.live-required.multirun.v2',
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
      dispatch: {
        eventKind: 'run.control.requested',
        control: 'cancel',
        runId: 'multirun-b',
        operationId: 'operation-cancel-b',
        sequence: 3,
      },
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
          providerEnvironmentId: 'environment-a',
          id: 'resource-a',
          confirmed: true,
        },
        {
          runId: 'multirun-b',
          providerEnvironmentId: 'environment-b',
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
      providerEvidence: {},
      executionAttempt: {},
      usage: {},
      accountIdentities: {},
      accountIdentityConsistency: {},
      usageDelta: {},
      telemetry: {},
      spend: {},
      timing: {},
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
        modelProvider: 'tangle-router',
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
        providerInput: true,
        providerReconnect: true,
        singleProviderExecutionAttempt: true,
        exactOwnedResourceSetCleanup: true,
        accountIdentityStable: true,
        activeResourceDelta: 0,
        telemetryComplete: true,
        spendDisclosed: true,
        latencyObserved: true,
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
        'provider-bound-input',
        'provider-bound-reconnect',
        'single-provider-execution-attempt',
        'exact-owned-resource-set-cleanup',
        'account-identity-stable',
        'active-resource-delta',
        'telemetry-complete',
        'spend-disclosed',
        'latency-observed',
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

test('Tangle aggregate records unavailable rows and rejects invalid passed rows', async () => {
  const unavailable = await runTangleFlows({
    repository,
    environment: {},
    inferenceRunner: async () => ({ status: 'unavailable', reason: 'inference unavailable' }),
    sandboxRunner: async () => ({ status: 'unavailable', reason: 'sandbox unavailable' }),
    interactiveRunner: async () => ({ status: 'unavailable', reason: 'interactive unavailable' }),
    matrixRunner: async () => ({ status: 'unavailable', reason: 'matrix unavailable' }),
  })

  assert.equal(unavailable.status, 'partial')
  assert.deepEqual(unavailable.measurements, [])
  assert.deepEqual(
    unavailable.unavailable.map((entry) => entry.row),
    ['LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'],
  )

  await assert.rejects(
    runTangleFlows({
      repository,
      environment: {},
      inferenceRunner: async () => ({
        status: 'failed',
        measurement: { kind: 'scalar', name: 'LIVE-06', unit: 'verified-flow', value: 1 },
      }),
      sandboxRunner: async () => ({ status: 'unavailable', reason: 'sandbox unavailable' }),
      interactiveRunner: async () => ({
        status: 'unavailable',
        reason: 'interactive unavailable',
      }),
      matrixRunner: async () => ({ status: 'unavailable', reason: 'matrix unavailable' }),
    }),
    /LIVE-06 live proof returned invalid status failed/u,
  )

  await assert.rejects(
    runTangleFlows({
      repository,
      environment: {},
      inferenceRunner: async () => ({ status: 'passed', evidence: null }),
      sandboxRunner: async () => ({ status: 'unavailable', reason: 'sandbox unavailable' }),
      interactiveRunner: async () => ({
        status: 'unavailable',
        reason: 'interactive unavailable',
      }),
      matrixRunner: async () => ({ status: 'unavailable', reason: 'matrix unavailable' }),
    }),
    /LIVE-06 live proof passed without its required measurement/u,
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
    [
      'missing cancellation dispatch',
      {
        ...passedMultirunProof(),
        cancellation: { ...passedMultirunProof().cancellation, dispatch: null },
      },
      /cancellation dispatch evidence is missing/u,
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

test('LIVE-08 uses Pi native shell input for non-model workspace mutations', () => {
  const commands = interactiveProofCommandSequence({
    proofId: 'proof-quote',
    outputSeed: 'output-seed',
    input: 'INPUT_VALUE',
    reconnect: 'RECONNECT_VALUE',
    inputPath: '.braid-live/proof-quote/input file.txt',
    reconnectPath: ".braid-live/proof-quote/reconnect's file.txt",
    attemptPath: '.braid-live/proof-quote/attempts/one.txt',
    executionAttempt: 'ATTEMPT_VALUE',
  })

  assert.match(commands[0], /\/interactive/iu)
  assert.equal(
    commands[1],
    "!!printf '%s\\n' 'INPUT_VALUE' >> '.braid-live/proof-quote/input file.txt'",
  )
  assert.equal(
    commands[5],
    `!!printf '%s\\n' 'RECONNECT_VALUE' >> '.braid-live/proof-quote/reconnect'"'"'s file.txt'`,
  )
  assert.equal(commands.filter((command) => command.startsWith('!!')).length, 2)
})

test('LIVE-08 waits past streamed output until retained admission is durable', async () => {
  const controlRef = {
    provider: 'tangle-sandbox',
    environmentId: 'environment-live-08-admission',
    sessionId: 'session-live-08-admission',
    executionId: 'execution-live-08-admission',
    runId: 'provider-run-live-08-admission',
    requestDigest: `sha256:${'a'.repeat(64)}`,
  }
  const incomplete = {
    state: {
      runs: [{ id: 'local-run-live-08-admission', status: 'streaming' }],
    },
  }
  const admitted = {
    state: {
      runs: [
        {
          id: 'local-run-live-08-admission',
          status: 'streaming',
          controlRef,
          providerSessionId: controlRef.sessionId,
        },
      ],
    },
    events: [
      toEvent({
        sequence: 1,
        revision: 1,
        event: {
          kind: 'run.retained.admitted',
          runId: 'local-run-live-08-admission',
          admission: { phase: 'interactive_intent' },
        },
      }),
      toEvent({
        sequence: 2,
        revision: 2,
        event: {
          kind: 'run.retained.admitted',
          runId: 'local-run-live-08-admission',
          admission: { phase: 'interactive_environment' },
        },
      }),
      toEvent({
        sequence: 3,
        revision: 3,
        event: {
          kind: 'run.retained.admitted',
          runId: 'local-run-live-08-admission',
          admission: { phase: 'interactive_started', ref: { run: controlRef } },
        },
      }),
    ],
  }
  const frames = [incomplete, admitted]
  let captures = 0
  const result = await waitForInteractiveIdentityFrame({
    captureFrame: async () => {
      captures += 1
      return frames.shift()
    },
    timeoutMs: 1_000,
  })
  assert.equal(captures, 2)
  assert.equal(result.frame, admitted)
  assert.equal(result.identity.run.id, 'local-run-live-08-admission')
  assert.deepEqual(result.identity.controlRef, controlRef)
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

test('LIVE-08 rejects input evidence that only observed local terminal echo', () => {
  assert.throws(
    () =>
      assertProviderBoundEvidence(
        {
          provider: 'tangle-sandbox',
          source: 'sandbox-workspace-read',
          providerObserved: false,
          localEchoOnly: true,
        },
        'interactive input',
      ),
    /provider-bound/u,
  )
})

test('LIVE-08 rejects missing telemetry and latency status', () => {
  assert.throws(
    () =>
      assertInteractiveTelemetry(
        { completeDisclosure: true, fields: { environment: { status: 'missing' } } },
        undefined,
        undefined,
      ),
    /missing fields/u,
  )
})

test('LIVE-07 and LIVE-08 reject duplicate provider execution attempts', () => {
  assert.throws(
    () => assertSingleExecutionAttemptLedger('attempt-1\nattempt-1\n', 'attempt-1'),
    /exactly one/u,
  )
})

test('LIVE-08 reports sanitized nested proof and cleanup failures', () => {
  const secret = 'live-interactive-secret'
  const failure = new AggregateError(
    [
      new Error(`interaction failed with ${secret}`),
      new AggregateError([new Error('exact cleanup failed')], 'cleanup incomplete'),
    ],
    'interactive proof failed',
  )
  assert.deepEqual(interactiveFailureMessages(failure, { TANGLE_API_KEY: secret }), [
    'interactive proof failed',
    'interaction failed with [REDACTED]',
    'cleanup incomplete',
    'exact cleanup failed',
  ])
})

test('LIVE-08 cleans local resources without inventing a cloud leak before admission', async () => {
  let workspaceCleanup = 0
  let packedCleanup = 0
  const result = await finalizeInteractiveProof({
    packed: {
      binary: '/tmp/braid',
      cleanup: async () => {
        packedCleanup += 1
      },
    },
    config: {
      cleanup: async () => {
        workspaceCleanup += 1
        return { credentialRemoved: true, temporaryRootRemoved: true }
      },
    },
    recordPath: '/does/not/exist/without-an-admitted-run.json',
    executionStarted: false,
  })
  assert.equal(result.identity, undefined)
  assert.equal(workspaceCleanup, 1)
  assert.equal(packedCleanup, 1)
})

test('LIVE-08 confirms Sandbox absence for a provider rejection before interactive_environment', async () => {
  let listCalls = 0
  let workspaceCleanup = 0
  let packedCleanup = 0
  const materialization = interactiveMaterializationEvidence({
    state: {
      runs: [
        {
          id: 'run-pre-environment',
          status: 'streaming',
        },
      ],
    },
    events: [
      toEvent({
        sequence: 1,
        revision: 1,
        event: {
          kind: 'run.retained.admitted',
          runId: 'run-pre-environment',
          admission: { phase: 'interactive_intent' },
        },
      }),
    ],
  })
  assert.deepEqual(materialization, {
    runId: 'run-pre-environment',
    phase: 'interactive_intent',
    materialized: false,
    boundary: 'before-interactive_environment',
  })
  const result = await finalizeInteractiveProof({
    packed: {
      binary: '/tmp/braid',
      cleanup: async () => {
        packedCleanup += 1
      },
    },
    config: {
      cleanup: async () => {
        workspaceCleanup += 1
        return { credentialRemoved: true, temporaryRootRemoved: true }
      },
    },
    client: {
      async list() {
        listCalls += 1
        return []
      },
    },
    executionStarted: true,
    recordPath: '/does/not/exist/without-an-exact-run-identity.json',
    materialization,
  })
  assert.equal(listCalls, 2)
  assert.deepEqual(result.providerMaterialization, {
    confirmed: true,
    mode: 'run-derived-absence',
    phase: 'interactive_intent',
    runId: 'run-pre-environment',
    expectedName: 'braid-interactive-run-pre-environment',
    matchedCount: 0,
    observedIds: [],
    removedIds: [],
    deletions: [],
    remainingIds: [],
  })
  assert.equal(workspaceCleanup, 1)
  assert.equal(packedCleanup, 1)
})

test('LIVE-08 ignores internal retained admission state absent from projected events', () => {
  const state = {
    state: {
      runs: [
        {
          id: 'run-hidden-admission',
          status: 'streaming',
          retainedAdmission: { phase: 'interactive_intent' },
        },
      ],
    },
  }
  assert.deepEqual(interactiveMaterializationEvidence(state), {
    runId: 'run-hidden-admission',
    phase: null,
    materialized: false,
    boundary: 'unknown',
  })
  assert.deepEqual(
    interactiveMaterializationEvidence({
      state: state.state,
      events: [
        {
          kind: 'run.retained.admitted',
          runId: 'run-hidden-admission',
          admission: { phase: 'interactive_intent' },
        },
      ],
    }),
    {
      runId: 'run-hidden-admission',
      phase: null,
      materialized: false,
      boundary: 'unknown',
    },
  )
})

test('LIVE-08 deletes and confirms one exact resource when the Runtime phase is unavailable', async () => {
  const resource = {
    id: 'sandbox-pre-environment',
    name: 'braid-interactive-run-pre-environment',
    metadata: { owner: 'braid', lifecycle: 'retained', surface: 'interactive-agent' },
    deleted: false,
    async delete() {
      this.deleted = true
    },
  }
  const client = {
    async list() {
      return resource.deleted ? [] : [resource]
    },
    async get(id) {
      return id === resource.id && !resource.deleted ? resource : null
    },
  }
  const result = await finalizeInteractiveProof({
    client,
    executionStarted: true,
    materialization: {
      runId: 'run-pre-environment',
      phase: null,
      materialized: false,
      boundary: 'unknown',
    },
  })
  assert.equal(resource.deleted, true)
  assert.deepEqual(result.providerMaterialization, {
    confirmed: true,
    mode: 'run-derived-owned-resource-set',
    phase: null,
    runId: 'run-pre-environment',
    expectedName: 'braid-interactive-run-pre-environment',
    matchedCount: 1,
    observedIds: ['sandbox-pre-environment'],
    removedIds: ['sandbox-pre-environment'],
    deletions: [
      {
        id: 'sandbox-pre-environment',
        observed: true,
        resolved: true,
        deleted: true,
        confirmed: true,
      },
    ],
    remainingIds: [],
  })
})

test('LIVE-08 deletes the run-derived resource when provider materialization exists without a record', async () => {
  let listCalls = 0
  let getCalls = 0
  const materialization = interactiveMaterializationEvidence({
    state: {
      runs: [
        {
          id: 'run-materialized-without-record',
          status: 'detached',
          controlRef: { environmentId: 'sandbox-materialized-without-record' },
        },
      ],
    },
  })
  assert.deepEqual(materialization, {
    runId: 'run-materialized-without-record',
    phase: null,
    materialized: true,
    boundary: 'provider-environment-identity',
  })
  const resource = {
    id: 'sandbox-materialized-without-record',
    name: 'braid-interactive-run-materialized-without-record',
    metadata: { owner: 'braid', lifecycle: 'retained', surface: 'interactive-agent' },
    deleted: false,
    async delete() {
      this.deleted = true
    },
  }
  const result = await finalizeInteractiveProof({
    client: {
      async list() {
        listCalls += 1
        return resource.deleted ? [] : [resource]
      },
      async get(id) {
        getCalls += 1
        return id === resource.id && !resource.deleted ? resource : null
      },
    },
    executionStarted: true,
    recordPath: '/does/not/exist/without-a-persisted-run.json',
    materialization,
  })
  assert.equal(resource.deleted, true)
  assert.equal(listCalls, 2)
  assert.equal(getCalls, 2)
  assert.deepEqual(result.providerMaterialization, {
    confirmed: true,
    mode: 'run-derived-owned-resource-set',
    phase: null,
    runId: 'run-materialized-without-record',
    expectedName: 'braid-interactive-run-materialized-without-record',
    matchedCount: 1,
    observedIds: ['sandbox-materialized-without-record'],
    removedIds: ['sandbox-materialized-without-record'],
    deletions: [
      {
        id: 'sandbox-materialized-without-record',
        observed: true,
        resolved: true,
        deleted: true,
        confirmed: true,
      },
    ],
    remainingIds: [],
  })
})

test('LIVE-08 confirms absence when the observed resource races away before deletion', async () => {
  let listCalls = 0
  const resource = {
    id: 'sandbox-pre-environment',
    name: 'braid-interactive-run-pre-environment',
    metadata: { owner: 'braid', lifecycle: 'retained', surface: 'interactive-agent' },
  }
  const result = await finalizeInteractiveProof({
    client: {
      async list() {
        listCalls += 1
        return listCalls === 1 ? [resource] : []
      },
      async get() {
        return null
      },
    },
    executionStarted: true,
    materialization: {
      runId: 'run-pre-environment',
      phase: null,
      materialized: false,
      boundary: 'unknown',
    },
  })
  assert.deepEqual(result.providerMaterialization, {
    confirmed: true,
    mode: 'run-derived-owned-resource-set',
    phase: null,
    runId: 'run-pre-environment',
    expectedName: 'braid-interactive-run-pre-environment',
    matchedCount: 1,
    observedIds: ['sandbox-pre-environment'],
    removedIds: [],
    deletions: [
      {
        id: 'sandbox-pre-environment',
        observed: true,
        resolved: true,
        deleted: false,
        confirmed: true,
      },
    ],
    remainingIds: [],
  })
})

test('LIVE-08 refuses cleanup when more than one exact pre-environment resource matches', async () => {
  let deleteCalls = 0
  const resources = ['sandbox-pre-environment-a', 'sandbox-pre-environment-b'].map((id) => ({
    id,
    name: 'braid-interactive-run-pre-environment',
    metadata: { owner: 'braid', lifecycle: 'retained', surface: 'interactive-agent' },
    async delete() {
      deleteCalls += 1
    },
  }))
  await assert.rejects(
    () =>
      finalizeInteractiveProof({
        client: {
          async list() {
            return resources
          },
        },
        executionStarted: true,
        recordPath: '/does/not/exist/without-an-exact-run-identity.json',
        materialization: {
          runId: 'run-pre-environment',
          phase: null,
          materialized: false,
          boundary: 'unknown',
        },
      }),
    (error) => {
      const messages = interactiveFailureMessages(error)
      assert.ok(messages.some((message) => /identity recovery/u.test(message)))
      assert.ok(
        messages.some((message) => /same-name Sandbox resources; cleanup refused/u.test(message)),
      )
      return true
    },
  )
  assert.equal(deleteCalls, 0)
})

test('LIVE-08 refuses a same-name resource with non-Braid ownership', async () => {
  let getCalls = 0
  let deleteCalls = 0
  const resource = {
    id: 'sandbox-pre-environment-collision',
    name: 'braid-interactive-run-pre-environment',
    metadata: { owner: 'other', lifecycle: 'retained', surface: 'interactive-agent' },
    async delete() {
      deleteCalls += 1
    },
  }
  await assert.rejects(
    () =>
      finalizeInteractiveProof({
        client: {
          async list() {
            return [resource]
          },
          async get() {
            getCalls += 1
            return resource
          },
        },
        executionStarted: true,
        materialization: {
          runId: 'run-pre-environment',
          phase: null,
          materialized: false,
          boundary: 'unknown',
        },
      }),
    (error) => {
      assert.ok(
        interactiveFailureMessages(error).some((message) =>
          /failed exact ownership validation/u.test(message),
        ),
      )
      return true
    },
  )
  assert.equal(getCalls, 0)
  assert.equal(deleteCalls, 0)
})

test('LIVE-08 leaves a resource untouched when its ownership changes before deletion', async () => {
  let deleteCalls = 0
  const listed = {
    id: 'sandbox-pre-environment',
    name: 'braid-interactive-run-pre-environment',
    metadata: { owner: 'braid', lifecycle: 'retained', surface: 'interactive-agent' },
  }
  const changed = {
    ...listed,
    metadata: { owner: 'other', lifecycle: 'retained', surface: 'interactive-agent' },
    async delete() {
      deleteCalls += 1
    },
  }
  await assert.rejects(
    () =>
      finalizeInteractiveProof({
        client: {
          async list() {
            return [listed]
          },
          async get() {
            return changed
          },
        },
        executionStarted: true,
        materialization: {
          runId: 'run-pre-environment',
          phase: null,
          materialized: false,
          boundary: 'unknown',
        },
      }),
    (error) => {
      assert.ok(
        interactiveFailureMessages(error).some((message) =>
          /failed exact ownership validation/u.test(message),
        ),
      )
      return true
    },
  )
  assert.equal(deleteCalls, 0)
})

test('LIVE-08 refuses cloud cleanup when a run existed without exact identity', async () => {
  await assert.rejects(
    () => finalizeInteractiveProof({ executionStarted: true }),
    (error) => {
      assert.ok(
        interactiveFailureMessages(error).some((message) =>
          /run identity was unavailable/u.test(message),
        ),
      )
      return true
    },
  )
})
