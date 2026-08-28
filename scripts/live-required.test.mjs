import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { connectionConfiguration } from './live-required/configuration.mjs'
import {
  assertProofReceipt,
  classifyExternalFailure,
  normalizeExternalFailure,
  PROOF_OPERATIONS,
  PUBLIC_EVIDENCE_SCHEMA,
  proofReceipt,
  protectedUnavailable,
  releaseOutcome,
  resultSummary,
  safeJson,
  safeMessage,
} from './live-required/contracts.mjs'
import {
  closeSession,
  configEvidence,
  initializedSession,
  prepareProductionWorkspace,
  runHeadlessTurn,
} from './live-required/headless.mjs'
import { createSupervisorProofFixture, runSupervisorFlow } from './live-required/supervisor.mjs'
import { runMatrixAdapter, runSandbox } from './live-required/tangle.mjs'
import { executionLatencyDistribution } from './live-required/tangle-sandbox-braid-execution-soak.mjs'
import {
  errorDetails,
  MissingIntegrationError,
} from './live-required/tangle-sandbox-braid-stress-support.mjs'
import {
  assertExactResumeEvidence,
  cancellationReplayDetected,
  cleanupProof,
  duplicateTurnDetected,
  PROOF_OWNER,
  runStressProof,
} from './live-required/tangle-sandbox-stress.mjs'
import { runWorker } from './live-required/tangle-sandbox-worker.mjs'
import './live-required/tangle-sandbox-braid-multirun.test.mjs'
import { MULTIRUN_REQUIRED_PHASES } from './live-required/multirun-contract.mjs'
import { readLiveTangleProof } from './release/live-tangle-proof.mjs'

const repository = resolve(new URL('../', import.meta.url).pathname)

test('cloud execution stress reports exact small-sample latency distributions', () => {
  assert.deepEqual(
    executionLatencyDistribution([{ elapsedMs: 30 }, { elapsedMs: 10 }, { elapsedMs: 20 }]),
    { n: 3, min: 10, median: 20, p90: 30, max: 30 },
  )
  assert.deepEqual(executionLatencyDistribution([]), {
    n: 0,
    min: null,
    median: null,
    p90: null,
    max: null,
  })
})

test('config evidence accepts connections without optional provider options', () => {
  assert.deepEqual(
    configEvidence({
      endpoint: { scheme: 'https', host: 'sandbox.tangle.tools' },
      connection: { id: 'connection-test', kind: 'tangle-sandbox' },
      credentialConfigured: true,
      profile: { model: { default: 'glm-5.2' }, harness: 'opencode' },
    }),
    {
      endpoint: { scheme: 'https', host: 'sandbox.tangle.tools' },
      connectionId: 'connection-test',
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      runner: 'opencode',
    },
  )
})

function protectedEnvironment() {
  const environment = { ...process.env }
  for (const name of [
    'BRAID_ANALYSIS_ENDPOINT',
    'BRAID_ANALYSIS_MODEL',
    'BRAID_ANALYSIS_RUNNER',
    'BRAID_ANALYSIS_CREDENTIAL_REF',
    'BRAID_ANALYSIS_AUTH',
    'BRAID_ANALYSIS_API_KEY',
    'BRAID_ANALYSIS_BEARER',
    'BRAID_TANGLE_ENDPOINT',
    'BRAID_TANGLE_MODEL',
    'BRAID_TANGLE_RUNNER',
    'BRAID_TANGLE_CREDENTIAL_REF',
    'BRAID_TANGLE_AUTH',
    'BRAID_TANGLE_API_KEY',
    'BRAID_TANGLE_BEARER',
    'BRAID_TANGLE_SANDBOX_ENDPOINT',
    'BRAID_TANGLE_SANDBOX_MODEL',
    'BRAID_TANGLE_SANDBOX_RUNNER',
    'BRAID_TANGLE_SANDBOX_CREDENTIAL_REF',
    'BRAID_TANGLE_SANDBOX_AUTH',
    'BRAID_TANGLE_SANDBOX_API_KEY',
    'BRAID_TANGLE_SANDBOX_BEARER',
    'BRAID_TANGLE_LIVE_ADAPTER',
    'BRAID_SUPERVISOR_ROOT',
    'BRAID_SUPERVISOR_ID',
    'BRAID_SUPERVISOR_WORKER',
    'BRAID_SUPERVISOR_WORKSPACE',
    'BRAID_SUPERVISOR_CREDENTIAL_REF',
    'BRAID_SUPERVISOR_LIVE_ADAPTER',
  ])
    delete environment[name]
  return environment
}

const TANGLE_SANDBOX_CHECKS = [
  'marker',
  'environment-id',
  'workspace-read-write-exec-git',
  'sigkill-reconnect',
  'exclusive-replay',
  'follow-up-session',
  'cancel-retry-conflict',
  'exact-resource-cleanup',
]

function validMultirunProof() {
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
    replay: {
      restartedRunCount: 2,
      noDuplicateEventIds: true,
      eventSetsStable: true,
    },
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

function passingTangleProcess() {
  const measurements = Array.from({ length: 5 }, (_, index) => ({
    kind: 'scalar',
    name: `LIVE-${String(index + 6).padStart(2, '0')}`,
    unit: 'verified-flow',
    value: 1,
  }))
  const structuredStdout = Buffer.from(
    `BRAID_RELEASE_RESULT_JSON={"status":"passed"}\nBRAID_RELEASE_MEASUREMENTS_JSON=${JSON.stringify({ measurements })}\n`,
  )
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnError: null,
    cleanupConfirmed: true,
    durationMs: 1,
    stdout: { redactionFailClosed: false, bytes: structuredStdout },
    stderr: { redactionFailClosed: false, bytes: Buffer.alloc(0) },
    structuredStdout: { bytes: structuredStdout, error: null },
  }
}

