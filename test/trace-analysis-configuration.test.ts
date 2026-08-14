import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ExternalOptimizerModelCallRequest,
  ExternalOptimizerModelExecutionObservation,
} from '@tangle-network/agent-eval/campaign'
import type { AgentProfile } from '@tangle-network/agent-interface'
import type { RetainedRunAdmissionRecord } from '../src/domain/run-contracts.js'
import { AgentEvalAnalystAdapter } from '../src/adapters/analysis/eval-analyst.js'
import {
  MANAGED_AGENT_EVAL_RPC_VERSION,
  MANAGED_ANALYSIS_PYTHON_VERSION,
  MANAGED_ANALYSIS_RUNTIME_PROBE,
  managedAnalysisRunner,
} from '../src/adapters/analysis/managed-analysis-runtime.js'
import {
  type PythonCommandProbe,
  type PythonCommandProbeResult,
  resolvePythonRunner,
  TRACE_ANALYSIS_PYTHON_PACKAGE_PROBE,
} from '../src/adapters/analysis/python-runner.js'
import {
  BRAID_QUESTION_ANALYST_DEFINITION,
  BRAID_QUESTION_ANALYST_ID,
} from '../src/adapters/analysis/question-analyst.js'
import { createRuntimeTraceModelOwner } from '../src/adapters/analysis/runtime-model-owner.js'
import {
  createTraceAnalysisAdapter,
  createTraceAnalysisAnalyst,
  type TraceAnalysisAdapterOptions,
} from '../src/adapters/analysis/trace-analysis-adapter.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { AnalysisCapabilityError } from '../src/app/analysis-types.js'
import type { ConnectionKind, ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { credentialRef } from '../src/ports/credentials.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const NOW = '2026-08-03T20:00:00.000Z'
const PRICING = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }

test('managed analysis uses bundled uv with exact isolated runtime versions', () => {
  const launcher = '/opt/braid/node_modules/@dataiku/uv/bin.cjs'
  const runner = managedAnalysisRunner({
    platform: 'linux',
    architecture: 'x64',
    resolvePackage: (specifier) => {
      assert.equal(specifier, '@dataiku/uv/bin.cjs')
      return launcher
    },
  })

  assert.equal(runner?.command, process.execPath)
  assert.deepEqual(runner?.args, [
    launcher,
    'run',
    '--no-project',
    '--no-config',
    '--no-env-file',
    '--isolated',
    '--managed-python',
    '--python',
    MANAGED_ANALYSIS_PYTHON_VERSION,
    '--with',
    `agent-eval-rpc[dspy]==${MANAGED_AGENT_EVAL_RPC_VERSION}`,
    '--exclude-newer',
    '2026-08-11T05:00:00Z',
    '--default-index',
    'https://pypi.org/simple',
    '--keyring-provider',
    'disabled',
    '--color',
    'never',
    '--no-progress',
    'python',
    '-m',
    'agent_eval_rpc.dspy_rlm_bridge',
  ])
  assert.deepEqual(runner?.launcherProbeArgs, [launcher, '--version'])
  assert.deepEqual(runner?.runtimeProbeArgs, [
    launcher,
    'run',
    '--no-project',
    '--no-config',
    '--no-env-file',
    '--isolated',
    '--managed-python',
    '--python',
    MANAGED_ANALYSIS_PYTHON_VERSION,
    '--with',
    `agent-eval-rpc[dspy]==${MANAGED_AGENT_EVAL_RPC_VERSION}`,
    '--exclude-newer',
    '2026-08-11T05:00:00Z',
    '--default-index',
    'https://pypi.org/simple',
    '--keyring-provider',
    'disabled',
    '--color',
    'never',
    '--no-progress',
    'python',
    '-c',
    MANAGED_ANALYSIS_RUNTIME_PROBE,
  ])
  assert.equal(managedAnalysisRunner({ platform: 'freebsd', architecture: 'x64' }), undefined)
})

test('managed analysis keeps startup quick and verifies its complete runtime before execution', async () => {
  const previous = process.env.BRAID_PYTHON
  delete process.env.BRAID_PYTHON
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = []
  const probe: PythonCommandProbe = async (command, args, timeoutMs) => {
    calls.push({ command, args: [...args], timeoutMs })
    return { status: 'ok', exitCode: 0 }
  }
  try {
    const startup = await resolvePythonRunner({ probe })
    assert.equal(startup.status, 'ready')
    assert.equal(startup.status === 'ready' ? startup.runner.source : undefined, 'managed')
    assert.deepEqual(calls[0]?.args.slice(-1), ['--version'])

    calls.length = 0
    const execution = await resolvePythonRunner({
      probe,
      managedRuntimeReadiness: 'complete',
    })
    assert.equal(execution.status, 'ready')
    assert.equal(execution.status === 'ready' ? execution.runner.source : undefined, 'managed')
    assert.ok(calls[0]?.args.includes('run'))
    assert.deepEqual(calls[0]?.args.slice(-2), ['-c', MANAGED_ANALYSIS_RUNTIME_PROBE])
    assert.equal(calls[0]?.timeoutMs, 120_000)
  } finally {
    if (previous === undefined) delete process.env.BRAID_PYTHON
    else process.env.BRAID_PYTHON = previous
  }
})

