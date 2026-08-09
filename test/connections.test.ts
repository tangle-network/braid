import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { createCliBridgeProvider } from '@tangle-network/agent-provider-cli-bridge'
import { createTangleProvider } from '@tangle-network/agent-provider-tangle'
import { streamAgentTurn } from '@tangle-network/agent-runtime/kernel'
import {
  createProductionConnectionAdapter,
  type SandboxClientFactoryInput,
} from '../src/adapters/connections/production-connections.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import {
  createProductionBackendResolver,
  type ProductionBackendResolverOptions,
  resolveProductionBackend,
} from '../src/adapters/runtime/production-backend-resolver.js'
import { ConnectionError } from '../src/app/connection-errors.js'
import { ConnectionRegistry, mergeConnectionTelemetry } from '../src/app/connections.js'
import type { ConnectionKind, ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { credentialRef } from '../src/ports/credentials.js'
import type { ExecuteTurnInput } from '../src/ports/execution.js'

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
  return { model: { default: model }, harness }
}

function turnInput(profileValue: AgentProfile): ExecuteTurnInput {
  return {
    operationId: 'operation-connection-test',
    runId: 'run-connection-test',
    text: 'say hello',
    profile: profileValue,
    signal: new AbortController().signal,
  }
}

function responseStream(text = 'hello'): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
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
  const verification = await adapter.verifyModel?.('openai/gpt-5', { now: () => at })
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
  assert.equal(cliCapabilities.providerMethods.respondToInteraction, false)
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

test('upstream reproduction: published providers expose no interaction response channel', async () => {
  const cli = createCliBridgeProvider({ baseUrl: 'http://127.0.0.1:4010' })
  const cliEnvironment = await cli.create({ profile: {} })
  assert.equal('respondToInteraction' in cliEnvironment, false)

  const tangle = createTangleProvider({
    client: {
      create: async () => ({ id: 'sandbox-test', streamPrompt: async function* () {} }),
    },
  })
  const tangleEnvironment = await tangle.create({ profile: {} })
  assert.equal('respondToInteraction' in tangleEnvironment, false)
})

test('production resolver routes chat connections through agent-runtime', async () => {
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:resolver')
  await credentials.store({ ref: portRef, value: Buffer.from('resolver-secret') })
  const inference = connection('tangle-inference', 'resolver', 'https://router.test', true)
  const registry = new ConnectionRegistry([inference])
  const calls: Array<{ readonly url: string; readonly body: string }> = []
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: String(init?.body) })
    return responseStream()
  }
  const options: ProductionBackendResolverOptions = {
    connections: registry,
    credentials,
    credentialRefResolver: () => portRef,
    fetch: fetcher,
    select: () => ({ connection: { connectionId: inference.id } }),
  }
  const backend = await createProductionBackendResolver(options)(turnInput(profile()))
  assert.equal(backend.kind, 'chat')
  if (backend.kind !== 'chat') return
  const events = []
  for await (const event of streamAgentTurn(backend, 'hello')) events.push(event)
  assert.equal(events.at(-1)?.type, 'final')
  assert.equal(calls[0]?.url, 'https://router.test/chat/completions')
  assert.match(calls[0]?.body ?? '', /"model":"openai\/gpt-5"/u)
})