test('LIVE-07 release artifact validation requires complete multirun evidence and exact cleanup', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'braid-live-tangle-proof-'))
  const artifactPath = join(artifactRoot, 'live', 'tangle', 'evidence.json')
  try {
    await mkdir(join(artifactRoot, 'live', 'tangle'), { recursive: true })
    await writeFile(artifactPath, `${JSON.stringify(validMultirunProof())}\n`)
    const passed = await readLiveTangleProof({
      artifactRoot,
      checkId: 'live-tangle',
      processResult: passingTangleProcess(),
    })
    assert.equal(passed.result, 'passed')

    await rm(artifactPath)
    const missing = await readLiveTangleProof({
      artifactRoot,
      checkId: 'live-tangle',
      processResult: passingTangleProcess(),
    })
    assert.equal(missing.result, 'uncaptured')
    assert.match(missing.reason, /artifact is missing/u)

    for (const proof of [
      { ...validMultirunProof(), status: 'failed' },
      {
        ...validMultirunProof(),
        cleanup: { ...validMultirunProof().cleanup, exact: false },
      },
      {
        ...validMultirunProof(),
        cancellation: { ...validMultirunProof().cancellation, dispatch: null },
      },
    ]) {
      await writeFile(artifactPath, `${JSON.stringify(proof)}\n`)
      const invalid = await readLiveTangleProof({
        artifactRoot,
        checkId: 'live-tangle',
        processResult: passingTangleProcess(),
      })
      assert.equal(invalid.result, 'uncaptured')
    }
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

function validTangleSandboxReceiptInput(overrides = {}) {
  const cloudControl = {
    provider: 'tangle-sandbox',
    environmentId: 'sandbox-environment-1',
    sessionId: 'sandbox-session-1',
    executionId: 'sandbox-execution-1',
    runId: 'sandbox-run-1',
    requestDigest: `sha256:${'a'.repeat(64)}`,
  }
  return {
    invocationId: 'live-required-tangle-sandbox-proof',
    operation: PROOF_OPERATIONS.tangleSandbox,
    status: 'passed',
    startedAt: '2026-08-10T00:00:00.000Z',
    completedAt: '2026-08-10T00:00:01.000Z',
    config: {
      endpoint: 'https://sandbox.tangle.tools',
      connectionId: 'connection-live-07',
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      runner: 'pi',
    },
    runIds: ['local-run-1', 'local-run-follow-up', 'local-run-cancelled'],
    environmentId: 'local-environment-1',
    facts: {
      environmentId: 'local-environment-1',
      resumedRunId: 'local-run-1',
      followUpRunId: 'local-run-follow-up',
      cancelledRunId: 'local-run-cancelled',
      resumeFromCursor: 'provider-cursor-before-kill',
      finalCursor: 'provider-cursor-final',
      cloudControl,
      exactResource: true,
      activeResourceDelta: 0,
    },
    observations: {
      phase: 'completed',
      cloudControl,
      usage: { inputTokens: 12, outputTokens: 8, costUsd: 0.001 },
      multirun: validMultirunProof(),
    },
    checks: TANGLE_SANDBOX_CHECKS,
    ...overrides,
  }
}

test('protected live scopes emit unavailable release evidence without credentials', () => {
  for (const scope of ['live-tangle', 'live-supervisor', 'live-analysis', 'semantic-eval']) {
    assert.throws(
      () =>
        execFileSync(process.execPath, ['scripts/live-required.mjs', scope], {
          cwd: repository,
          env: protectedEnvironment(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (error) => {
        assert.equal(error.status, 2)
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
        assert.match(
          output,
          /requires protected live-provider credentials\/adapters|live check requires/u,
        )
        assert.match(output, /BRAID_RELEASE_RESULT_JSON=\{"status":"unavailable"/u)
        if (scope === 'live-tangle') {
          assert.match(output, /"row":"LIVE-07","status":"unavailable"/u)
          assert.doesNotMatch(output, /"row":"LIVE-07","status":"partial"/u)
          for (const row of ['LIVE-08', 'LIVE-09', 'LIVE-10'])
            assert.match(output, new RegExp(`"row":"${row}","status":"unavailable"`, 'u'))
        }
        assert.doesNotMatch(output, /\b(?:passed|success)\b/iu)
        return true
      },
    )
  }
})

test('only explicit protected configuration failures remain unavailable', () => {
  const unavailable = normalizeExternalFailure(
    protectedUnavailable('PROTECTED_CREDENTIAL_REQUIRED', 'credential is missing'),
    'live-analysis',
  )
  assert.equal(unavailable.unavailable, true)
  assert.equal(unavailable.code, 'PROTECTED_CREDENTIAL_REQUIRED')

  const configuredFailure = normalizeExternalFailure(
    new Error('configured provider timed out after the request was sent'),
    'live-analysis',
  )
  assert.equal(configuredFailure.unavailable, false)
  assert.equal(configuredFailure.code, 'LIVE_REAL_PATH_FAILED')
  assert.match(configuredFailure.message, /failed against the configured live path/u)
  assert.throws(
    () => classifyExternalFailure(new Error('configured assertion failed'), 'live-analysis'),
    (error) => {
      assert.equal(error.unavailable, false)
      assert.equal(error.code, 'LIVE_REAL_PATH_FAILED')
      return true
    },
  )
})

test('partial Tangle measurements remain unavailable instead of passing', () => {
  const partial = releaseOutcome('live-tangle', {
    status: 'partial',
    measurements: [{ name: 'LIVE-06' }],
  })
  assert.equal(partial.status, 'unavailable')
  assert.equal(partial.exitCode, 2)

  const incompletePass = releaseOutcome('live-tangle', {
    status: 'passed',
    measurements: [{ name: 'LIVE-06' }],
  })
  assert.equal(incompletePass.status, 'unavailable')
  assert.equal(incompletePass.exitCode, 2)
})

test('configured Tangle adapters cannot provide release proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-required-adapter-test-'))
  const missing = join(root, 'missing-adapter.mjs')
  const wrongShape = join(root, 'wrong-shape-adapter.mjs')
  await writeFile(wrongShape, 'export default 42\n')
  const base = {
    repository,
    binary: join(repository, 'dist', 'bin', 'braid.js'),
    environment: {
      ...protectedEnvironment(),
      BRAID_TANGLE_ENDPOINT: 'https://router.tangle.tools',
      BRAID_TANGLE_CREDENTIAL_REF: 'credential-ref-live-required-test',
    },
  }
  try {
    for (const adapter of [missing, wrongShape]) {
      const result = await runMatrixAdapter({
        ...base,
        environment: { ...base.environment, BRAID_TANGLE_LIVE_ADAPTER: adapter },
      })
      assert.equal(result.status, 'unavailable')
      assert.match(result.reason, /External Tangle matrix adapters are not accepted/u)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('valid-looking external adapters are not executed and cannot pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-required-proof-boundary-test-'))
  const secret = 'live-required-adapter-secret-canary-3f9d'
  const adapter = join(root, 'fake-adapter.mjs')
  const tangleProbe = join(root, 'tangle-probe.mjs')
  await writeFile(
    adapter,
    `process.stdout.write(process.env.BRAID_TANGLE_API_KEY)\nexport default async () => ({ status: 'passed', checks: { 'LIVE-07': { passed: true, evidence: 'fake' }, 'LIVE-08': { passed: true, evidence: 'fake' }, 'LIVE-09': { passed: true, evidence: 'fake' }, 'LIVE-10': { passed: true, evidence: 'fake' } }, evidence: { apiKey: process.env.BRAID_TANGLE_API_KEY } })\n`,
  )
  await writeFile(
    tangleProbe,
    `import { runMatrixAdapter } from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/live-required/tangle.mjs')).href)}\nconst result = await runMatrixAdapter({ environment: process.env })\nprocess.stdout.write(JSON.stringify(result))\n`,
  )
  try {
    const output = execFileSync(process.execPath, [tangleProbe], {
      cwd: repository,
      env: {
        ...protectedEnvironment(),
        BRAID_TANGLE_ENDPOINT: 'https://router.tangle.tools',
        BRAID_TANGLE_CREDENTIAL_REF: 'credential-ref-live-required-test',
        BRAID_TANGLE_API_KEY: secret,
        BRAID_TANGLE_LIVE_ADAPTER: adapter,
      },
      encoding: 'utf8',
    })
    assert.doesNotMatch(output, new RegExp(secret, 'u'))
    assert.equal(JSON.parse(output).status, 'unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('receipts use a fixed schema and bind to one operation and invocation', () => {
  const invocationId = 'live-required-test-invocation'
  const receipt = proofReceipt({
    invocationId,
    operation: PROOF_OPERATIONS.tangleSandbox,
    status: 'partial',
    startedAt: '2026-08-10T00:00:00.000Z',
    completedAt: '2026-08-10T00:00:01.000Z',
    config: {
      endpoint: 'https://router.tangle.tools',
      connectionId: 'connection-live-test',
      connectionKind: 'tangle-sandbox',
      credentialConfigured: true,
      model: 'glm-5.2',
      runner: 'pi',
    },
    runIds: ['run-live-test'],
    environmentId: 'environment-live-test',
    facts: {
      environmentId: 'environment-live-test',
      resumedRunId: null,
      followUpRunId: null,
      cancelledRunId: null,
      resumeFromCursor: null,
      finalCursor: null,
      cloudControl: null,
      exactResource: null,
      activeResourceDelta: null,
    },
    observations: null,
    checks: ['marker', 'environment-id'],
  })
  assert.equal(receipt.schema, PUBLIC_EVIDENCE_SCHEMA)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'checks',
    'completedAt',
    'connection',
    'facts',
    'invocationId',
    'observations',
    'operation',
    'run',
    'schema',
    'startedAt',
    'status',
  ])
  assert.equal(assertProofReceipt(receipt, { invocationId, operation: receipt.operation }), receipt)
  assert.throws(
    () =>
      assertProofReceipt(
        { ...receipt, facts: { ...receipt.facts, arbitrary: 'not accepted' } },
        { invocationId, operation: receipt.operation },
      ),
    /outside the public schema/u,
  )
  assert.throws(
    () =>
      assertProofReceipt({ ...receipt, invocationId: 'different-invocation' }, { invocationId }),
    /different invocation/u,
  )
  assert.throws(() => assertProofReceipt('plain evidence string'), /must be an object/u)
  assert.equal(
    'evidence' in resultSummary('live-tangle', { status: 'partial', evidence: 'fake' }),
    false,
  )
})

test('passed Tangle Sandbox receipts preserve redacted observations and exact release proof', () => {
  const secret = 'live-required-tangle-sandbox-observation-secret-7f3a'
  const input = validTangleSandboxReceiptInput()
  input.observations = {
    ...input.observations,
    apiKey: secret,
    nested: { authorization: `Bearer ${secret}`, retained: true },
  }
  const receipt = proofReceipt({
    ...input,
    environment: { BRAID_TANGLE_SANDBOX_API_KEY: secret },
  })

  assert.equal(receipt.status, 'passed')
  assert.deepEqual(receipt.facts.cloudControl, input.facts.cloudControl)
  assert.equal(receipt.facts.activeResourceDelta, 0)
  assert.equal(receipt.facts.exactResource, true)
  assert.equal(receipt.observations.phase, 'completed')
  assert.equal(receipt.observations.apiKey, '[REDACTED]')
  assert.equal(receipt.observations.nested.authorization, '[REDACTED]')
  assert.deepEqual(
    resultSummary('live-tangle', { status: 'passed', evidence: receipt }).evidence.observations,
    receipt.observations,
  )
})

test('LIVE-07 wiring carries cloud identity, cleanup proof, and observations into evidence', async () => {
  const input = validTangleSandboxReceiptInput()
  const firstRun = { id: input.runIds[0], environmentId: input.environmentId }
  const proof = {
    status: 'passed',
    config: input.config,
    runs: {
      first: firstRun,
      resumed: firstRun,
      followUp: { id: input.facts.followUpRunId, environmentId: input.environmentId },
      cancelled: { id: input.facts.cancelledRunId, environmentId: input.environmentId },
    },
    replay: {
      resumeFromCursor: input.facts.resumeFromCursor,
      finalCursor: input.facts.finalCursor,
    },
    cleanup: {
      exactResource: input.facts.exactResource,
      activeResourceDelta: input.facts.activeResourceDelta,
    },
    progress: { firstControlRef: input.facts.cloudControl },
    detailed: true,
  }
  const cohort = {
    status: 'passed',
    failures: [],
    requestedRuns: 3,
    attemptedRuns: 3,
    concurrency: 2,
    cleanup: { exactProofs: 3, exactResourcesRemaining: 0, activeResourceDelta: 0 },
    attempts: Array.from({ length: 3 }, (_, index) => ({
      index,
      proof: {
        ...proof,
        proofId: `proof-${index}`,
        progress: {
          firstControlRef: {
            ...proof.progress.firstControlRef,
            environmentId:
              index === 0
                ? proof.progress.firstControlRef.environmentId
                : `cloud-environment-${index}`,
          },
        },
      },
    })),
    detailed: true,
  }
  const result = await runSandbox({
    repository,
    environment: {},
    binary: 'unused-injected-binary',
    invocationId: input.invocationId,
    stressRunner: async () => cohort,
    multirunRunner: async () => validMultirunProof(),
  })

  assert.equal(result.evidence.status, 'passed')
  assert.deepEqual(result.evidence.facts.cloudControl, input.facts.cloudControl)
  assert.equal(result.evidence.facts.exactResource, true)
  assert.equal(result.evidence.facts.activeResourceDelta, 0)
  assert.equal(result.evidence.observations.stress.detailed, true)
})

test('passed Tangle Sandbox receipts reject null or forged acceptance facts', () => {
  const valid = proofReceipt(validTangleSandboxReceiptInput())
  const cases = [
    [
      'empty local run IDs',
      { ...valid, run: { ...valid.run, ids: [] } },
      /at least one local run ID/u,
    ],
    [
      'null cloud identity',
      { ...valid, facts: { ...valid.facts, cloudControl: null } },
      /exact cloud control identity/u,
    ],
    [
      'wrong cloud provider',
      {
        ...valid,
        facts: {
          ...valid.facts,
          cloudControl: { ...valid.facts.cloudControl, provider: 'other-provider' },
        },
      },
      /wrong provider/u,
    ],
    [
      'missing acknowledged cursor',
      { ...valid, facts: { ...valid.facts, resumeFromCursor: null } },
      /facts\.resumeFromCursor/u,
    ],
    [
      'missing model configuration',
      { ...valid, connection: { ...valid.connection, model: null } },
      /connection\.model/u,
    ],
    [
      'unconfirmed exact cleanup',
      { ...valid, facts: { ...valid.facts, exactResource: false } },
      /exactResource=true/u,
    ],
    [
      'non-zero resource delta',
      { ...valid, facts: { ...valid.facts, activeResourceDelta: 1 } },
      /activeResourceDelta=0/u,
    ],
    ['missing observations', { ...valid, observations: null }, /redacted observations/u],
    [
      'unredacted observation credential',
      { ...valid, observations: { apiKey: 'raw-secret' } },
      /observations\.apiKey must be redacted/u,
    ],
  ]

  for (const [label, forged, expected] of cases)
    assert.throws(() => assertProofReceipt(forged), expected, label)
  assert.throws(() => assertProofReceipt(null), /must be an object/u)
})

test('failed Tangle Sandbox receipts remain representable without passed-only facts', () => {
  const receipt = proofReceipt({
    ...validTangleSandboxReceiptInput(),
    status: 'failed',
    runIds: [],
    environmentId: null,
    facts: {
      environmentId: null,
      resumedRunId: null,
      followUpRunId: null,
      cancelledRunId: null,
      resumeFromCursor: null,
      finalCursor: null,
      cloudControl: null,
      exactResource: null,
      activeResourceDelta: null,
    },
    observations: null,
    checks: ['marker'],
  })

  assert.equal(receipt.status, 'failed')
  assert.deepEqual(receipt.run.ids, [])
  assert.equal(receipt.facts.cloudControl, null)
  assert.equal(receipt.observations, null)
})

test('passed trace-analysis receipts require complete checks and model-call evidence', () => {
  const receipt = proofReceipt({
    invocationId: 'live-required-trace-proof',
    operation: PROOF_OPERATIONS.traceAnalysis,
    startedAt: '2026-08-10T00:00:00.000Z',
    completedAt: '2026-08-10T00:00:01.000Z',
    facts: {
      analysisId: 'analysis-live-test',
      findingCount: 1,
      modelCallCount: 2,
      promoted: true,
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        tokensKnown: true,
        costKind: 'estimated',
        costUsd: 0.001,
        usdKnown: false,
      },
    },
    checks: ['source-frozen', 'cited-finding', 'restart-restored', 'promoted'],
  })

  assert.throws(() => assertProofReceipt({ ...receipt, checks: ['source-frozen'] }), /every check/u)
  assert.throws(
    () =>
      assertProofReceipt({
        ...receipt,
        facts: { ...receipt.facts, modelCallCount: null },
      }),
    /model-call record/u,
  )
})

test('nested credential fields and error text are redacted before public output', () => {
  const secret = 'live-required-nested-secret-canary-6b7e'
  const environment = {
    ...protectedEnvironment(),
    BRAID_TANGLE_API_KEY: secret,
  }
  const output = safeJson(
    {
      nested: {
        apiKey: secret,
        provider: { authorization: `Bearer ${secret}` },
        array: [{ clientSecret: secret }],
        message: `provider rejected ${secret}`,
      },
    },
    environment,
  )
  assert.doesNotMatch(output, new RegExp(secret, 'u'))
  assert.match(output, /\[REDACTED\]/u)
  const message = safeMessage(
    Object.assign(new Error(`adapter failed ${secret}`), { cause: { token: secret } }),
    environment,
  )
  assert.doesNotMatch(message, new RegExp(secret, 'u'))
  assert.match(message, /\[REDACTED\]/u)
  const nestedSecret = 'live-required-unbound-nested-secret-canary-8a11'
  const nestedMessage = safeMessage(
    Object.assign(new Error(`nested adapter failure ${nestedSecret}`), {
      cause: { credential: { value: nestedSecret } },
    }),
    protectedEnvironment(),
  )
  assert.doesNotMatch(nestedMessage, new RegExp(nestedSecret, 'u'))
  assert.match(nestedMessage, /\[REDACTED\]/u)
})

test('retained Sandbox error details are safe for direct proof output', () => {
  const secret = 'retained-sandbox-error-secret-canary-4f8c'
  const networkError = Object.assign(new Error(`transport failed ${secret}`), {
    name: 'NetworkError',
    code: 'NETWORK_ERROR',
    status: 503,
  })
  const rawDetails = errorDetails(
    Object.assign(
      new MissingIntegrationError('provider rejected the request', {
        authorization: secret,
        nested: { token: secret },
      }),
      {
        cause: Object.assign(new Error(`runtime failed ${secret}`), {
          code: 'RETAINED_RESULT_READ_FAILED',
          cause: networkError,
        }),
      },
    ),
  )
  const output = safeJson({ status: 'failed', failure: rawDetails }, { TANGLE_API_KEY: secret })
  assert.doesNotMatch(output, new RegExp(secret, 'u'))
  assert.match(output, /\[REDACTED\]/u)
  assert.deepEqual(rawDetails.fingerprint, {
    name: 'MissingIntegrationError',
    code: 'BRAID_LIVE_INTEGRATION_MISSING',
    cause: {
      name: 'Error',
      code: 'RETAINED_RESULT_READ_FAILED',
      cause: { name: 'NetworkError', code: 'NETWORK_ERROR', status: 503 },
    },
  })
})

test('supervisor proof proves public observation, effects, replay, and reconnect', async () => {
  const fixture = createSupervisorProofFixture({ terminalTakeover: 'attached' })
  const environment = {
    BRAID_SUPERVISOR_ROOT: fixture.rootDir,
    BRAID_SUPERVISOR_ID: fixture.supervisorId,
    BRAID_SUPERVISOR_WORKER: fixture.workerId,
    BRAID_SUPERVISOR_STEER_OPERATION_ID: 'supervisor-steer-test-1',
    BRAID_SUPERVISOR_CANCEL_OPERATION_ID: 'supervisor-cancel-test-1',
    BRAID_SUPERVISOR_MESSAGE: 'inspect the deterministic worker',
    BRAID_SUPERVISOR_TIMEOUT_MS: '1000',
    BRAID_SUPERVISOR_POLL_MS: '1',
  }
  const result = await runSupervisorFlow({
    environment,
    invocationId: 'live-required-supervisor-test',
    runtime: fixture.api,
    providers: {},
  })
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.measurements, [
    { kind: 'scalar', name: 'LIVE-11', unit: 'verified-flow', value: 1 },
  ])
  assert.equal(result.steering.effect, 'delivered')
  assert.equal(result.steering.replayed, true)
  assert.equal(result.cancellation.effect, 'cancelled')
  assert.equal(result.terminalTakeover.status, 'attached')
  assert.equal(result.proof.facts.spendObserved, true)
  assert.equal(result.proof.facts.statusObserved, true)
  assert.equal(result.proof.facts.reconnectable, true)
  assert.equal(result.proof.facts.cancellationAvailable, true)
  assert.equal(assertProofReceipt(result.proof), result.proof)
  assert.throws(
    () =>
      assertProofReceipt({
        ...result.proof,
        facts: { ...result.proof.facts, cancellationEffect: 'not_live' },
      }),
    /cancelled worker effect/u,
  )
  assert.throws(
    () =>
      assertProofReceipt({
        ...result.proof,
        status: 'partial',
        checks: ['snapshot'],
      }),
    /cannot have a partial status/u,
  )
  assert.equal(fixture.calls.filter((call) => call.name === 'writeWorkerSteer').length, 2)
  assert.equal(fixture.calls.filter((call) => call.name === 'cancelWorker').length, 2)
  assert.equal(
    fixture.calls.some((call) => call.name === 'supervisorRunDir'),
    true,
  )
  assert.equal(
    fixture.calls.some((call) => call.name === 'readWorkerCancellation'),
    true,
  )
})

test('supervisor proof fails closed when a required runtime effect is absent or unclean', async () => {
  const cases = [
    [
      'missing steering acknowledgement',
      { steerAcknowledgement: false },
      /worker steer acknowledgement was not acknowledged/u,
    ],
    ['refused steering effect', { steerEffect: 'refused' }, /did not report delivered effect/u],
    [
      'missing cancellation acknowledgement',
      { cancellationAcknowledgement: false },
      /worker cancellation acknowledgement was not acknowledged/u,
    ],
    [
      'unclean cancellation effect',
      { cancellationEffect: 'not_live' },
      /did not report a proven effect/u,
    ],
  ]
  for (const [label, options, expected] of cases) {
    const fixture = createSupervisorProofFixture(options)
    await assert.rejects(
      () =>
        runSupervisorFlow({
          environment: {
            BRAID_SUPERVISOR_ROOT: fixture.rootDir,
            BRAID_SUPERVISOR_ID: fixture.supervisorId,
            BRAID_SUPERVISOR_WORKER: fixture.workerId,
            BRAID_SUPERVISOR_TIMEOUT_MS: '5',
            BRAID_SUPERVISOR_POLL_MS: '1',
          },
          invocationId: `live-required-supervisor-${label.replaceAll(' ', '-')}`,
          runtime: fixture.api,
        }),
      expected,
      label,
    )
  }
})

test('supervisor proof rejects incomplete public snapshots before control', async () => {
  const fixture = createSupervisorProofFixture({ snapshotCompleteness: 'partial' })
  await assert.rejects(
    () =>
      runSupervisorFlow({
        environment: {
          BRAID_SUPERVISOR_ROOT: fixture.rootDir,
          BRAID_SUPERVISOR_ID: fixture.supervisorId,
          BRAID_SUPERVISOR_WORKER: fixture.workerId,
          BRAID_SUPERVISOR_TIMEOUT_MS: '5',
          BRAID_SUPERVISOR_POLL_MS: '1',
        },
        runtime: fixture.api,
      }),
    /runtime supervisor snapshot is incomplete/u,
  )
  assert.equal(
    fixture.calls.some((call) => call.name === 'writeWorkerSteer'),
    false,
  )
  assert.equal(
    fixture.calls.some((call) => call.name === 'cancelWorker'),
    false,
  )
})

test('supervisor proof fails unavailable when a required Runtime API is missing', async () => {
  const fixture = createSupervisorProofFixture()
  const runtime = { ...fixture.api }
  delete runtime.cancelWorker
  await assert.rejects(
    () =>
      runSupervisorFlow({
        environment: {
          BRAID_SUPERVISOR_ROOT: fixture.rootDir,
          BRAID_SUPERVISOR_ID: fixture.supervisorId,
          BRAID_SUPERVISOR_WORKER: fixture.workerId,
        },
        runtime,
      }),
    (error) => {
      assert.equal(error.unavailable, true)
      assert.equal(error.code, 'RUNTIME_SUPERVISOR_API_REQUIRED')
      return true
    },
  )
})

test('supervisor proof records unsupported terminal takeover without claiming attachment', async () => {
  const fixture = createSupervisorProofFixture()
  const result = await runSupervisorFlow({
    environment: {
      BRAID_SUPERVISOR_ROOT: fixture.rootDir,
      BRAID_SUPERVISOR_ID: fixture.supervisorId,
      BRAID_SUPERVISOR_WORKER: fixture.workerId,
      BRAID_SUPERVISOR_TIMEOUT_MS: '1000',
      BRAID_SUPERVISOR_POLL_MS: '1',
    },
    runtime: fixture.api,
  })
  assert.equal(result.status, 'passed')
  assert.deepEqual(result.terminalTakeover, {
    status: 'unavailable',
    reason: 'No environment provider source was supplied for exact terminal takeover',
  })
  assert.equal(result.proof.facts.terminalTakeover, 'unavailable')
})

test('supervisor proof provisions an owned Runtime run and validates cleanup', async () => {
  const fixture = createSupervisorProofFixture({ terminalTakeover: 'attached' })
  const environment = {
    ...protectedEnvironment(),
    BRAID_SUPERVISOR_ENDPOINT: 'https://router.example/v1',
    BRAID_SUPERVISOR_CREDENTIAL_REF: 'cred:v1:supervisor-proof',
    BRAID_SUPERVISOR_WORKSPACE: '/tmp/supervisor-proof-workspace',
    BRAID_SUPERVISOR_API_KEY: 'must-not-cross-the-provision-boundary',
    BRAID_SUPERVISOR_AUTH: 'must-not-cross-the-provision-boundary',
    BRAID_SUPERVISOR_TIMEOUT_MS: '1000',
    BRAID_SUPERVISOR_POLL_MS: '1',
    BRAID_SUPERVISOR_MESSAGE: 'inspect the provisioned worker',
  }
  let provisionRequest
  let cleanupCalls = 0
  const result = await runSupervisorFlow({
    environment,
    invocationId: 'live-required-supervisor-provisioned',
    runtime: {
      ...fixture.api,
      provisionSupervisor: async (request) => {
        provisionRequest = request
        return {
          rootDir: fixture.rootDir,
          supervisorId: fixture.supervisorId,
          workerId: fixture.workerId,
          providers: {},
          terminalTakeover: 'required',
          cleanup: async () => {
            cleanupCalls += 1
            return {
              status: 'completed',
              rootDir: fixture.rootDir,
              supervisorId: fixture.supervisorId,
              workerId: fixture.workerId,
              supervisorStatus: 'cancelled',
              workerStatus: 'cancelled',
              resourcesReleased: true,
              remainingResources: [],
            }
          },
        }
      },
    },
  })
  assert.equal(result.status, 'passed')
  assert.equal(result.provisioning.mode, 'provisioned')
  assert.equal(result.provisioning.terminalTakeover, 'required')
  assert.equal(result.cleanup.status, 'completed')
  assert.equal(cleanupCalls, 1)
  assert.equal(provisionRequest.invocationId, 'live-required-supervisor-provisioned')
  assert.equal(provisionRequest.timeoutMs, 1000)
  assert.equal(provisionRequest.pollMs, 1)
  assert.deepEqual(provisionRequest.environment, {
    BRAID_SUPERVISOR_ENDPOINT: 'https://router.example/v1',
    BRAID_SUPERVISOR_CREDENTIAL_REF: 'cred:v1:supervisor-proof',
    BRAID_SUPERVISOR_WORKSPACE: '/tmp/supervisor-proof-workspace',
  })
  assert.equal(provisionRequest.profile, undefined)
  assert.equal(provisionRequest.connection, undefined)
  assert.deepEqual(result.proof.run.ids, [fixture.supervisorId, fixture.workerId])
  assert.equal(result.proof.facts.provisioned, true)
  assert.equal(result.proof.facts.cleanupVerified, true)
  assert.equal(result.proof.facts.terminalTakeoverRequired, true)
  assert.equal(assertProofReceipt(result.proof), result.proof)
})

test('supervisor proof cleans an owned Runtime run after an observation failure', async () => {
  const fixture = createSupervisorProofFixture({ snapshotCompleteness: 'partial' })
  let cleanupCalls = 0
  await assert.rejects(
    () =>
      runSupervisorFlow({
        environment: {
          ...protectedEnvironment(),
          BRAID_SUPERVISOR_TIMEOUT_MS: '5',
          BRAID_SUPERVISOR_POLL_MS: '1',
        },
        invocationId: 'live-required-supervisor-cleanup-on-failure',
        runtime: fixture.api,
        provision: async () => ({
          rootDir: fixture.rootDir,
          supervisorId: fixture.supervisorId,
          workerId: fixture.workerId,
          terminalTakeover: 'unsupported',
          cleanup: async () => {
            cleanupCalls += 1
            return {
              status: 'completed',
              rootDir: fixture.rootDir,
              supervisorId: fixture.supervisorId,
              workerId: fixture.workerId,
              supervisorStatus: 'cancelled',
              workerStatus: 'cancelled',
              resourcesReleased: true,
              remainingResources: [],
            }
          },
        }),
      }),
    /runtime supervisor snapshot is incomplete/u,
  )
  assert.equal(cleanupCalls, 1)
})

test('supervisor proof rejects a supported terminal takeover without a real attachment', async () => {
  const fixture = createSupervisorProofFixture({ terminalTakeover: 'unavailable' })
  let cleanupCalls = 0
  await assert.rejects(
    () =>
      runSupervisorFlow({
        environment: {
          ...protectedEnvironment(),
          BRAID_SUPERVISOR_TIMEOUT_MS: '1000',
          BRAID_SUPERVISOR_POLL_MS: '1',
        },
        invocationId: 'live-required-supervisor-required-attach',
        runtime: fixture.api,
        provision: async () => ({
          rootDir: fixture.rootDir,
          supervisorId: fixture.supervisorId,
          workerId: fixture.workerId,
          providers: {},
          terminalTakeover: 'required',
          cleanup: async () => {
            cleanupCalls += 1
            return {
              status: 'completed',
              rootDir: fixture.rootDir,
              supervisorId: fixture.supervisorId,
              workerId: fixture.workerId,
              supervisorStatus: 'cancelled',
              workerStatus: 'cancelled',
              resourcesReleased: true,
              remainingResources: [],
            }
          },
        }),
      }),
    /supports terminal takeover/u,
  )
  assert.equal(cleanupCalls, 1)
})

test('supervisor proof refuses an incomplete owned cleanup receipt', async () => {
  const fixture = createSupervisorProofFixture()
  let cleanupCalls = 0
  await assert.rejects(
    () =>
      runSupervisorFlow({
        environment: {
          ...protectedEnvironment(),
          BRAID_SUPERVISOR_TIMEOUT_MS: '1000',
          BRAID_SUPERVISOR_POLL_MS: '1',
        },
        invocationId: 'live-required-supervisor-incomplete-cleanup',
        runtime: fixture.api,
        provision: async () => ({
          rootDir: fixture.rootDir,
          supervisorId: fixture.supervisorId,
          workerId: fixture.workerId,
          terminalTakeover: 'unsupported',
          cleanup: async () => {
            cleanupCalls += 1
            return {
              status: 'completed',
              rootDir: fixture.rootDir,
              supervisorId: fixture.supervisorId,
              workerId: fixture.workerId,
              supervisorStatus: 'cancelled',
              workerStatus: 'cancelled',
              resourcesReleased: true,
              remainingResources: ['worker-process'],
            }
          },
        }),
      }),
    /left unconfirmed resources/u,
  )
  assert.equal(cleanupCalls, 1)
})

test('supervisor proof requires Runtime provisioning when no external run is configured', async () => {
  const fixture = createSupervisorProofFixture()
  await assert.rejects(
    () =>
      runSupervisorFlow({
        environment: {
          ...protectedEnvironment(),
          BRAID_SUPERVISOR_TIMEOUT_MS: '5',
          BRAID_SUPERVISOR_POLL_MS: '1',
        },
        runtime: fixture.api,
      }),
    (error) => {
      assert.equal(error.unavailable, true)
      assert.equal(error.code, 'RUNTIME_SUPERVISOR_PROVISION_REQUIRED')
      return true
    },
  )
})

test('supervisor proof rejects a partial external binding before provisioning', async () => {
  const fixture = createSupervisorProofFixture()
  let provisionCalls = 0
  await assert.rejects(
    () =>
      runSupervisorFlow({
        environment: {
          ...protectedEnvironment(),
          BRAID_SUPERVISOR_ROOT: fixture.rootDir,
        },
        runtime: {
          ...fixture.api,
          provisionSupervisor: async () => {
            provisionCalls += 1
            throw new Error('provisioning must not run for a partial override')
          },
        },
      }),
    (error) => {
      assert.equal(error.unavailable, true)
      assert.equal(error.code, 'PROTECTED_SUPERVISOR_CONFIGURATION_INVALID')
      return true
    },
  )
  assert.equal(provisionCalls, 0)
})

test('configured supervisor failures are failed and never reported as partial', () => {
  let failure
  try {
    execFileSync(process.execPath, ['scripts/live-required.mjs', 'live-supervisor'], {
      cwd: repository,
      env: {
        ...protectedEnvironment(),
        BRAID_SUPERVISOR_ROOT: join(tmpdir(), 'missing-braid-supervisor-root'),
        BRAID_SUPERVISOR_ID: 'configured-supervisor',
        BRAID_SUPERVISOR_WORKER: 'configured-worker',
        BRAID_SUPERVISOR_TIMEOUT_MS: '5',
        BRAID_SUPERVISOR_POLL_MS: '1',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    failure = error
  }
  assert(failure, 'configured supervisor unexpectedly passed')
  assert.equal(failure.status, 1)
  const output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`
  assert.match(output, /failed against the configured live path/u)
  assert.doesNotMatch(output, /status":"partial/u)
  assert.doesNotMatch(output, /BRAID_RELEASE_RESULT_JSON=\{"status":"unavailable"/u)
})

test('configured headless checks execute the real Braid RPC process and validate its marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-required-script-test-'))
  const wrapper = join(root, 'fixture-wrapper.mjs')
  const binary = join(repository, 'dist', 'bin', 'braid.js')
  await writeFile(
    wrapper,
    `import { spawn } from 'node:child_process'\nconst child = spawn(process.execPath, [process.env.BRAID_FIXTURE_TARGET, 'rpc', '--fixture', 'deterministic'], { stdio: 'inherit' })\nchild.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0))\n`,
    { mode: 0o700 },
  )
  await chmod(wrapper, 0o700)
  const environment = {
    ...protectedEnvironment(),
    BRAID_FIXTURE_TARGET: binary,
  }
  const config = await prepareProductionWorkspace({
    repository,
    environment,
    kind: 'cli-bridge',
    endpoint: 'http://127.0.0.1:3344',
    model: 'openai-codex/gpt-5.6-luna',
    runner: 'pi',
    provider: 'openai-codex',
  })
  try {
    const turn = await runHeadlessTurn({
      binary: wrapper,
      config,
      marker: 'Fixture response through pi: LIVE_REQUIRED_SCRIPT_OK',
      prompt: 'LIVE_REQUIRED_SCRIPT_OK',
    })
    assert.equal(turn.run.status, 'completed')
    assert.equal(turn.message.text, 'Fixture response through pi: LIVE_REQUIRED_SCRIPT_OK')
    await closeSession(turn.session)
  } finally {
    await config.cleanup()
    await rm(root, { recursive: true, force: true })
  }
})

test('production live workspaces remove every raw authentication alias from child processes', async () => {
  const secret = 'live-required-child-secret-canary-991f'
  const authenticationNames = [
    'BRAID_ANALYSIS_AUTH',
    'BRAID_ANALYSIS_API_KEY',
    'BRAID_ANALYSIS_BEARER',
    'BRAID_CLI_BRIDGE_AUTH',
    'BRAID_CLI_BRIDGE_BEARER',
    'BRAID_TANGLE_AUTH',
    'BRAID_TANGLE_API_KEY',
    'BRAID_TANGLE_BEARER',
    'BRAID_TANGLE_SANDBOX_AUTH',
    'BRAID_TANGLE_SANDBOX_API_KEY',
    'BRAID_TANGLE_SANDBOX_BEARER',
  ]
  const environment = Object.fromEntries(authenticationNames.map((name) => [name, secret]))
  const config = await prepareProductionWorkspace({
    repository,
    environment,
    kind: 'credential-scrub-test',
    endpoint: 'https://router.tangle.tools',
    model: 'openai/gpt-5',
    runner: 'pi',
    provider: 'tangle',
    credentialRef: 'credential-ref-live-required-test',
  })
  try {
    for (const name of authenticationNames) assert.equal(config.environment[name], undefined, name)
    assert.equal(Object.values(config.environment).includes(secret), false)
  } finally {
    await config.cleanup()
  }
})

test('generated live credentials use the same protected store as production Braid', async () => {
  const secret = 'live-required-protected-store-canary-6c2f'
  const config = await prepareProductionWorkspace({
    repository,
    environment: protectedEnvironment(),
    kind: 'tangle-inference',
    endpoint: 'https://router.tangle.tools',
    model: 'glm-5.2',
    runner: 'cli-base',
    provider: 'tangle',
    credentialValue: secret,
  })
  let session
  try {
    assert.equal(Object.values(config.environment).includes(secret), false)
    assert.match(config.connection.credentialRef, /^credential-live-tangle-inference-/u)
    const initialized = await initializedSession(
      join(repository, 'dist', 'bin', 'braid.js'),
      config,
    )
    session = initialized.session
    assert.equal(initialized.state.view.connection, config.connection.name)
    assert.equal(initialized.state.view.runner, 'cli-base')
    assert.equal(initialized.state.view.model, 'glm-5.2')
  } finally {
    if (session !== undefined) await closeSession(session)
    await config.cleanup()
  }
})

test('generated credential cleanup disposes failed removal, cleans root, and retains evidence', async () => {
  let removeAttempts = 0
  let disposeCalls = 0
  let rootRemovalAttempts = 0
  const secret = 'live-required-cleanup-retry-canary-822f'
  const config = await prepareProductionWorkspace({
    repository,
    environment: protectedEnvironment(),
    kind: 'cleanup-retry',
    endpoint: 'https://router.tangle.tools',
    model: 'glm-5.2',
    runner: 'cli-base',
    provider: 'tangle',
    credentialValue: secret,
    credentialContextFactory: () => ({
      store: {
        async store(input) {
          return input.ref
        },
        async remove() {
          removeAttempts += 1
          if (removeAttempts === 1) throw new Error(`transient removal failure: ${secret}`)
        },
      },
      dispose() {
        disposeCalls += 1
      },
    }),
    removeTemporaryRoot: async (root) => {
      rootRemovalAttempts += 1
      if (rootRemovalAttempts === 1)
        throw new Error('transient temporary-root cleanup failure after credential failure')
      await rm(root, { recursive: true, force: true })
    },
  })

  await assert.rejects(
    () => config.cleanup(),
    (error) => {
      assert(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      assert.equal(error.errors[0]?.code, 'PROTECTED_CREDENTIAL_CLEANUP_FAILED')
      assert.equal(
        error.errors[1]?.message,
        'transient temporary-root cleanup failure after credential failure',
      )
      assert.deepEqual(error?.cleanupEvidence, {
        credentialRemoved: false,
        temporaryRootRemoved: false,
      })
      assert.doesNotMatch(safeMessage(error), new RegExp(secret, 'u'))
      return true
    },
  )
  await access(config.root)
  assert.equal(removeAttempts, 1)
  assert.equal(disposeCalls, 1)
  assert.equal(rootRemovalAttempts, 1)

  assert.deepEqual(await config.cleanup(), {
    credentialRemoved: true,
    temporaryRootRemoved: true,
  })
  await assert.rejects(() => access(config.root), /ENOENT/u)
  assert.equal(removeAttempts, 2)
  assert.equal(disposeCalls, 2)
  assert.equal(rootRemovalAttempts, 2)

  assert.deepEqual(await config.cleanup(), {
    credentialRemoved: true,
    temporaryRootRemoved: true,
  })
  assert.equal(removeAttempts, 2)
  assert.equal(disposeCalls, 2)
  assert.equal(rootRemovalAttempts, 2)
})

test('temporary-root cleanup retries after a transient failure without repeating credential removal', async () => {
  let credentialRemovalAttempts = 0
  let disposeCalls = 0
  let rootRemovalAttempts = 0
  const config = await prepareProductionWorkspace({
    repository,
    environment: protectedEnvironment(),
    kind: 'temporary-root-retry',
    endpoint: 'https://router.tangle.tools',
    model: 'glm-5.2',
    runner: 'cli-base',
    provider: 'tangle',
    credentialValue: 'live-required-root-cleanup-canary-154d',
    credentialContextFactory: () => ({
      store: {
        async store(input) {
          return input.ref
        },
        async remove() {
          credentialRemovalAttempts += 1
        },
      },
      dispose() {
        disposeCalls += 1
      },
    }),
    removeTemporaryRoot: async (root) => {
      rootRemovalAttempts += 1
      if (rootRemovalAttempts === 1) throw new Error('transient temporary-root cleanup failure')
      await rm(root, { recursive: true, force: true })
    },
  })

  try {
    await assert.rejects(
      () => config.cleanup(),
      (error) => {
        assert.equal(error?.message, 'transient temporary-root cleanup failure')
        assert.deepEqual(error?.cleanupEvidence, {
          credentialRemoved: true,
          temporaryRootRemoved: false,
        })
        return true
      },
    )
    await access(config.root)
    assert.equal(credentialRemovalAttempts, 1)
    assert.equal(disposeCalls, 1)
    assert.equal(rootRemovalAttempts, 1)

    assert.deepEqual(await config.cleanup(), {
      credentialRemoved: true,
      temporaryRootRemoved: true,
    })
    await assert.rejects(() => access(config.root), /ENOENT/u)
    assert.equal(credentialRemovalAttempts, 1)
    assert.equal(disposeCalls, 1)
    assert.equal(rootRemovalAttempts, 2)
  } finally {
    await config.cleanup().catch(() => undefined)
  }
})

test('configured real-path assertion failures emit failed release evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-required-failure-test-'))
  const wrapper = join(root, 'fixture-wrapper.mjs')
  const binary = join(repository, 'dist', 'bin', 'braid.js')
  await writeFile(
    wrapper,
    `import { spawn } from 'node:child_process'\nconst child = spawn(process.execPath, [process.env.BRAID_FIXTURE_TARGET, 'rpc', '--fixture', 'deterministic'], { stdio: 'inherit' })\nchild.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0))\n`,
    { mode: 0o700 },
  )
  await chmod(wrapper, 0o700)
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, ['scripts/live-required.mjs', 'live-analysis'], {
          cwd: repository,
          env: {
            ...protectedEnvironment(),
            BRAID_FIXTURE_TARGET: binary,
            BRAID_LIVE_BINARY: wrapper,
            BRAID_ANALYSIS_ENDPOINT: 'http://127.0.0.1:3344',
            BRAID_ANALYSIS_MODEL: 'openai-codex/gpt-5.6-luna',
            BRAID_ANALYSIS_RUNNER: 'pi',
            BRAID_ANALYSIS_PROVIDER: 'openai-codex',
            BRAID_ANALYSIS_CREDENTIAL_REF: 'credential-ref-live-required-test',
            BRAID_LIVE_REQUIRED_TIMEOUT_MS: '10000',
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      (error) => {
        assert.equal(error.status, 1)
        const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
        assert.match(output, /BRAID_RELEASE_RESULT_JSON=\{"status":"failed"/u)
        assert.doesNotMatch(output, /BRAID_RELEASE_RESULT_JSON=\{"status":"unavailable"/u)
        assert.match(output, /failed against the configured live path/u)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider configuration names protected references and never accepts a missing credential', () => {
  assert.throws(
    () =>
      connectionConfiguration(
        {},
        {
          prefix: 'BRAID_TANGLE',
          kind: 'tangle-inference',
          fallbackRunner: 'cli-base',
        },
      ),
    /BRAID_TANGLE_ENDPOINT/u,
  )
  assert.throws(
    () =>
      connectionConfiguration(
        {
          BRAID_TANGLE_ENDPOINT: 'https://router.tangle.tools',
          BRAID_TANGLE_MODEL: 'openai/gpt-5',
        },
        {
          prefix: 'BRAID_TANGLE',
          kind: 'tangle-inference',
          fallbackRunner: 'cli-base',
        },
      ),
    /protected credential/u,
  )
})

class FakeWorkerChild extends EventEmitter {
  constructor() {
    super()
    this.exitCode = null
    this.signalCode = null
    this.killSignals = []
    this.inputHandler = () => undefined
    this.stdin = {
      write: (value) => {
        this.inputHandler(String(value))
        return true
      },
    }
  }

  finish(code = 0) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    queueMicrotask(() => this.emit('exit', code, null))
  }

  kill(signal) {
    this.killSignals.push(signal)
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

function fakeWorker(mode, records = []) {
  const child = new FakeWorkerChild()
  const waiters = new Set()
  const worker = {
    mode,
    child,
    records,
    waiters,
    stderr: [],
    push(record) {
      records.push(record)
      for (const waiter of waiters) waiter(record)
    },
  }
  return worker
}

function defaultResumedRecord(values) {
  const executionId = values['execution-id']
  const cursor = values.cursor
  return {
    type: 'resumed',
    environmentId: values['environment-id'],
    sessionId: values['session-id'],
    executionId,
    reconnectToResultMs: 1,
    replay: [
      { id: cursor, type: 'execution.started', executionId },
      { id: 'event-2', type: 'result', executionId },
    ],
    cursorWasInclusive: true,
    result: {
      status: 'success',
      executionId,
      markerMatched: true,
      usage: { inputTokens: 2, outputTokens: 1 },
      costUsd: 0.001,
    },
    sessionStatus: 'completed',
    completedTurn: { found: true, executionId },
    messageStates: [],
    duplicate: {
      dispatched: false,
      executionId,
      sameExecution: true,
      alreadyExisted: true,
      cancellation: null,
    },
    workspaceRetained: true,
  }
}

function createFakeWorkerFactory({
  resumeRecord,
  cancelRecord,
  dispatchFailure,
  cursorFailure,
} = {}) {
  const workers = []
  let watcher
  const factory = (mode, values) => {
    const worker = fakeWorker(mode)
    workers.push(worker)
    if (mode === 'dispatch') {
      if (dispatchFailure) {
        worker.push({ type: 'error', message: dispatchFailure })
      } else {
        worker.push({
          type: 'created',
          environmentId: 'environment-1',
          proofId: values['proof-id'],
          sessionId: values['session-id'],
          turnId: values['turn-id'],
          marker: values.marker,
          createdMs: 1,
          workspaceMs: 1,
          workspace: {
            readMatched: true,
            gitExitCode: 0,
            gitCommit: 'a'.repeat(40),
            resourceUsageReported: true,
          },
        })
        worker.child.inputHandler = (value) => {
          if (value !== 'dispatch\n') return
          worker.push({
            type: 'admitted',
            environmentId: 'environment-1',
            sessionId: values['session-id'],
            executionId: 'execution-1',
            turnId: values['turn-id'],
            marker: values.marker,
            prompt: 'fake prompt',
            dispatchMs: 1,
            dispatched: true,
            alreadyExisted: false,
          })
          watcher?.push(
            cursorFailure
              ? { type: 'error', message: cursorFailure }
              : {
                  type: 'cursor',
                  environmentId: 'environment-1',
                  sessionId: values['session-id'],
                  eventId: 'event-1',
                  eventType: 'execution.started',
                  executionId: 'execution-1',
                },
          )
        }
      }
    } else if (mode === 'watch') {
      watcher = worker
      worker.push({ type: 'listening', environmentId: values['environment-id'] })
    } else if (mode === 'resume') {
      worker.push(resumeRecord ?? defaultResumedRecord(values))
      queueMicrotask(() => worker.child.finish())
    } else if (mode === 'cancel') {
      worker.push(
        cancelRecord ?? {
          type: 'cancelled',
          environmentId: values['environment-id'],
          sessionId: values['session-id'],
          executionId: values['execution-id'],
          first: { cancelled: true },
          second: { cancelled: false },
          replayDetected: true,
          sessionStatus: 'cancelled',
        },
      )
      queueMicrotask(() => worker.child.finish())
    }
    return worker
  }
  return { factory, workers }
}

function createFakeClient(proofId, { includeExact = true } = {}) {
  const exact = {
    id: 'environment-1',
    name: proofId,
    metadata: { owner: PROOF_OWNER, proofId },
    deleted: false,
    deleteCalls: 0,
    async dispatchPrompt() {
      return {
        sessionId: 'cancel-session',
        executionId: 'cancel-execution',
        status: 'running',
        alreadyExisted: false,
        dispatched: true,
      }
    },
    async delete() {
      this.deleted = true
      this.deleteCalls += 1
    },
  }
  const other = {
    id: 'environment-other',
    name: proofId,
    metadata: { owner: 'someone-else', proofId },
    deleted: false,
    deleteCalls: 0,
    async delete() {
      this.deleted = true
      this.deleteCalls += 1
    },
  }
  let usageCalls = 0
  return {
    exact,
    other,
    async usage() {
      usageCalls += 1
      return usageCalls === 1
        ? { activeSandboxes: 1, totalSandboxes: 1, computeMinutes: 0 }
        : { activeSandboxes: 0, totalSandboxes: 1, computeMinutes: 1 }
    },
    async get(id) {
      return id === exact.id && includeExact ? exact : null
    },
    async list() {
      return [...(includeExact && !exact.deleted ? [exact] : []), other]
    },
  }
}

function workerArguments(values) {
  return [
    'node',
    'tangle-sandbox-worker.mjs',
    ...Object.entries(values).flatMap(([name, value]) => [`--${name}`, value]),
  ]
}

test('Tangle sandbox stress uses exact replay, duplicate, cancellation, and SIGKILL checks', async () => {
  const proofId = 'proof-hardened-success'
  const client = createFakeClient(proofId)
  const fakeWorkers = createFakeWorkerFactory()
  const proof = await runStressProof({
    client,
    workerFactory: fakeWorkers.factory,
    coordinates: {
      proofId,
      sessionId: 'session-1',
      turnId: 'turn-1',
      marker: 'MARKER-1',
    },
  })

  assert.equal(proof.status, 'passed')
  assert.deepEqual(proof.gaps, [])
  assert.equal(proof.checks.processKilledAfterDispatch, true)
  assert.equal(proof.checks.processKilledAfterCursor, true)
  assert.equal(proof.checks.exactResultIdentity, true)
  assert.equal(proof.checks.turnIdempotency, true)
  assert.equal(proof.checks.turnIdempotencyReceipt, true)
  assert.equal(proof.checks.cancellationOperationReplay, true)
  assert.deepEqual(proof.exactRun, {
    sessionId: 'session-1',
    executionId: 'execution-1',
    turnId: 'turn-1',
  })
  assert.deepEqual(proof.events, {
    firstObservedId: 'event-1',
    firstObservedType: 'execution.started',
    replayCount: 2,
    replayUniqueCount: 2,
    providerCursorInclusive: true,
  })
  assert.deepEqual(
    fakeWorkers.workers
      .filter((worker) => worker.mode === 'dispatch' || worker.mode === 'watch')
      .map((worker) => worker.child.killSignals),
    [['SIGKILL'], ['SIGKILL']],
  )
  assert.equal(client.exact.deleteCalls, 1)
  assert.equal(client.other.deleteCalls, 0)
  assert.equal(duplicateTurnDetected(proof.idempotency.duplicate, 'execution-1'), true)
  assert.equal(
    duplicateTurnDetected(
      { dispatched: false, executionId: 'execution-1', sameExecution: true },
      'execution-1',
    ),
    false,
  )
  const duplicateGapProofId = 'proof-duplicate-gap'
  const duplicateGap = defaultResumedRecord({
    'environment-id': 'environment-1',
    'session-id': 'session-gap',
    'execution-id': 'execution-1',
    cursor: 'event-1',
  })
  duplicateGap.duplicate.alreadyExisted = false
  const duplicateGapProof = await runStressProof({
    client: createFakeClient(duplicateGapProofId),
    workerFactory: createFakeWorkerFactory({ resumeRecord: duplicateGap }).factory,
    coordinates: {
      proofId: duplicateGapProofId,
      sessionId: 'session-gap',
      turnId: 'turn-gap',
      marker: 'MARKER-GAP',
    },
  })
  assert.equal(duplicateGapProof.status, 'passed-with-gaps')
  assert.deepEqual(duplicateGapProof.gaps, ['turn-idempotency-receipt'])
  assert.equal(duplicateGapProof.checks.turnIdempotency, false)
  assert.equal(cancellationReplayDetected(proof.cancellation, 'cancel-execution'), true)
  assert.equal(
    cancellationReplayDetected(
      {
        executionId: 'cancel-execution',
        first: { cancelled: false },
        second: { cancelled: false },
      },
      'cancel-execution',
    ),
    false,
  )
  assert.equal(
    cancellationReplayDetected(
      {
        executionId: 'other-execution',
        first: { cancelled: true },
        second: { cancelled: false },
        sessionStatus: 'cancelled',
      },
      'cancel-execution',
    ),
    false,
  )
  assert.equal(
    cancellationReplayDetected(
      {
        executionId: 'cancel-execution',
        first: { cancelled: true },
        second: { cancelled: false },
        sessionStatus: 'running',
      },
      'cancel-execution',
    ),
    false,
  )
})

test('Tangle sandbox stress persists partial artifacts for assertion and worker failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-tangle-sandbox-partial-'))
  try {
    const assertionProofId = 'proof-failure'
    const assertionClient = createFakeClient(assertionProofId)
    const badResume = defaultResumedRecord({
      'environment-id': 'environment-1',
      'session-id': 'session-1',
      'execution-id': 'execution-1',
      cursor: 'event-1',
    })
    badResume.result.executionId = 'wrong-execution'
    const assertionWorkers = createFakeWorkerFactory({ resumeRecord: badResume })
    const assertionArtifact = join(root, 'assertion', 'proof.json')
    await assert.rejects(
      () =>
        runStressProof({
          client: assertionClient,
          workerFactory: assertionWorkers.factory,
          outputPath: assertionArtifact,
          coordinates: {
            proofId: assertionProofId,
            sessionId: 'session-1',
            turnId: 'turn-1',
            marker: 'MARKER-1',
          },
        }),
      /resume result execution ID changed during replay/u,
    )
    const assertionEvidence = JSON.parse(await readFile(assertionArtifact, 'utf8'))
    assert.equal(assertionEvidence.status, 'failed')
    assert.equal(assertionEvidence.failure.name, 'AssertionError')
    assert.equal(assertionEvidence.environmentId, 'environment-1')
    assert.equal(assertionEvidence.phase, 'resume')
    assert.deepEqual(assertionEvidence.progress.dispatcherDeath, {
      code: null,
      signal: 'SIGKILL',
    })
    assert.deepEqual(assertionEvidence.progress.watcherDeath, {
      code: null,
      signal: 'SIGKILL',
    })
    assert.equal(assertionEvidence.progress.resumed.result.executionId, 'wrong-execution')

    const workerFailureProofId = 'proof-worker-failure'
    const workerFailureArtifact = join(root, 'worker', 'proof.json')
    const workerFailureClient = createFakeClient(workerFailureProofId, { includeExact: false })
    const workerFailureWorkers = createFakeWorkerFactory({ dispatchFailure: 'fake worker failed' })
    await assert.rejects(
      () =>
        runStressProof({
          client: workerFailureClient,
          workerFactory: workerFailureWorkers.factory,
          outputPath: workerFailureArtifact,
          coordinates: {
            proofId: workerFailureProofId,
            sessionId: 'session-2',
            turnId: 'turn-2',
            marker: 'MARKER-2',
          },
        }),
      /fake worker failed/u,
    )
    const workerEvidence = JSON.parse(await readFile(workerFailureArtifact, 'utf8'))
    assert.equal(workerEvidence.status, 'failed')
    assert.equal(workerEvidence.failure.message, 'fake worker failed')
    assert.equal(workerEvidence.phase, 'dispatch-create')
    assert.equal(workerEvidence.cleanupConfirmed, true)

    const partialProofId = 'proof-partial-admission'
    const partialArtifact = join(root, 'partial', 'proof.json')
    const partialWorkers = createFakeWorkerFactory({
      cursorFailure: 'watcher failed after admission',
    })
    await assert.rejects(
      () =>
        runStressProof({
          client: createFakeClient(partialProofId),
          workerFactory: partialWorkers.factory,
          outputPath: partialArtifact,
          coordinates: {
            proofId: partialProofId,
            sessionId: 'session-3',
            turnId: 'turn-3',
            marker: 'MARKER-3',
          },
        }),
      /watcher failed after admission/u,
    )
    const partialEvidence = JSON.parse(await readFile(partialArtifact, 'utf8'))
    assert.equal(partialEvidence.status, 'failed')
    assert.equal(partialEvidence.phase, 'dispatch')
    assert.equal(partialEvidence.progress.admitted.executionId, 'execution-1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Tangle sandbox cleanup deletes only the exact proof tag', async () => {
  const proofId = 'proof-exact-cleanup'
  const exact = {
    id: 'exact',
    name: proofId,
    metadata: { owner: PROOF_OWNER, proofId },
    deleteCalls: 0,
    async delete() {
      this.deleteCalls += 1
    },
  }
  const wrongOwner = {
    id: 'wrong-owner',
    name: proofId,
    metadata: { owner: 'not-braid', proofId },
    deleteCalls: 0,
    async delete() {
      this.deleteCalls += 1
    },
  }
  const wrongProof = {
    id: 'wrong-proof',
    name: proofId,
    metadata: { owner: PROOF_OWNER, proofId: 'other-proof' },
    deleteCalls: 0,
    async delete() {
      this.deleteCalls += 1
    },
  }
  const pagedExact = {
    id: 'exact-page-2',
    name: proofId,
    metadata: { owner: PROOF_OWNER, proofId },
    deleteCalls: 0,
    async delete() {
      this.deleteCalls += 1
    },
  }
  const unrelated = Array.from({ length: 98 }, (_, index) => ({
    id: `unrelated-${index}`,
    name: `unrelated-${index}`,
    metadata: {},
  }))
  const client = {
    async get(id) {
      assert.equal(id, exact.id)
      return exact
    },
    async list({ offset = 0 } = {}) {
      if (offset === 0) return [wrongOwner, wrongProof, ...unrelated]
      if (offset === 100 && exact.deleteCalls === 0) return [exact, pagedExact]
      return []
    },
  }

  assert.equal(await cleanupProof(client, proofId, exact.id), true)
  assert.equal(exact.deleteCalls, 1)
  assert.equal(pagedExact.deleteCalls, 1)
  assert.equal(wrongOwner.deleteCalls, 0)
  assert.equal(wrongProof.deleteCalls, 0)
})

test('Tangle sandbox worker preserves exact replay and cancellation acknowledgements through fakes', async () => {
  const replayRecords = []
  const interruptOptions = []
  const session = {
    async *events(options) {
      assert.deepEqual(options, { since: 'event-1', executionId: 'execution-1' })
      yield { id: 'event-1', type: 'execution.started', data: { executionId: 'execution-1' } }
      yield { id: 'event-2', type: 'result', executionId: 'execution-1' }
    },
    async result(options) {
      assert.deepEqual(options, { executionId: 'execution-1' })
      return {
        status: 'success',
        executionId: 'execution-1',
        response: 'MARKER-1',
        usage: { inputTokens: 2, outputTokens: 1 },
        costUsd: 0.001,
      }
    },
    async status() {
      return { status: interruptOptions.length === 0 ? 'completed' : 'cancelled' }
    },
    async interrupt(options) {
      interruptOptions.push(options)
      return { cancelled: interruptOptions.length === 1 }
    },
  }
  const box = {
    async read() {
      return 'MARKER-1\n'
    },
    session() {
      return session
    },
    async findCompletedTurn() {
      return { result: { executionId: 'execution-1' } }
    },
    async messages() {
      return [{ role: 'assistant', metadata: { status: 'completed', turnId: 'turn-1' } }]
    },
    async dispatchPrompt() {
      return {
        dispatched: false,
        executionId: 'execution-1',
        alreadyExisted: true,
      }
    },
  }
  const client = {
    async get() {
      return box
    },
  }
  const argv = workerArguments({
    'environment-id': 'environment-1',
    'session-id': 'session-1',
    'execution-id': 'execution-1',
    'turn-id': 'turn-1',
    marker: 'MARKER-1',
    cursor: 'event-1',
  })

  await runWorker('resume', { argv, client, write: (record) => replayRecords.push(record) })
  assert.equal(replayRecords.length, 1)
  assert.deepEqual(replayRecords[0].replay, [
    { id: 'event-1', type: 'execution.started', executionId: 'execution-1' },
    { id: 'event-2', type: 'result', executionId: 'execution-1' },
  ])
  assert.deepEqual(replayRecords[0].result, {
    status: 'success',
    executionId: 'execution-1',
    markerMatched: true,
    usage: { inputTokens: 2, outputTokens: 1 },
    costUsd: 0.001,
  })
  assert.deepEqual(replayRecords[0].duplicate, {
    dispatched: false,
    executionId: 'execution-1',
    sameExecution: true,
    alreadyExisted: true,
    cancellation: null,
  })

  const cancellationRecords = []
  await runWorker('cancel', {
    argv: workerArguments({
      'environment-id': 'environment-1',
      'session-id': 'session-1',
      'execution-id': 'execution-1',
    }),
    client,
    write: (record) => cancellationRecords.push(record),
  })
  assert.deepEqual(interruptOptions, [
    { executionId: 'execution-1' },
    { executionId: 'execution-1' },
  ])
  assert.equal(cancellationRecords[0].replayDetected, true)
  assert.equal(cancellationRecords[0].sessionStatus, 'cancelled')
  assert.deepEqual(cancellationRecords[0].first, { cancelled: true })
  assert.deepEqual(cancellationRecords[0].second, { cancelled: false })
  assert.equal(cancellationReplayDetected(cancellationRecords[0], 'execution-1'), true)
  assertExactResumeEvidence(replayRecords[0], {
    executionId: 'execution-1',
    cursorEventId: 'event-1',
  })
  assert.throws(
    () =>
      assertExactResumeEvidence(
        {
          ...replayRecords[0],
          replay: [
            ...replayRecords[0].replay,
            { id: 'foreign-event', type: 'result', executionId: 'execution-2' },
          ],
        },
        { executionId: 'execution-1', cursorEventId: 'event-1' },
      ),
    /replay included a different execution/u,
  )
})