test('managed runtime readiness isolates cancellation across concurrent first use', async () => {
  const previous = process.env.BRAID_PYTHON
  delete process.env.BRAID_PYTHON
  let starts = 0
  let release: ((result: PythonCommandProbeResult) => void) | undefined
  const probe: PythonCommandProbe = async (_command, args) => {
    if (!args.includes('run')) return { status: 'not-found' }
    starts += 1
    return new Promise((resolve) => {
      release = resolve
    })
  }
  const cancelled = new AbortController()
  try {
    const first = resolvePythonRunner({
      probe,
      managedRuntimeReadiness: 'complete',
      signal: cancelled.signal,
      timeoutMs: 5_000,
    })
    const second = resolvePythonRunner({
      probe,
      managedRuntimeReadiness: 'complete',
      timeoutMs: 10_000,
    })
    cancelled.abort()
    await assert.rejects(first, (error: unknown) => {
      return error instanceof Error && error.name === 'AbortError'
    })
    assert.equal(starts, 1)
    assert.ok(release)
    release({ status: 'ok', exitCode: 0 })
    const ready = await second
    assert.equal(ready.status, 'ready')
    assert.equal(ready.status === 'ready' ? ready.runner.source : undefined, 'managed')
  } finally {
    if (previous === undefined) delete process.env.BRAID_PYTHON
    else process.env.BRAID_PYTHON = previous
  }
})

test('managed runtime resolution failure is typed before analysis starts', async () => {
  const previous = process.env.BRAID_PYTHON
  delete process.env.BRAID_PYTHON
  const probe: PythonCommandProbe = async (_command, args) =>
    args.includes('run') ? { status: 'failed', exitCode: 1 } : { status: 'not-found' }
  try {
    const result = await resolvePythonRunner({
      probe,
      managedRuntimeReadiness: 'complete',
    })
    assert.equal(result.status, 'python-probe-failed')
    assert.match(result.message, /could not resolve Python 3\.12/u)
  } finally {
    if (previous === undefined) delete process.env.BRAID_PYTHON
    else process.env.BRAID_PYTHON = previous
  }
})

function connection(
  kind: ConnectionKind,
  name: string,
  endpoint: string,
  withCredential = false,
): ConnectionRecord {
  return {
    id: createConnectionId(`connection-analysis-${name}`),
    kind,
    name,
    endpoint,
    ...(withCredential
      ? { credentialRef: createCredentialRefId(`credential-analysis-${name}`) }
      : {}),
    providerOptions: { transport: 'https' },
    createdAt: NOW,
    updatedAt: NOW,
    lastHealth: { status: 'unknown' },
  }
}

function profile(model?: string): Readonly<AgentProfile> {
  return model === undefined
    ? {}
    : { harness: 'pi', model: { default: model, provider: 'tangle-router' } }
}

function successfulProbe(
  calls: Array<{ command: string; args: readonly string[] }>,
): PythonCommandProbe {
  return async (command, args) => {
    calls.push({ command, args: [...args] })
    return { status: 'ok', exitCode: 0 }
  }
}

function baseOptions(
  selected: ConnectionRecord,
  overrides: Partial<TraceAnalysisAdapterOptions> = {},
): TraceAnalysisAdapterOptions {
  return {
    connection: selected,
    profile: profile('glm-5.2'),
    python: { command: '/opt/python with spaces', args: ['-u'] },
    pythonProbe: successfulProbe([]),
    pricing: PRICING,
    ...overrides,
  }
}

