import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import { streamAgentTurn } from '@tangle-network/agent-runtime/kernel'
import { normalizeTangleInferenceRuntimeBaseUrl } from '../src/adapters/connections/production-connection-endpoints.js'
import {
  createProductionConnectionAdapter,
  type SandboxClientFactoryInput,
} from '../src/adapters/connections/production-connections.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { AgentRuntimeExecutionPort } from '../src/adapters/runtime/agent-runtime-execution.js'
import {
  createProductionBackendResolver,
  type ProductionBackendResolverOptions,
  resolveProductionBackend,
  resolveProductionCliBridgeConnection,
} from '../src/adapters/runtime/production-backend-resolver.js'
import { ConnectionError } from '../src/app/connection-errors.js'
import { ConnectionRegistry, mergeConnectionTelemetry } from '../src/app/connections.js'
import { createInteractionRequest } from '../src/app/interaction-request.js'
import { providerEventFor } from '../src/app/run-event-mapper.js'
import { canonicalDigest } from '../src/domain/canonical.js'
import type { ConnectionKind, ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { BRAID_SANDBOX_INTERACTION_UNSUPPORTED } from '../src/domain/runtime-diagnostics.js'
import { credentialRef } from '../src/ports/credentials.js'
import type { ExecuteTurnInput } from '../src/ports/execution.js'
import { environmentSupportsInteractionResponse } from '../src/ports/execution.js'
import { startRuntimeBridgeServer } from './support/runtime-bridge-server.js'

const at = '2026-08-03T12:00:00.000Z'

function connection(
  kind: ConnectionKind,
  id: string,
  endpoint?: string,
  credential = false,
): ConnectionRecord {
  return {
    id: createConnectionId(`connection-${id}`),
    kind,
    name: `${kind} test connection`,
    ...(endpoint ? { endpoint } : {}),
    ...(credential ? { credentialRef: createCredentialRefId(`credential-${id}`) } : {}),
    providerOptions: { transport: 'https' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

function profile(
  model = 'openai/gpt-5',
  harness: AgentProfile['harness'] = 'opencode',
): AgentProfile {
  const segments = model.split('/')
  const provider =
    (segments[0] === harness ? (segments[1] ?? segments[0]) : segments[0]) ?? 'fixture'
  return { model: { default: model, provider }, harness }
}

/** The exact interaction request a sandbox publishes when it asks a question. */
function questionRequest(runId = 'run-connection-test') {
  const interactionId = 'question-1'
  return createInteractionRequest({
    id: interactionId,
    kind: 'question',
    title: 'Continue the operation?',
    answerSpec: {
      fields: [{ type: 'boolean', name: 'continue', label: 'Continue', required: true }],
    },
    binding: {
      runId,
      provider: 'tangle-sandbox',
      environmentId: 'sandbox-awaiting_question',
      sessionId: 'session-connection-test',
      executionId: runId,
      interactionId,
    },
  })
}

function turnInput(profileValue: AgentProfile): ExecuteTurnInput {
  return {
    operationId: 'operation-connection-test',
    runId: 'run-connection-test',
    turnId: 'turn-connection-test',
    text: 'say hello',
    profile: profileValue,
    signal: new AbortController().signal,
  }
}

test('connection records stay secret-free and selection is exact', () => {
  const record = connection('cli-bridge', 'exact', 'http://127.0.0.1:4010')
  const registry = new ConnectionRegistry([record])
  const selected = registry.select({
    connectionId: record.id,
    expectedKind: 'cli-bridge',
    expectedUpdatedAt: at,
  })

  assert.equal(selected.record, registry.get(record.id))
  assert.equal(selected.digest.length, 64)
  assert.throws(
    () => registry.select({ connectionId: 'Local bridge' }),
    (error: unknown) =>
      error instanceof ConnectionError && error.code === 'INVALID_CONNECTION_SELECTION',
  )
  assert.throws(
    () => registry.select({ connectionId: record.id, expectedKind: 'tangle-sandbox' }),
    (error: unknown) =>
      error instanceof ConnectionError && error.code === 'CONNECTION_KIND_MISMATCH',
  )
  assert.throws(
    () =>
      registry.select({ connectionId: record.id, expectedUpdatedAt: '2026-08-03T12:00:01.000Z' }),
    (error: unknown) =>
      error instanceof ConnectionError && error.code === 'CONNECTION_REVISION_MISMATCH',
  )
  assert.throws(
    () =>
      new ConnectionRegistry([
        connection('cli-bridge', 'secret-url', 'https://bridge.test?token=should-not-persist'),
      ]),
    (error: unknown) =>
      error instanceof ConnectionError && error.code === 'SECRET_IN_CONNECTION_RECORD',
  )
})

test('Tangle inference keeps its saved root while Runtime receives the v1 API root', () => {
  assert.equal(
    normalizeTangleInferenceRuntimeBaseUrl('https://router.tangle.tools'),
    'https://router.tangle.tools/v1',
  )
  assert.equal(
    normalizeTangleInferenceRuntimeBaseUrl('https://router.tangle.tools/v1/'),
    'https://router.tangle.tools/v1',
  )
})

test('journal health can refresh only an unchanged saved connection target', () => {
  const saved = connection('cli-bridge', 'telemetry', 'http://127.0.0.1:4010')
  const observed: ConnectionRecord = {
    ...saved,
    name: 'Stale journal label',
    updatedAt: '2026-08-03T13:00:00.000Z',
    lastHealth: { status: 'healthy', checkedAt: '2026-08-03T13:00:00.000Z' },
  }
  const merged = mergeConnectionTelemetry(saved, observed)
  assert.equal(merged.name, saved.name)
  assert.deepEqual(merged.lastHealth, observed.lastHealth)
  assert.equal(merged.updatedAt, saved.updatedAt)

  const changedTarget = { ...observed, endpoint: 'http://127.0.0.1:4020' }
  assert.equal(mergeConnectionTelemetry(saved, changedTarget), saved)
})

test('health checks are read-only and classify HTTP responses without storing secrets', async () => {
  const requests: Array<{ readonly url: string; readonly authorization?: string }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const authorization = new Headers(init?.headers).get('authorization')
    requests.push({
      url: String(input),
      ...(authorization ? { authorization } : {}),
    })
    return new Response(
      JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
      { status: 200 },
    )
  }
  const bridge = createProductionConnectionAdapter(
    connection('cli-bridge', 'health', 'http://127.0.0.1:4010'),
    { fetch: fetcher, now: () => at },
  )
  assert.deepEqual(await bridge.health(), { status: 'healthy', checkedAt: at })
  assert.equal(requests[0]?.url, 'http://127.0.0.1:4010/health')
  assert.equal(requests[0]?.authorization, undefined)

  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:inference-health')
  await credentials.store({ ref: portRef, value: Buffer.from('health-secret') })
  const inference = createProductionConnectionAdapter(
    connection('tangle-inference', 'unauthorized', 'https://router.test', true),
    {
      credentials,
      credentialRefResolver: () => portRef,
      fetch: async (_input, init) => {
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer health-secret')
        return new Response(null, { status: 401 })
      },
      now: () => at,
    },
  )
  assert.deepEqual(await inference.health(), {
    status: 'unauthorized',
    checkedAt: at,
    message: 'The connection rejected its credential',
  })
})

test('health classification and model verification keep bridge readiness separate', async () => {
  const healthCases = [
    [401, 'unauthorized'],
    [404, 'incompatible'],
    [429, 'rate-limited'],
    [500, 'unreachable'],
  ] as const
  for (const [status, expected] of healthCases) {
    const adapter = createProductionConnectionAdapter(
      connection('cli-bridge', `health-${status}`, 'http://127.0.0.1:4010'),
      {
        fetch: async () => new Response(JSON.stringify({ status: 'ok', backends: [] }), { status }),
        now: () => at,
      },
    )
    assert.equal((await adapter.health()).status, expected)
  }

  const adapter = createProductionConnectionAdapter(
    connection('cli-bridge', 'model-not-configured', 'http://127.0.0.1:4010'),
    {
      fetch: async (input) =>
        String(input).endsWith('/health')
          ? new Response(
              JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }),
              {
                status: 200,
              },
            )
          : new Response(JSON.stringify({ error: { code: 'not_configured' } }), { status: 501 }),
      now: () => at,
    },
  )
  assert.equal((await adapter.health()).status, 'healthy')
  const verification = await adapter.verifyModel?.('openai/gpt-5', {
    now: () => at,
    profile: {
      name: 'Connection test',
      harness: 'pi',
      model: { provider: 'openai', default: 'openai/gpt-5' },
    },
  })
  assert.deepEqual(verification, {
    model: 'openai/gpt-5',
    status: 'not-configured',
    checkedAt: at,
    code: 'not_configured',
    httpStatus: 501,
    message:
      'The bridge advertises openai/gpt-5 but its backend is not configured; sign in to that backend and retry model verification',
  })
})

test('sandbox health uses the published read-only health surface and never creates a sandbox', async () => {
  let creates = 0
  const client = {
    create: async () => {
      creates += 1
      return { id: 'sandbox-test', streamPrompt: async function* () {} }
    },
    fetch: async () => new Response(null, { status: 200 }),
  }
  const adapter = createProductionConnectionAdapter(
    connection('tangle-sandbox', 'health', 'https://sandbox.test'),
    { sandboxClient: client, now: () => at },
  )
  assert.deepEqual(await adapter.health(), { status: 'healthy', checkedAt: at })
  assert.equal(creates, 0)
})

test('capability reports combine published provider capabilities with runtime method support', async () => {
  const publishedCli = createCliBridgeProvider({ baseUrl: 'http://127.0.0.1:4010' })
  const publishedEnvironment = await publishedCli.capabilities()
  const cli = createProductionConnectionAdapter(
    connection('cli-bridge', 'caps', 'http://127.0.0.1:4010'),
  )
  const cliCapabilities = await cli.capabilities()
  assert.deepEqual(cliCapabilities.environment, publishedEnvironment)
  assert.deepEqual(cliCapabilities.runtime.streaming, publishedEnvironment.streaming)
  assert.deepEqual(cliCapabilities.runtime.sessions, publishedEnvironment.sessions)
  assert.equal(cliCapabilities.actions.placement, publishedEnvironment.placement)
  assert.equal(cliCapabilities.actions.usage, publishedEnvironment.usage)
  assert.equal(cliCapabilities.actions.replay, publishedEnvironment.streaming.replay)
  assert.equal(cliCapabilities.actions['continue-session'], publishedEnvironment.sessions.continue)
  assert.equal(cliCapabilities.actions['respond-interaction'], false)
  assert.equal(cliCapabilities.runtime.backend, 'chat')

  const sandbox = createProductionConnectionAdapter(
    connection('tangle-sandbox', 'caps', 'https://sandbox.test'),
  )
  const sandboxCapabilities = await sandbox.capabilities()
  assert.equal(sandboxCapabilities.environment?.branching.fork, false)
  assert.equal(sandboxCapabilities.actions.fork, false)
  assert.equal(sandboxCapabilities.runtime.backend, 'executor')
})

test('the capability document decides whether a route can answer an interaction', async () => {
  const bridgeServer = await startRuntimeBridgeServer()
  try {
    // The Bridge publishes native interactions only for its Pi route, and the
    // runtime executes a response only when the document records every
    // acknowledgement. Braid reads the same fact.
    const pi = createCliBridgeProvider({
      baseUrl: bridgeServer.endpoint,
      defaultModel: 'pi/openai/gpt-5',
    })
    const piDocument = await pi.capabilities()
    assert.deepEqual(piDocument.interactions?.kinds, ['permission'])
    assert.equal(environmentSupportsInteractionResponse(piDocument), true)

    const generic = createCliBridgeProvider({
      baseUrl: bridgeServer.endpoint,
      defaultModel: 'opencode/zai-coding-plan/glm-5.2',
    })
    const genericDocument = await generic.capabilities()
    assert.equal(genericDocument.interactions, undefined)
    assert.equal(environmentSupportsInteractionResponse(genericDocument), false)

    const report = await createProductionConnectionAdapter(
      connection('cli-bridge', 'respond-capability', bridgeServer.endpoint),
    ).capabilities()
    assert.equal(
      report.actions['respond-interaction'],
      environmentSupportsInteractionResponse(report.environment),
    )
  } finally {
    await bridgeServer.close()
  }
})

test('production resolver routes chat connections through agent-runtime', async () => {
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:resolver')
  await credentials.store({ ref: portRef, value: Buffer.from('resolver-secret') })
  const inference = connection('tangle-inference', 'resolver', 'https://router.test', true)
  const registry = new ConnectionRegistry([inference])
  const calls: Array<Record<string, unknown>> = []
  const options: ProductionBackendResolverOptions = {
    connections: registry,
    credentials,
    credentialRefResolver: () => portRef,
    routerComplete: async (body) => {
      calls.push(body)
      return {
        model: 'openai/gpt-5',
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
    },
    select: () => ({ connection: { connectionId: inference.id } }),
  }
  const backend = await createProductionBackendResolver(options)(
    turnInput(profile('openai/gpt-5', 'cli-base')),
  )
  assert.equal(backend.kind, 'prepared-execution')
  assert.deepEqual(backend.cancellation, { kind: 'runtime-executor-teardown' })
  const events = []
  for await (const event of streamAgentTurn(backend.backend, { prompt: 'hello' }))
    events.push(event)
  assert.equal(events.at(-1)?.type, 'final')
  assert.equal(calls[0]?.model, 'gpt-5')
})

test('CLI Bridge and sandbox resolvers expose only supported runtime backend shapes', async () => {
  const bridgeServer = await startRuntimeBridgeServer()
  const bridge = connection('cli-bridge', 'bridge', bridgeServer.endpoint)
  const sandbox = connection('tangle-sandbox', 'sandbox', 'https://sandbox.test', true)
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:sandbox')
  await credentials.store({ ref: portRef, value: Buffer.from('sandbox-secret') })
  let sandboxCreateOptions: Readonly<Record<string, unknown>> | undefined
  const clientFactory = async (_input: SandboxClientFactoryInput) => ({
    create: async (options?: Readonly<Record<string, unknown>>) => {
      sandboxCreateOptions = options
      return {
        id: 'sandbox-test',
        async *streamPrompt() {
          yield { type: 'token', data: { delta: 'hello from sandbox' } }
          yield {
            type: 'done',
            data: {
              outcome: { type: 'completed' },
              status: 'success',
              success: true,
              finalText: 'hello from sandbox',
            },
          }
        },
        async delete() {},
      }
    },
  })
  const options: ProductionBackendResolverOptions = {
    connections: new ConnectionRegistry([bridge, sandbox]),
    credentials,
    credentialRefResolver: () => portRef,
    sandboxClientFactory: clientFactory,
    workspaceCwd: '/tmp/braid-connection-test',
    select: () => ({ connection: { connectionId: bridge.id } }),
  }
  // CLI Bridge execution belongs to the retained port; the ephemeral resolver refuses it.
  await assert.rejects(
    () =>
      resolveProductionBackend(options, turnInput(profile('openai/gpt-5', 'pi')), {
        connection: { connectionId: bridge.id },
      }),
    /owned by CliBridgeRetainedExecutionPort/u,
  )
  const cliBackend = await resolveProductionCliBridgeConnection(options, {
    ...turnInput(profile('openai/gpt-5', 'pi')),
    connectionId: bridge.id,
  })
  assert.equal(cliBackend.materializationReceipt.runner, 'pi')
  assert.equal(cliBackend.materializationReceipt.model, 'openai/gpt-5')
  assert.equal(cliBackend.materializationReceipt.route, 'pi/openai/gpt-5')
  assert.deepEqual(cliBackend.profile, profile('openai/gpt-5', 'pi'))

  const sandboxBackend = await resolveProductionBackend(options, turnInput(profile()), {
    connection: { connectionId: sandbox.id },
  })
  assert.equal(sandboxBackend.kind, 'prepared-execution')
  assert.equal(sandboxBackend.materializationReceipt.runner, 'opencode')
  assert.equal(sandboxBackend.materializationReceipt.model, 'openai/gpt-5')
  assert.equal(Object.hasOwn(sandboxBackend.materializationReceipt, 'idempotencyKey'), false)
  assert.equal(
    sandboxBackend.materializationReceipt.environmentRequestDigest,
    canonicalDigest({
      kind: 'tangle-sandbox-environment-request',
      idempotencyKey: 'env-braid-run-connection-test',
      workspaceRequest: null,
    }),
  )
  assert.deepEqual(sandboxBackend.backend.profile, profile())
  const sandboxEvents = []
  for await (const event of streamAgentTurn(sandboxBackend.backend, { prompt: 'say hello' })) {
    sandboxEvents.push(event)
  }
  const sandboxTerminal = sandboxEvents.at(-1)
  assert.equal(sandboxTerminal?.type, 'final')
  assert.equal(sandboxTerminal?.type === 'final' ? sandboxTerminal.status : undefined, 'completed')
  assert.equal(
    sandboxTerminal?.type === 'final' ? sandboxTerminal.text : undefined,
    'hello from sandbox',
  )
  assert.equal(Object.hasOwn(sandboxCreateOptions ?? {}, 'providerOptions'), false)
  assert.equal(sandboxCreateOptions?.idempotencyKey, 'env-braid-run-connection-test')
  assert.equal(
    (sandboxCreateOptions?.backend as { readonly type?: unknown } | undefined)?.type,
    'opencode',
  )
  assert.deepEqual(
    (sandboxCreateOptions?.backend as { readonly profile?: unknown } | undefined)?.profile,
    profile(),
  )

  await assert.rejects(
    () =>
      resolveProductionBackend(options, turnInput(profile('openai/gpt-4o', 'claude-code')), {
        connection: { connectionId: sandbox.id },
      }),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.code === 'CONNECTION_MODEL_HARNESS_MISMATCH' &&
      /harness=claude-code.*model=openai\/gpt-4o.*not changed/iu.test(error.message),
  )
  await bridgeServer.close()
})

test('sandbox success=false fails closed despite a conflicting success status', async () => {
  const sandbox = connection('tangle-sandbox', 'failed-turn', 'https://sandbox.test', true)
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:sandbox-failed-turn')
  await credentials.store({ ref: portRef, value: Buffer.from('sandbox-secret') })
  let deleted = 0
  const options: ProductionBackendResolverOptions = {
    connections: new ConnectionRegistry([sandbox]),
    credentials,
    credentialRefResolver: () => portRef,
    sandboxClientFactory: async () => ({
      create: async () => ({
        id: 'sandbox-failed-turn',
        async *streamPrompt() {
          yield {
            type: 'llm_call',
            data: { tokensIn: 17, tokensOut: 3, costUsd: 0.004 },
          }
          yield {
            type: 'done',
            data: {
              outcome: { type: 'completed' },
              status: 'success',
              success: false,
              error: 'provider rejected token=do-not-persist',
            },
          }
        },
        async delete() {
          deleted += 1
        },
      }),
    }),
    select: () => ({ connection: { connectionId: sandbox.id } }),
  }
  const input = turnInput(profile())
  const execution = new AgentRuntimeExecutionPort(createProductionBackendResolver(options))
  const events = []
  for await (const event of execution.streamTurn(input)) events.push(event)
  const terminal = events.at(-1)

  assert.equal(terminal?.type, 'final')
  if (terminal?.type !== 'final') assert.fail('missing terminal event')
  assert.equal(terminal.status, 'failed')
  assert.match(terminal.reason, /\[redacted secret\]/u)
  assert.doesNotMatch(terminal.reason, /do-not-persist/u)
  // The runtime carries the provider's raw terminal payload, so the whole
  // event, not only its reason, must be free of the provider secret.
  assert.doesNotMatch(JSON.stringify(terminal), /do-not-persist/u)
  const tokenUsage = terminal.metadata?.tokenUsage as
    | { readonly input?: unknown; readonly output?: unknown }
    | undefined
  assert.equal(tokenUsage?.input, 17)
  assert.equal(tokenUsage?.output, 3)
  assert.equal(terminal.metadata?.costUsd, 0.004)
  assert.equal(deleted, 1)
})

test('ephemeral sandboxes reject interactions that cannot survive cleanup', async (suite) => {
  for (const [status, label] of [
    ['blocked_on_approval', 'approval'],
    ['awaiting_question', 'question'],
    ['awaiting_plan_decision', 'plan decision'],
  ] as const) {
    await suite.test(label, async () => {
      const sandbox = connection(
        'tangle-sandbox',
        `unsupported-${status}`,
        'https://sandbox.test',
        true,
      )
      const credentials = new MemoryCredentialStore()
      const portRef = credentialRef(`cred:v1:sandbox-${status}`)
      await credentials.store({ ref: portRef, value: Buffer.from('sandbox-secret') })
      let deleted = 0
      const options: ProductionBackendResolverOptions = {
        connections: new ConnectionRegistry([sandbox]),
        credentials,
        credentialRefResolver: () => portRef,
        sandboxClientFactory: async () => ({
          create: async () => ({
            id: `sandbox-${status}`,
            async *streamPrompt() {
              if (status === 'blocked_on_approval') {
                yield {
                  type: 'done',
                  data: {
                    outcome: { type: 'completed' },
                    status: 'blocked_on_approval',
                    success: false,
                    toolInvocations: [
                      {
                        toolName: 'github_create_issue',
                        isError: true,
                        result: {
                          code: 'HUB_APPROVAL_REQUIRED',
                          message: 'Hub action requires approval',
                        },
                      },
                    ],
                  },
                }
              } else if (status === 'awaiting_question') {
                yield { type: 'interaction', data: { request: questionRequest() } }
                yield {
                  type: 'done',
                  data: {
                    outcome: { type: 'completed' },
                    finalText: '',
                    status: 'awaiting_question',
                  },
                }
              } else {
                const plan = {
                  id: 'plan-1',
                  revision: 1,
                  body: 'Inspect the workspace',
                  submittedAt: at,
                }
                yield {
                  type: 'done',
                  data: {
                    outcome: { type: 'awaiting_plan_decision', plan },
                    status: 'awaiting_plan_decision',
                    plan,
                  },
                }
              }
            },
            async delete() {
              deleted += 1
            },
          }),
        }),
        select: () => ({ connection: { connectionId: sandbox.id } }),
      }
      const execution = new AgentRuntimeExecutionPort(createProductionBackendResolver(options))
      const input = turnInput(profile())
      const events = []
      for await (const event of execution.streamTurn(input)) events.push(event)
      const terminal = events.at(-1)

      assert.equal(terminal?.type, 'final')
      if (terminal?.type !== 'final') assert.fail('missing terminal event')
      assert.equal(terminal.status, 'failed')
      assert.equal(terminal.reason, BRAID_SANDBOX_INTERACTION_UNSUPPORTED)
      const projected = providerEventFor(input.runId, terminal, {
        eventId: `event-${status}`,
        providerSequence: 1,
      })
      assert.equal(projected.kind, 'run.finished')
      if (projected.kind !== 'run.finished') assert.fail('missing projected terminal event')
      assert.equal(
        projected.reason,
        'Sandbox requested user interaction, but this ephemeral route cannot retain and resume the environment',
      )
      assert.equal(projected.error, BRAID_SANDBOX_INTERACTION_UNSUPPORTED)
      assert.equal(deleted, 1)
    })
  }
})

test('sandbox creation receives the Runtime abort signal', { timeout: 2_000 }, async () => {
  const sandbox = connection('tangle-sandbox', 'create-abort', 'https://sandbox.test', true)
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:sandbox-create-abort')
  await credentials.store({ ref: portRef, value: Buffer.from('sandbox-secret') })
  let createStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    createStarted = resolve
  })
  let createSignal: AbortSignal | undefined
  const options: ProductionBackendResolverOptions = {
    connections: new ConnectionRegistry([sandbox]),
    credentials,
    credentialRefResolver: () => portRef,
    sandboxClientFactory: async () => ({
      create: async (_options, requestOptions) => {
        createSignal = requestOptions?.signal
        createStarted?.()
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException('create aborted', 'AbortError'))
          if (createSignal?.aborted) abort()
          else createSignal?.addEventListener('abort', abort, { once: true })
        })
      },
    }),
    select: () => ({ connection: { connectionId: sandbox.id } }),
  }
  const controller = new AbortController()
  const input = { ...turnInput(profile()), signal: controller.signal }
  const execution = new AgentRuntimeExecutionPort(createProductionBackendResolver(options))
  const eventsPromise = (async () => {
    const events = []
    for await (const event of execution.streamTurn(input)) events.push(event)
    return events
  })()

  await started
  controller.abort(new Error('user stopped startup'))
  const events = await eventsPromise
  const terminal = events.at(-1)
  assert.equal(createSignal?.aborted, true)
  assert.equal(terminal?.type, 'final')
  assert.equal(terminal?.type === 'final' ? terminal.status : undefined, 'aborted')
})