test('CLI Bridge and sandbox resolvers expose only supported runtime backend shapes', async () => {
  const bridge = connection('cli-bridge', 'bridge', 'http://127.0.0.1:4010')
  const sandbox = connection('tangle-sandbox', 'sandbox', 'https://sandbox.test', true)
  const credentials = new MemoryCredentialStore()
  const portRef = credentialRef('cred:v1:sandbox')
  await credentials.store({ ref: portRef, value: Buffer.from('sandbox-secret') })
  const clientFactory = async (_input: SandboxClientFactoryInput) => ({
    create: async () => ({ id: 'sandbox-test', streamPrompt: async function* () {} }),
  })
  const options: ProductionBackendResolverOptions = {
    connections: new ConnectionRegistry([bridge, sandbox]),
    credentials,
    credentialRefResolver: () => portRef,
    sandboxClientFactory: clientFactory,
    workspaceCwd: '/tmp/braid-connection-test',
    select: () => ({ connection: { connectionId: bridge.id } }),
  }
  const cliBackend = await resolveProductionBackend(
    options,
    turnInput(profile('openai/gpt-5', 'pi')),
    {
      connection: { connectionId: bridge.id },
    },
  )
  assert.equal(cliBackend.kind, 'sandbox-plan')
  if (cliBackend.kind === 'sandbox-plan') {
    assert.equal(cliBackend.createInput.backend, 'pi')
    assert.deepEqual(cliBackend.createInput.profile, profile('openai/gpt-5', 'pi'))
    assert.equal(cliBackend.turnOptions.model, 'pi/openai/gpt-5')
    assert.equal('timeoutMs' in cliBackend.turnOptions, false)
  }

  const sandboxBackend = await resolveProductionBackend(options, turnInput(profile()), {
    connection: { connectionId: sandbox.id },
  })
  assert.equal(sandboxBackend.kind, 'sandbox-plan')
  if (sandboxBackend.kind === 'sandbox-plan') {
    assert.equal(sandboxBackend.createInput.backend, 'opencode')
    assert.equal(sandboxBackend.turnOptions.model, 'openai/gpt-5')
  }

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
})

test('CLI Bridge materializes portable models into routes and rejects incompatible runners', async () => {
  const bridge = connection('cli-bridge', 'route', 'http://127.0.0.1:4010')
  const options: ProductionBackendResolverOptions = {
    connections: new ConnectionRegistry([bridge]),
    workspaceCwd: '/tmp/braid-bridge-route',
    select: () => ({ connection: { connectionId: bridge.id } }),
  }
  const prepared = await resolveProductionBackend(options, turnInput(profile('default', 'codex')), {
    connection: { connectionId: bridge.id },
    runner: 'codex',
    model: 'default',
  })
  assert.equal(prepared.kind, 'sandbox-plan')
  if (prepared.kind === 'sandbox-plan') {
    assert.equal(prepared.createInput.backend, 'codex')
    assert.equal(prepared.turnOptions.model, 'codex/default')
  }
  const priorPiProfile = profile('pi/tangle-router/glm-5.2', 'pi')
  const priorPi = await resolveProductionBackend(options, turnInput(priorPiProfile), {
    connection: { connectionId: bridge.id },
  })
  assert.equal(priorPi.kind, 'sandbox-plan')
  if (priorPi.kind === 'sandbox-plan') {
    assert.deepEqual(priorPi.createInput.profile, priorPiProfile)
    assert.equal(priorPi.turnOptions.model, 'pi/tangle-router/glm-5.2')
  }
  const priorCodexProfile = profile('codex/default', 'codex')
  const priorCodex = await resolveProductionBackend(options, turnInput(priorCodexProfile), {
    connection: { connectionId: bridge.id },
  })
  assert.equal(priorCodex.kind, 'sandbox-plan')
  if (priorCodex.kind === 'sandbox-plan') {
    assert.deepEqual(priorCodex.createInput.profile, priorCodexProfile)
    assert.equal(priorCodex.turnOptions.model, 'codex/default')
  }
  const priorOverride = await resolveProductionBackend(
    options,
    turnInput(profile('default', 'codex')),
    {
      connection: { connectionId: bridge.id },
      runner: 'codex',
      model: 'codex/default',
    },
  )
  assert.equal(priorOverride.kind, 'sandbox-plan')
  if (priorOverride.kind === 'sandbox-plan')
    assert.equal(priorOverride.turnOptions.model, 'codex/default')
  await assert.rejects(
    () =>
      resolveProductionBackend(options, turnInput(profile('zai-coding-plan/glm-5.2', 'codex')), {
        connection: { connectionId: bridge.id },
        runner: 'codex',
        model: 'zai-coding-plan/glm-5.2',
      }),
    (error: unknown) =>
      error instanceof ConnectionError &&
      error.code === 'CONNECTION_MODEL_HARNESS_MISMATCH' &&
      /runner=codex.*model=zai-coding-plan\/glm-5\.2.*not changed.*runner=opencode/iu.test(
        error.message,
      ),
  )
})