test('configures the published DSPy RLM engine and model-backed analyst registry', async () => {
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const selected = connection('cli-bridge', 'local', 'http://127.0.0.1:4010')
  const result = await createTraceAnalysisAdapter(
    baseOptions(selected, { pythonProbe: successfulProbe(calls) }),
  )

  assert.equal(result.status, 'engine-configured')
  if (result.status !== 'engine-configured') return
  assert.equal(result.model, 'pi/tangle-router/glm-5.2')
  assert.equal(result.connection.endpoint, 'http://127.0.0.1:4010')
  assert.match(String(result.engine.executionConfig.call_ref), /^braid-agent-runtime:/u)
  assert.equal(result.engine.executionConfig.model, 'pi/tangle-router/glm-5.2')
  assert.equal(result.engine.executionConfig.control_adapter, 'tolerant')
  assert.deepEqual(result.engine.executionConfig.pricing, PRICING)
  assert.equal(result.engine.executionConfig.max_output_tokens, 16_384)
  assert.equal(result.engine.executionConfig.max_reasoning_tokens, 65_536)
  assert.equal(result.engine.executionConfig.max_cost_usd, 1.16384)
  assert.equal('base_url' in result.engine.executionConfig, false)
  assert.equal('api_key_provided' in result.engine.executionConfig, false)
  assert.deepEqual(result.modelExecutions(), [])
  assert.equal(result.credentialState, 'not-required')
  assert.deepEqual(calls, [
    { command: '/opt/python with spaces', args: ['-u', '--version'] },
    {
      command: '/opt/python with spaces',
      args: ['-u', '-c', TRACE_ANALYSIS_PYTHON_PACKAGE_PROBE],
    },
  ])

  const analystIds = result.registry.list().map((analyst) => analyst.id)
  assert.ok(analystIds.includes('efficiency-behavioral'))
  assert.ok(analystIds.includes('failure-mode'))
  assert.ok(analystIds.includes('improvement'))
  assert.ok(analystIds.includes(BRAID_QUESTION_ANALYST_ID))
  const askIds = new AgentEvalAnalystAdapter(result.registry).resolveAnalystIds({ recipe: 'ask' })
  assert.deepEqual(askIds, [BRAID_QUESTION_ANALYST_ID])
})

test('analysis cost capacity admits the configured output and reasoning limits', async () => {
  const selected = connection('cli-bridge', 'cost-capacity', 'http://127.0.0.1:4010')
  const result = await createTraceAnalysisAdapter(
    baseOptions(selected, {
      profile: { harness: 'claude-code', model: { default: 'opus' } },
      pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 75 },
      maxOutputTokens: 32_768,
    }),
  )

  assert.equal(result.status, 'engine-configured')
  if (result.status !== 'engine-configured') return
  assert.equal(result.engine.executionConfig.max_output_tokens, 32_768)
  assert.equal(result.engine.executionConfig.max_reasoning_tokens, 131_072)
  assert.equal(result.engine.executionConfig.max_cost_usd, 15.36)
})

test('defines a bounded cited-answer analyst for /ask', () => {
  assert.equal(BRAID_QUESTION_ANALYST_DEFINITION.id, BRAID_QUESTION_ANALYST_ID)
  assert.equal(BRAID_QUESTION_ANALYST_DEFINITION.toolGroup, 'singleTrace')
  assert.equal(BRAID_QUESTION_ANALYST_DEFINITION.requireStructuredFindings, true)
  assert.equal(BRAID_QUESTION_ANALYST_DEFINITION.minimumEvidenceCitations, 1)
  assert.equal(typeof BRAID_QUESTION_ANALYST_DEFINITION.prepareContext, 'function')
  assert.match(BRAID_QUESTION_ANALYST_DEFINITION.instructions, /direct answer/u)
  assert.match(BRAID_QUESTION_ANALYST_DEFINITION.instructions, /Do not invent/u)
  assert.match(
    BRAID_QUESTION_ANALYST_DEFINITION.instructions,
    /SUBMIT\(answer=answer, findings_json=json\.dumps\(findings\)\)/u,
  )
  assert.match(BRAID_QUESTION_ANALYST_DEFINITION.instructions, /exact string value/u)
  assert.match(BRAID_QUESTION_ANALYST_DEFINITION.instructions, /Every citation must copy/u)
})

test('resolves the selected connection credential in memory and never exposes it in configuration', async () => {
  const selected = connection('tangle-inference', 'cloud', 'https://router.test', true)
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:analysis-cloud')
  const secret = 'analysis-secret-never-persisted'
  await credentials.store({ ref: portRef, value: Buffer.from(secret) })
  const result = await createTraceAnalysisAdapter(
    baseOptions(selected, {
      credentials,
      credentialRefResolver: () => portRef,
    }),
  )

  assert.equal(result.status, 'engine-configured')
  if (result.status !== 'engine-configured') return
  assert.equal(result.credentialState, 'provided')
  assert.match(String(result.engine.executionConfig.call_ref), /^braid-agent-runtime:/u)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'))
  assert.doesNotMatch(JSON.stringify(result.engine.executionConfig), new RegExp(secret, 'u'))
})

