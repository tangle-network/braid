import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import test from 'node:test'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { type ExecutorFactory, streamAgentTurn } from '@tangle-network/agent-runtime/kernel'
import { bindCredentialToOrigin } from '../src/adapters/connections/production-connection-credentials.js'
import { createProductionConnectionAdapter } from '../src/adapters/connections/production-connections.js'
import {
  BRAID_TANGLE_CLIENT,
  TANGLE_CLIENT_HEADER,
  withTangleRouterClient,
} from '../src/adapters/connections/tangle-router-client.js'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createProductionBackendResolver } from '../src/adapters/runtime/production-backend-resolver.js'
import { ConnectionRegistry } from '../src/app/connections.js'
import type { ConnectionKind, ConnectionRecord } from '../src/domain/entities.js'
import { createConnectionId, createCredentialRefId } from '../src/domain/ids.js'
import { DEFAULT_EVAL_MODEL, probeEvalRoute, readEvalRouteConfig } from '../src/eval/execution.js'
import { credentialRef } from '../src/ports/credentials.js'

const at = '2026-09-23T12:00:00.000Z'

function packageVersion(): string {
  const document = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { readonly name: string; readonly version: string }
  assert.equal(document.name, '@tangle-network/braid')
  return document.version
}

function connection(kind: ConnectionKind, id: string, endpoint: string): ConnectionRecord {
  return {
    id: createConnectionId(`connection-${id}`),
    kind,
    name: `${kind} attribution connection`,
    endpoint,
    credentialRef: createCredentialRefId(`credential-${id}`),
    providerOptions: { transport: 'https' },
    createdAt: at,
    updatedAt: at,
    lastHealth: { status: 'unknown' },
  }
}

async function storedCredential(id: string, endpoint: string) {
  const credentials = new MemoryCredentialStore()
  const ref = credentialRef(`cred:v1:${id}`)
  await credentials.store({
    ref,
    value: bindCredentialToOrigin(Buffer.from(`${id}-secret`), endpoint),
  })
  return { credentials, credentialRefResolver: () => ref }
}

/** A loopback router that records the headers of every request it receives. */
async function startRecordingRouter(model: string) {
  const requests: Array<{ readonly path: string; readonly headers: IncomingHttpHeaders }> = []
  const server = createServer((request, response) => {
    requests.push({ path: request.url ?? '', headers: request.headers })
    request.resume()
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          model,
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('router has no port')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

test('the client header names Braid and its package version', () => {
  assert.equal(TANGLE_CLIENT_HEADER, 'x-tangle-client')
  assert.equal(BRAID_TANGLE_CLIENT, `braid/${packageVersion()}`)
})

test('tangle-inference turns send the client header through the Runtime Router transport', async () => {
  const router = await startRecordingRouter('gpt-5')
  try {
    const inference = connection('tangle-inference', 'attribution-turn', router.endpoint)
    const backend = await createProductionBackendResolver({
      connections: new ConnectionRegistry([inference]),
      ...(await storedCredential('attribution-turn', router.endpoint)),
      select: () => ({ connection: { connectionId: inference.id } }),
    })({
      operationId: 'operation-attribution',
      runId: 'run-attribution',
      turnId: 'turn-attribution',
      text: 'say hello',
      profile: { model: { default: 'openai/gpt-5', provider: 'openai' }, harness: 'cli-base' },
      signal: new AbortController().signal,
    })
    const events = []
    for await (const event of streamAgentTurn(backend.backend, { prompt: 'hello' }))
      events.push(event)
    assert.equal(events.at(-1)?.type, 'final')
    assert.equal(router.requests.length, 1)
    const [request] = router.requests
    assert.equal(request?.path, '/v1/chat/completions')
    assert.equal(request?.headers[TANGLE_CLIENT_HEADER], BRAID_TANGLE_CLIENT)
    // Runtime's own connection headers still apply beside the client header.
    assert.equal(request?.headers.authorization, 'Bearer attribution-turn-secret')
    assert.equal(typeof request?.headers['idempotency-key'], 'string')
  } finally {
    await router.close()
  }
})

test('the executor wrapper replaces an inherited client header and keeps the rest', () => {
  let received: Readonly<Record<string, string>> | undefined
  const inner: ExecutorFactory<unknown> = (_spec, context) => {
    received = context.propagatedHeaders
    throw new Error('stop after capturing the context')
  }
  const profile: AgentProfile = { model: { default: 'gpt-5', provider: 'openai' } }
  assert.throws(() =>
    withTangleRouterClient(inner)(
      { profile, harness: null },
      {
        signal: new AbortController().signal,
        seams: {},
        propagatedHeaders: { 'X-Tangle-Client': 'someone-else/1.0', traceparent: 'trace-1' },
      },
    ),
  )
  assert.deepEqual(received, {
    traceparent: 'trace-1',
    [TANGLE_CLIENT_HEADER]: BRAID_TANGLE_CLIENT,
  })
})

test('tangle-inference health and model verification identify Braid; CLI Bridge requests do not', async () => {
  const seen: Array<{ readonly url: string; readonly client: string | null }> = []
  const fetcher: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), client: new Headers(init?.headers).get(TANGLE_CLIENT_HEADER) })
    return String(input).endsWith('/health')
      ? new Response(JSON.stringify({ status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }))
      : new Response(JSON.stringify({ model: 'gpt-5', choices: [{ message: { content: 'OK' } }] }))
  }
  const inference = createProductionConnectionAdapter(
    connection('tangle-inference', 'attribution-health', 'https://router.test/v1'),
    {
      ...(await storedCredential('attribution-health', 'https://router.test')),
      fetch: fetcher,
      now: () => at,
    },
  )
  await inference.health()
  await inference.verifyModel?.('gpt-5', { now: () => at })
  assert.deepEqual(seen, [
    { url: 'https://router.test/v1/health', client: BRAID_TANGLE_CLIENT },
    { url: 'https://router.test/v1/chat/completions', client: BRAID_TANGLE_CLIENT },
  ])

  seen.length = 0
  const bridge = createProductionConnectionAdapter(
    connection('cli-bridge', 'attribution-bridge', 'http://127.0.0.1:4010'),
    {
      ...(await storedCredential('attribution-bridge', 'http://127.0.0.1:4010')),
      fetch: fetcher,
      now: () => at,
    },
  )
  await bridge.health()
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.client, null)
})

test('the semantic eval route probe identifies Braid on its router requests', async () => {
  const seen: Array<string | null> = []
  const probe = await probeEvalRoute(
    readEvalRouteConfig({ BRAID_EVAL_API_KEY: 'attribution-key' }),
    async (input, init) => {
      const headers = new Headers(init?.headers)
      seen.push(headers.get(TANGLE_CLIENT_HEADER))
      assert.equal(headers.get('authorization'), 'Bearer attribution-key')
      assert.equal(String(input), 'https://router.tangle.tools/v1/models')
      return new Response(JSON.stringify({ data: [{ id: DEFAULT_EVAL_MODEL }] }))
    },
  )
  assert.equal(probe.status, 'ready')
  assert.deepEqual(seen, [BRAID_TANGLE_CLIENT])
})
