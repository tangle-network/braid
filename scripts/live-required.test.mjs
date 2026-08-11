import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  initializedSession,
  prepareProductionWorkspace,
  runHeadlessTurn,
} from './live-required/headless.mjs'
import { runMatrixAdapter } from './live-required/tangle.mjs'

const repository = resolve(new URL('../', import.meta.url).pathname)

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
    'BRAID_SUPERVISOR_LIVE_ADAPTER',
  ])
    delete environment[name]
  return environment
}

function expectedFailureOutput(scope, environment, expectedStatus = 1) {
  let failure
  try {
    execFileSync(process.execPath, ['scripts/live-required.mjs', scope], {
      cwd: repository,
      env: environment,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    failure = error
  }
  assert(failure, `${scope} unexpectedly passed`)
  assert.equal(failure.status, expectedStatus)
  return `${failure.stdout ?? ''}${failure.stderr ?? ''}`
}

async function createSupervisorFixture(root) {
  const supervisorId = 'supervisor-live-required'
  const workerId = 'worker-live-required'
  const runDir = join(root, '.agent', 'supervisor', supervisorId)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, 'state.json'),
    `${JSON.stringify({
      id: supervisorId,
      status: 'running',
      task: 'live-required test',
      workspaceDir: root,
      budget: 1,
    })}\n`,
  )
  const now = '2026-08-10T00:00:00.000Z'
  await writeFile(
    join(runDir, 'spawn-journal.jsonl'),
    `${JSON.stringify({ kind: 'spawned', id: supervisorId, label: 'root', at: now })}\n${JSON.stringify({ kind: 'spawned', id: workerId, label: workerId, parent: supervisorId, at: now })}\n`,
  )
  return { supervisorId, workerId }
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
        if (scope === 'live-tangle') assert.match(output, /"status":"partial"/u)
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
    facts: { environmentId: 'environment-live-test' },
    checks: ['marker', 'environment-id'],
  })
  assert.equal(receipt.schema, PUBLIC_EVIDENCE_SCHEMA)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'checks',
    'completedAt',
    'connection',
    'facts',
    'invocationId',
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

test('configured supervisor failures stay unavailable and redact environment credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-required-supervisor-test-'))
  const missingRoot = join(root, 'missing-runtime-root')
  const common = {
    ...protectedEnvironment(),
    BRAID_SUPERVISOR_ROOT: missingRoot,
    BRAID_SUPERVISOR_ID: 'configured-supervisor',
    BRAID_SUPERVISOR_WORKER: 'configured-worker',
  }
  try {
    let output = expectedFailureOutput('live-supervisor', common)
    assert.match(output, /failed against the configured live path/u)
    assert.doesNotMatch(output, /BRAID_RELEASE_RESULT_JSON=\{"status":"unavailable"/u)

    const { supervisorId, workerId } = await createSupervisorFixture(root)
    const wrongShape = join(root, 'wrong-supervisor-adapter.mjs')
    await writeFile(wrongShape, 'export default 42\n')
    output = expectedFailureOutput(
      'live-supervisor',
      {
        ...common,
        BRAID_SUPERVISOR_ROOT: root,
        BRAID_SUPERVISOR_ID: supervisorId,
        BRAID_SUPERVISOR_WORKER: workerId,
        BRAID_SUPERVISOR_LIVE_ADAPTER: wrongShape,
      },
      2,
    )
    assert.match(output, /BRAID_RELEASE_RESULT_JSON=\{"status":"unavailable"/u)

    const secret = 'live-required-secret-7e5d'
    const throwingAdapter = join(root, 'throwing-supervisor-adapter.mjs')
    await writeFile(
      throwingAdapter,
      'process.stdout.write(process.env.BRAID_TANGLE_API_KEY)\nthrow new Error(process.env.BRAID_TANGLE_API_KEY)\n',
    )
    const configured = {
      ...common,
      BRAID_SUPERVISOR_ROOT: root,
      BRAID_SUPERVISOR_ID: supervisorId,
      BRAID_SUPERVISOR_WORKER: workerId,
      BRAID_SUPERVISOR_LIVE_ADAPTER: throwingAdapter,
      BRAID_TANGLE_API_KEY: secret,
    }
    const direct = safeMessage(new Error(`provider rejected ${secret}`), configured)
    assert.doesNotMatch(direct, new RegExp(secret, 'u'))
    assert.match(direct, /\[REDACTED\]/u)
    output = expectedFailureOutput('live-supervisor', configured, 2)
    assert.equal(output.includes(secret), false)
    assert.match(output, /BRAID_RELEASE_RESULT_JSON=\{"status":"unavailable"/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

test('generated credential cleanup reports failure and succeeds when retried', async () => {
  let removeAttempts = 0
  let disposeCalls = 0
  const config = await prepareProductionWorkspace({
    repository,
    environment: protectedEnvironment(),
    kind: 'cleanup-retry',
    endpoint: 'https://router.tangle.tools',
    model: 'glm-5.2',
    runner: 'cli-base',
    provider: 'tangle',
    credentialValue: 'live-required-cleanup-retry-canary-822f',
    credentialContextFactory: () => ({
      store: {
        async store(input) {
          return input.ref
        },
        async remove() {
          removeAttempts += 1
          if (removeAttempts === 1) throw new Error('transient removal failure')
        },
      },
      dispose() {
        disposeCalls += 1
      },
    }),
  })

  await assert.rejects(
    () => config.cleanup(),
    (error) => error?.code === 'PROTECTED_CREDENTIAL_CLEANUP_FAILED',
  )
  await access(config.root)
  assert.equal(removeAttempts, 1)
  assert.equal(disposeCalls, 0)

  await config.cleanup()
  await assert.rejects(() => access(config.root), /ENOENT/u)
  assert.equal(removeAttempts, 2)
  assert.equal(disposeCalls, 1)

  await config.cleanup()
  assert.equal(removeAttempts, 2)
  assert.equal(disposeCalls, 1)
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