test('trace analysis forwards the injected router transport', async () => {
  const selected = connection('tangle-inference', 'router-transport', 'https://router.test', true)
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:router-transport')
  await credentials.store({ ref: portRef, value: Buffer.from('router-secret') })
  const options = baseOptions(selected, {
    credentials,
    credentialRefResolver: () => portRef,
  })
  let accessed = false
  Object.defineProperty(options, 'routerComplete', {
    configurable: true,
    get: () => {
      accessed = true
      return async () => ({})
    },
  })

  const result = await createTraceAnalysisAdapter(options)
  assert.equal(result.status, 'engine-configured')
  assert.equal(accessed, true)
})

test('reports a missing model before probing Python', async () => {
  let probes = 0
  const selected = connection('cli-bridge', 'model-required', 'http://127.0.0.1:4010')
  const result = await createTraceAnalysisAdapter(
    baseOptions(selected, {
      profile: profile(),
      pythonProbe: async () => {
        probes += 1
        return { status: 'ok', exitCode: 0 }
      },
    }),
  )

  assert.equal(result.status, 'missing-model')
  assert.equal(result.diagnostics[0]?.kind, 'missing-model')
  assert.equal(probes, 0)
})

test('materializes the selected AgentProfile runner into the CLI Bridge model route', async () => {
  const selected = connection('cli-bridge', 'profile-route', 'http://127.0.0.1:4010')
  const result = await createTraceAnalysisAdapter(
    baseOptions(selected, {
      profile: {
        harness: 'pi',
        model: { default: 'glm-5.2', provider: 'tangle-router' },
      },
    }),
  )

  assert.equal(result.status, 'engine-configured')
  if (result.status !== 'engine-configured') return
  assert.equal(result.runner, 'pi')
  assert.equal(result.model, 'pi/tangle-router/glm-5.2')
  assert.equal(result.engine.executionConfig.model, 'pi/tangle-router/glm-5.2')
})

test('trace analysis accepts a prior matching CLI Bridge route without doubling it', async () => {
  const selected = connection('cli-bridge', 'prior-profile-route', 'http://127.0.0.1:4010')
  const result = await createTraceAnalysisAdapter(
    baseOptions(selected, {
      profile: {
        harness: 'pi',
        model: { default: 'pi/tangle-router/glm-5.2' },
      },
    }),
  )

  assert.equal(result.status, 'engine-configured')
  if (result.status !== 'engine-configured') return
  assert.equal(result.model, 'pi/tangle-router/glm-5.2')
  assert.equal(result.engine.executionConfig.model, 'pi/tangle-router/glm-5.2')
})

test('rejects a CLI Bridge runner and model mismatch before probing Python', async () => {
  let probes = 0
  const selected = connection('cli-bridge', 'profile-mismatch', 'http://127.0.0.1:4010')
  const result = await createTraceAnalysisAdapter(
    baseOptions(selected, {
      profile: { harness: 'codex', model: { default: 'pi/tangle-router/glm-5.2' } },
      pythonProbe: async () => {
        probes += 1
        return { status: 'ok', exitCode: 0 }
      },
    }),
  )

  assert.equal(result.status, 'unavailable')
  assert.equal(result.diagnostics[0]?.code, 'CONNECTION_MODEL_HARNESS_MISMATCH')
  assert.equal(probes, 0)
})

test('reports sandbox connections as unsupported for direct trace analysis', async () => {
  const selected = connection('tangle-sandbox', 'sandbox', 'https://sandbox.test')
  const result = await createTraceAnalysisAdapter(baseOptions(selected))

  assert.equal(result.status, 'unsupported-connection')
  assert.equal(result.diagnostics[0]?.kind, 'unsupported-connection')
  assert.match(result.diagnostics[0]?.message ?? '', /direct model endpoint/u)
  assert.match(result.diagnostics[0]?.message ?? '', /cli-bridge/u)
  assert.match(result.diagnostics[0]?.message ?? '', /tangle-inference/u)
})

test('reports a missing inference credential without invoking the engine', async () => {
  const selected = connection('tangle-inference', 'credential-required', 'https://router.test')
  const result = await createTraceAnalysisAdapter(baseOptions(selected))

  assert.equal(result.status, 'missing-credential')
  assert.equal(result.diagnostics[0]?.kind, 'missing-credential')
  assert.equal(result.diagnostics[0]?.code, 'CONNECTION_CREDENTIAL_REQUIRED')
})