test('CLI Bridge materializes portable models into routes and rejects incompatible runners', async () => {
  const bridgeServer = await startRuntimeBridgeServer()
  const bridge = connection('cli-bridge', 'route', bridgeServer.endpoint)
  const bridgeOptions = (
    selection: { readonly runner?: 'pi' | 'codex'; readonly model?: string } = {},
  ): ProductionBackendResolverOptions => ({
    connections: new ConnectionRegistry([bridge]),
    workspaceCwd: '/tmp/braid-bridge-route',
    select: () => ({ connection: { connectionId: bridge.id }, ...selection }),
  })
  try {
    const prepared = await resolveProductionCliBridgeConnection(
      bridgeOptions({ runner: 'codex', model: 'default' }),
      turnInput(profile('default', 'codex')),
    )
    assert.equal(prepared.materializationReceipt.runner, 'codex')
    assert.equal(prepared.materializationReceipt.model, 'default')
    assert.equal(prepared.route, 'codex/default')
    const priorPiProfile = profile('pi/tangle-router/glm-5.2', 'pi')
    const priorPi = await resolveProductionCliBridgeConnection(
      bridgeOptions(),
      turnInput(priorPiProfile),
    )
    assert.deepEqual(priorPi.profile, priorPiProfile)
    assert.equal(priorPi.materializationReceipt.model, 'pi/tangle-router/glm-5.2')
    const priorCodexProfile = profile('codex/default', 'codex')
    const priorCodex = await resolveProductionCliBridgeConnection(
      bridgeOptions(),
      turnInput(priorCodexProfile),
    )
    assert.deepEqual(priorCodex.profile, priorCodexProfile)
    assert.equal(priorCodex.materializationReceipt.model, 'codex/default')
    await assert.rejects(
      () =>
        resolveProductionCliBridgeConnection(
          bridgeOptions({ runner: 'codex', model: 'codex/default' }),
          turnInput(profile('default', 'codex')),
        ),
      /conflicts with AgentProfile\.model\.default/u,
    )
    await assert.rejects(
      () =>
        resolveProductionCliBridgeConnection(
          bridgeOptions({ runner: 'codex', model: 'zai-coding-plan/glm-5.2' }),
          turnInput(profile('zai-coding-plan/glm-5.2', 'codex')),
        ),
      (error: unknown) =>
        error instanceof ConnectionError &&
        error.code === 'CONNECTION_MODEL_HARNESS_MISMATCH' &&
        /runner=codex.*model=zai-coding-plan\/glm-5\.2.*not changed.*runner=opencode/iu.test(
          error.message,
        ),
    )
  } finally {
    await bridgeServer.close()
  }
})