test('reports an absent agent-eval Python package distinctly from an absent interpreter', async () => {
  const selected = connection('cli-bridge', 'python-package', 'http://127.0.0.1:4010')
  const probe: PythonCommandProbe = async (_command, args): Promise<PythonCommandProbeResult> =>
    args.includes('-c') ? { status: 'failed', exitCode: 13 } : { status: 'ok', exitCode: 0 }
  const packageResult = await createTraceAnalysisAdapter(
    baseOptions(selected, { pythonProbe: probe }),
  )
  assert.equal(packageResult.status, 'missing-python-package')
  assert.equal(packageResult.diagnostics[0]?.kind, 'missing-python-package')

  const missingResult = await createTraceAnalysisAdapter({
    connection: selected,
    profile: profile('glm-5.2'),
    pricing: PRICING,
    pythonCandidates: ['python-command-that-does-not-exist'],
    pythonProbe: async () => ({ status: 'not-found' }),
  })
  assert.equal(missingResult.status, 'missing-python')
  assert.equal(missingResult.diagnostics[0]?.kind, 'missing-python')
})

test('production unavailable trace analysis never falls back to deterministic analysts', async () => {
  const selected = connection('cli-bridge', 'missing-python', 'http://127.0.0.1:4010')
  const configuration = await createTraceAnalysisAdapter(
    baseOptions(selected, {
      pythonProbe: async () => ({ status: 'not-found' }),
    }),
  )
  const analyst = createTraceAnalysisAnalyst(configuration)
  assert.deepEqual(analyst.list(), [])
  assert.throws(
    () => analyst.resolveAnalystIds({ recipe: 'ask' }),
    (error: unknown) =>
      error instanceof AnalysisCapabilityError &&
      error.code === 'ANALYSIS_CAPABILITY_UNAVAILABLE' &&
      /python/iu.test(error.issue.reason),
  )
})

test('passes Python as an executable plus argv and never shell-interpolates it', async () => {
  const command = 'python --version; touch /tmp/braid-should-not-exist'
  const result = await resolvePythonRunner({
    runner: { command },
    probe: async (receivedCommand, args) => {
      assert.equal(receivedCommand, command)
      assert.deepEqual(args, ['--version'])
      return { status: 'not-found' }
    },
  })
  assert.equal(result.status, 'missing-python')
})

function optimizerRequest(
  overrides: Partial<ExternalOptimizerModelCallRequest['request']> = {},
): ExternalOptimizerModelCallRequest {
  return {
    callId: 'analysis-model-call-1',
    request: {
      model: 'pi/tangle-router/glm-5.2',
      messages: [
        { role: 'system', content: 'private analyst instruction' },
        { role: 'user', content: 'private trace question' },
      ],
      maxTokens: 64,
      temperature: 0.2,
      jsonSchema: {
        name: 'analysis_result',
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      },
      ...overrides,
    },
    endpointFormat: 'chat-completions',
    signal: new AbortController().signal,
  }
}

function runtimeOwner(
  complete: NonNullable<Parameters<typeof createRuntimeTraceModelOwner>[0]['complete']>,
  recordExecution?: (observation: ExternalOptimizerModelExecutionObservation) => void,
  model = 'pi/tangle-router/glm-5.2',
) {
  const selected = connection('tangle-inference', 'runtime-owner', 'https://router.test', true)
  return createRuntimeTraceModelOwner({
    profile: {
      harness: 'cli-base',
      model: {
        default: model,
        provider: 'tangle-router',
        reasoningEffort: 'high',
      },
    },
    connection: selected,
    baseUrl: 'http://127.0.0.1:3344/v1',
    credential: 'credential-never-recorded',
    model,
    pricing: PRICING,
    complete,
    ...(recordExecution === undefined ? {} : { recordExecution }),
  })
}

function retainAnalysisAdmissions(target: RetainedRunAdmissionRecord[] = []) {
  return async (_callId: string, admission: RetainedRunAdmissionRecord): Promise<void> => {
    target.push(structuredClone(admission))
  }
}

test('runtime-owned trace model call preserves canonical messages, limits, usage, and safe evidence', async () => {
  let receivedAuthorization = ''
  let receivedBody: Record<string, unknown> | undefined
  const owner = runtimeOwner(async (body, request) => {
    receivedAuthorization = request?.headers.authorization ?? ''
    receivedBody = body
    return {
      model: 'pi/tangle-router/glm-5.2',
      choices: [{ message: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: { cached_tokens: 5 },
        prompt_cache: { write_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }
  })

  const result = await owner.call(optimizerRequest())
  assert.equal(result.succeeded, true)
  if (!result.succeeded) return
  assert.equal(receivedAuthorization, 'Bearer credential-never-recorded')
  assert.deepEqual(receivedBody?.messages, [
    { role: 'system', content: 'private analyst instruction' },
    { role: 'user', content: 'private trace question' },
  ])
  assert.equal(receivedBody?.max_tokens, 64)
  assert.equal(receivedBody?.temperature, 0.2)
  assert.deepEqual(receivedBody?.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'analysis_result',
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
    },
  })
  assert.equal(result.response.content, '{"answer":"ok"}')
  assert.deepEqual(result.response.usage, {
    promptTokens: 12,
    completionTokens: 3,
    totalTokens: 15,
    cachedPromptTokens: 5,
    reasoningTokens: 1,
  })
  assert.equal(result.response.costUsd, 0.0000138)
  assert.equal(result.receipt.inputTokens, 5)
  assert.equal(result.receipt.outputTokens, 3)
  assert.equal(result.receipt.cachedTokens, 5)
  assert.equal(result.receipt.cacheWriteTokens, 2)
  assert.equal(result.receipt.reasoningTokens, 1)
  assert.equal(result.receipt.estimatedCostUsd, 0.0000138)
  const execution = JSON.stringify(result.execution)
  assert.doesNotMatch(execution, /credential-never-recorded/u)
  assert.doesNotMatch(execution, /private analyst instruction/u)
  assert.doesNotMatch(execution, /private trace question/u)
  assert.match(execution, /profileOptimizerModelCall/u)
  assert.match(execution, /agent-runtime-profile-model-call/u)
  assert.match(execution, /"maxAttempts":1/u)
})

test('runtime-owned CLI Bridge analysis uses the harness executor with portable profile authority', async () => {
  const bridge = await startRuntimeBridgeServer({
    expectedBearer: 'credential-never-recorded',
    responseText: '{"answer":"bridge ok"}',
    estimatedCostUsd: 0,
    usage: {
      promptTokens: 2,
      completionTokens: 3,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 7,
      reasoningTokens: 1,
    },
  })
  try {
    const admissions: RetainedRunAdmissionRecord[] = []
    const selected = connection('cli-bridge', 'runtime-bridge-owner', bridge.endpoint)
    const owner = createRuntimeTraceModelOwner({
      profile: {
        name: 'Product engineer',
        harness: 'pi',
        model: {
          default: 'tangle-router/glm-5.2',
          provider: 'tangle-router',
          reasoningEffort: 'high',
        },
      },
      connection: selected,
      baseUrl: bridge.endpoint,
      credential: 'credential-never-recorded',
      model: 'pi/tangle-router/glm-5.2',
      pricing: PRICING,
      onRetainedAdmission: retainAnalysisAdmissions(admissions),
    })

    const result = await owner.call(optimizerRequest({ thinking: 'disabled' }))
    assert.equal(result.succeeded, true)
    if (!result.succeeded) return
    assert.equal(result.response.content, '{"answer":"bridge ok"}')
    assert.deepEqual(result.response.usage, {
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
      captured: true,
      cachedPromptTokens: 5,
      reasoningTokens: 1,
    })
    assert.deepEqual(result.receipt.customTokenPricing, PRICING)
    assert.equal(result.receipt.inputTokens, 2)
    assert.equal(result.receipt.cachedTokens, 5)
    assert.equal(result.receipt.cacheWriteTokens, 7)
    assert.equal(result.receipt.reasoningTokens, 1)
    assert.deepEqual((result.execution as { readonly billing?: unknown }).billing, {
      status: 'estimated',
      usd: 0.00002,
    })
    assert.equal(bridge.requests.length, 1)
    assert.deepEqual(
      admissions.map((admission) => admission.phase),
      ['environment', 'dispatched'],
    )
    const body = bridge.requests[0]?.body
    assert.equal(body?.model, 'pi/tangle-router/glm-5.2')
    assert.equal(body?.max_tokens, undefined)
    const executionProfile = body?.agent_profile as AgentProfile
    assert.equal(executionProfile.harness, 'pi')
    assert.equal(executionProfile.model?.default, 'tangle-router/glm-5.2')
    assert.equal(executionProfile.model?.provider, 'tangle-router')
    assert.equal(executionProfile.model?.reasoningEffort, 'none')
    assert.equal(executionProfile.model?.metadata?.maxTokens, 64)
    assert.equal(executionProfile.model?.metadata?.retry, undefined)
    assert.match(executionProfile.prompt?.systemPrompt ?? '', /text-generation endpoint/u)
    assert.match(executionProfile.prompt?.systemPrompt ?? '', /messages array/u)
    assert.match(executionProfile.prompt?.systemPrompt ?? '', /machine format/u)
    assert.match(executionProfile.prompt?.systemPrompt ?? '', /exact identifier/u)
    assert.match(executionProfile.prompt?.systemPrompt ?? '', /Do not inspect files/u)
    assert.deepEqual(executionProfile.tools, {
      bash: false,
      edit: false,
      read: false,
      write: false,
    })
    assert.deepEqual(executionProfile.permissions, {
      bash: 'deny',
      edit: 'deny',
      read: 'deny',
      write: 'deny',
    })
    assert.deepEqual(executionProfile.extensions, { pi: { load: [] } })
    const messages = body?.messages as Array<{ readonly role?: string; readonly content?: string }>
    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.role, 'user')
    assert.deepEqual(JSON.parse(messages[0]?.content ?? '{}'), {
      messages: optimizerRequest().request.messages,
    })
    assert.equal(
      (result.execution as { readonly runtime?: { readonly operation?: string } }).runtime
        ?.operation,
      'startRetainedRun',
    )
    assert.doesNotMatch(JSON.stringify(result.execution), /private analyst instruction/u)
    assert.doesNotMatch(JSON.stringify(result.execution), /private trace question/u)
  } finally {
    await bridge.close()
  }
})

test('runtime-owned CLI Bridge analysis cancels a detached run when result retrieval fails', async () => {
  const bridge = await startRuntimeBridgeServer({
    expectedBearer: 'credential-never-recorded',
    statusFailureStatus: 503,
  })
  try {
    const selected = connection('cli-bridge', 'runtime-bridge-failure', bridge.endpoint)
    const owner = createRuntimeTraceModelOwner({
      profile: {
        name: 'Product engineer',
        harness: 'pi',
        model: { default: 'tangle-router/glm-5.2', provider: 'tangle-router' },
      },
      connection: selected,
      baseUrl: bridge.endpoint,
      credential: 'credential-never-recorded',
      model: 'pi/tangle-router/glm-5.2',
      pricing: PRICING,
      onRetainedAdmission: retainAnalysisAdmissions(),
    })

    const result = await owner.call(optimizerRequest())
    assert.equal(result.succeeded, false)
    if (result.succeeded) return
    assert.equal(bridge.requests.length, 1)
    assert.equal(bridge.cancellations.length, 1)
    assert.equal(
      typeof (result.execution as { readonly retained?: { readonly runId?: unknown } }).retained
        ?.runId,
      'string',
    )
    assert.equal((result.execution as { readonly dispatched?: unknown }).dispatched, true)
    assert.equal(result.receipt.usageUnknown, true)
    assert.equal(result.receipt.costUnknown, true)
  } finally {
    await bridge.close()
  }
})

test('runtime-owned Claude analysis accepts a runner alias with exact tool isolation', async () => {
  const bridge = await startRuntimeBridgeServer({
    expectedBearer: 'credential-never-recorded',
    responseText: '{"answer":"bridge ok"}',
    estimatedCostUsd: 0,
  })
  try {
    const selected = connection('cli-bridge', 'runtime-claude-owner', bridge.endpoint)
    const owner = createRuntimeTraceModelOwner({
      profile: {
        name: 'Product engineer',
        harness: 'claude-code',
        model: { default: 'opus', reasoningEffort: 'high' },
      },
      connection: selected,
      baseUrl: bridge.endpoint,
      credential: 'credential-never-recorded',
      model: 'claude-code/opus',
      pricing: PRICING,
      onRetainedAdmission: retainAnalysisAdmissions(),
    })

    const result = await owner.call(
      optimizerRequest({ model: 'claude-code/opus', thinking: 'disabled' }),
    )
    assert.equal(result.succeeded, true)
    if (!result.succeeded) return
    assert.equal(result.response.content, '{"answer":"bridge ok"}')
    assert.equal(bridge.requests.length, 1)
    const body = bridge.requests[0]?.body
    assert.equal(body?.model, 'claude-code/opus')
    const executionProfile = body?.agent_profile as AgentProfile
    assert.equal(executionProfile.harness, 'claude-code')
    assert.equal(executionProfile.model?.default, 'opus')
    assert.equal(executionProfile.model?.provider, undefined)
    assert.deepEqual(executionProfile.tools, {
      bash: false,
      edit: false,
      read: false,
      write: false,
    })
    assert.deepEqual(executionProfile.permissions, {
      bash: 'deny',
      edit: 'deny',
      read: 'deny',
      write: 'deny',
    })
    assert.equal(
      (result.execution as { readonly runtime?: { readonly operation?: string } }).runtime
        ?.operation,
      'startRetainedRun',
    )
  } finally {
    await bridge.close()
  }
})

test('runtime-owned trace model preserves observed cost when token usage is unknown', async () => {
  const owner = runtimeOwner(async () => ({
    model: 'pi/tangle-router/glm-5.2',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { cost_usd: 0.123 },
  }))

  const result = await owner.call(optimizerRequest())
  assert.equal(result.succeeded, true)
  if (!result.succeeded) return
  assert.equal(result.response.usage.captured, false)
  assert.equal(result.response.costUsd, 0.123)
  assert.equal(result.receipt.usageUnknown, true)
  assert.equal(result.receipt.actualCostUsd, 0.123)
  assert.equal(result.receipt.costUnknown, undefined)
  assert.deepEqual((result.execution as { readonly billing?: unknown }).billing, {
    status: 'observed',
    usd: 0.123,
  })
})

test('runtime-owned trace model preserves partial usage as unknown', async () => {
  const owner = runtimeOwner(async () => ({
    model: 'pi/tangle-router/glm-5.2',
    choices: [{ message: { content: 'partial' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12 },
  }))

  const result = await owner.call(optimizerRequest())
  assert.equal(result.succeeded, true)
  if (!result.succeeded) return
  assert.deepEqual(result.response.usage, {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    captured: false,
  })
  assert.equal(result.response.costUsd, null)
  assert.equal(result.receipt.usageUnknown, true)
  assert.equal(result.receipt.costUnknown, true)
  const execution = result.execution as {
    readonly billing?: unknown
    readonly dispatched?: unknown
    readonly events?: Readonly<Record<string, number>>
    readonly runtime?: { readonly execution?: { readonly executed?: unknown } }
    readonly usage?: unknown
  }
  assert.deepEqual(execution.usage, {
    captured: false,
    inputTokens: 0,
    outputTokens: 0,
    reportedModel: 'pi/tangle-router/glm-5.2',
  })
  assert.deepEqual(execution.billing, { status: 'unknown' })
  assert.equal(execution.dispatched, true)
  assert.equal(execution.runtime?.execution?.executed, true)
  assert.equal(execution.events?.llm_call, 1)
})

test('runtime model route errors never expose invalid model material', async () => {
  const secretModel = 'Bearer raw-secret-never-output'
  let calls = 0
  const owner = runtimeOwner(
    async () => {
      calls += 1
      throw new Error('must not dispatch')
    },
    undefined,
    secretModel,
  )

  const result = await owner.call(optimizerRequest())
  assert.equal(result.succeeded, false)
  assert.equal(calls, 0)
  assert.doesNotMatch(JSON.stringify(result), /raw-secret-never-output/u)
})

test('runtime-owned trace model failures resolve with explicit execution and accounting state', async () => {
  let calls = 0
  const owner = runtimeOwner(async () => {
    calls += 1
    throw new Error('HTTP 503: private upstream body')
  })
  const result = await owner.call(optimizerRequest())
  assert.equal(result.succeeded, false)
  if (result.succeeded) return
  assert.equal(calls, 1)
  assert.equal(result.receipt.usageUnknown, true)
  assert.equal(result.receipt.costUnknown, true)
  assert.match(result.error, /503/u)
  assert.doesNotMatch(JSON.stringify(result.execution), /private upstream body/u)
  assert.equal((result.execution as { readonly dispatched?: unknown }).dispatched, true)
})

test('runtime-owned trace model rejects unsupported request shapes before spending', async () => {
  let calls = 0
  const owner = runtimeOwner(async () => {
    calls += 1
    throw new Error('fetch must not run')
  })
  const result = await owner.call(
    optimizerRequest({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }],
        },
      ],
    }),
  )
  assert.equal(result.succeeded, false)
  if (result.succeeded) return
  assert.equal(calls, 0)
  assert.equal(result.receipt.inputTokens, 0)
  assert.equal(result.receipt.outputTokens, 0)
  assert.deepEqual(result.receipt.customTokenPricing, PRICING)
  assert.equal(result.receipt.costUnknown, undefined)
  assert.equal((result.execution as { readonly dispatched?: unknown }).dispatched, false)
})

test('runtime model execution observations are bounded, cloned, and externally recordable', () => {
  const forwarded: ExternalOptimizerModelExecutionObservation[] = []
  const owner = runtimeOwner(
    async () => {
      throw new Error('unused completion')
    },
    (observation) => forwarded.push(observation),
  )
  const observation: ExternalOptimizerModelExecutionObservation = {
    sequence: 1,
    callId: 'analysis-model-call-1',
    callRef: owner.callRef,
    path: '/v1/chat/completions',
    model: 'pi/tangle-router/glm-5.2',
    succeeded: true,
    responseStatus: 200,
    execution: { receipt: 'finite' },
  }
  owner.recordExecution(observation)
  assert.deepEqual(owner.executions(), [observation])
  assert.deepEqual(forwarded, [observation])
  assert.notEqual(owner.executions()[0], observation)
  assert.notEqual(forwarded[0], observation)
})
