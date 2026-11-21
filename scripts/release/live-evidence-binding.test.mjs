import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertProofReceipt,
  PROOF_OPERATIONS,
  proofReceipt,
  tangleReceiptsArtifact,
} from '../live-required/contracts.mjs'
import { prepareReleaseSandboxWorkspace, resolveBinary } from '../live-required/headless.mjs'
import { runInference } from '../live-required/tangle.mjs'
import { runtimeModuleRoot } from '../live-required/tangle-workspace-proof.mjs'
import {
  assertLiveEvidenceBinding,
  liveEvidenceBinding,
  serializedLiveEvidenceBinding,
} from './live-evidence-binding.mjs'
import { assertTangleReceipts } from './live-tangle-proof.mjs'

const repository = fileURLToPath(new URL('../../', import.meta.url))

test('LIVE-06 runs its exact selected Router route and rejects unpriced or substituted evidence', async (t) => {
  const model = 'google/gemma-4-31b-it:free'
  const row = {
    id: model,
    pricing_source: 'provider_price_version',
    pricing: { prompt: '0', completion: '0', input_cache_read: '0', input_cache_write: '0' },
    routeability: {
      provider: 'openrouter',
      mode: 'system',
      via: 'openrouter',
      routeable: true,
      endpoints: { chat_completions: { routeable: true } },
    },
  }
  let catalog = [row]
  let servedModel
  let ignoreStreaming = false
  const requests = []
  const posts = []
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      client: request.headers['x-tangle-client'],
    })
    if (request.headers.authorization !== 'Bearer release-test-key') {
      response.writeHead(401).end()
      return
    }
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: catalog }))
      return
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    let body = ''
    for await (const bytes of request) body += bytes
    const parsed = JSON.parse(body)
    posts.push(parsed)
    const responseModel = servedModel ?? parsed.model
    const usage = { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21, cost: 0 }
    const content = 'LIVE_BRAID_TANGLE_INFERENCE_OK'
    if (parsed.stream && !ignoreStreaming) {
      response.setHeader('content-type', 'text/event-stream')
      for (const part of ['LIVE_BRAID_', 'TANGLE_INFERENCE_OK']) {
        response.write(
          `data: ${JSON.stringify({ model: responseModel, choices: [{ index: 0, delta: { content: part } }] })}\n\n`,
        )
      }
      response.end(
        `data: ${JSON.stringify({ model: responseModel, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`,
      )
    } else {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          model: responseModel,
          choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage,
        }),
      )
    }
  })
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  )
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      }),
  )
  const binary = await resolveBinary(repository, {})
  const environment = {
    BRAID_TANGLE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1`,
    BRAID_TANGLE_API_KEY: 'release-test-key',
    BRAID_TANGLE_INFERENCE_MODEL: 'glm-5.3',
  }
  const run = () =>
    runInference({ repository, binary, environment, invocationId: 'live-required-router-path' })
  const legacy = await run()
  assert.equal(legacy.evidence.observations.router.provider, 'zai')
  assert.deepEqual(posts[0].providerOptions.gateway, { only: ['zai'], allowFallbacks: false })
  assert.equal(posts[0].require_model, true)
  assert.equal(posts[0].model, 'glm-5.3')
  environment.BRAID_TANGLE_MODEL = model
  const free = await run()
  assert.equal(free.evidence.connection.model, model)
  assert.deepEqual(free.evidence.observations.router.catalog.pricing, row.pricing)
  assert.equal(free.evidence.observations.completion.input, 17)
  assert.equal(free.evidence.observations.completion.output, 4)
  assert.ok(
    requests.some(({ path, client }) => path === '/v1/models' && client?.startsWith('braid/')),
  )
  for (const request of posts.filter((body) => body.model === model)) {
    assert.equal(request.require_model, true)
    assert.deepEqual(request.providerOptions.gateway, {
      only: ['openrouter'],
      allowFallbacks: false,
    })
  }
  const accepted = posts.length
  assert.ok(accepted > 0)
  assert.ok(
    posts.every(
      (request) => request.stream === true && request.stream_options?.include_usage === true,
    ),
  )
  for (const bad of [
    [],
    [row, row],
    [{ ...row, id: model.replace(':free', '') }],
    [{ ...row, routeability: { ...row.routeability, mode: 'byok' } }],
    [{ ...row, pricing_source: 'openrouter' }],
    [{ ...row, pricing: { prompt: '0', completion: '0' } }],
    [{ ...row, pricing: { ...row.pricing, input_cache_write: '1e-999' } }],
    [{ ...row, pricing: { ...row.pricing, request: '0.0001' } }],
  ]) {
    catalog = bad
    await assert.rejects(run, /exactly one matching free model|published zero rates/u)
  }
  assert.equal(posts.length, accepted)
  catalog = [row]
  servedModel = 'substitute/paid-model'
  await assert.rejects(run, /RUNTIME_FINAL_ERROR|exact recorded model/u)
  servedModel = undefined
  ignoreStreaming = true
  await assert.rejects(run, /RUNTIME_FINAL_ERROR/u)
  t.diagnostic(
    `Recorded ${accepted} accepted-lane request(s), ${posts.slice(0, accepted).filter((request) => request.stream === true).length} requested streaming; all unqualified catalogs issued zero inference requests.`,
  )
  const substituted = structuredClone(free.evidence)
  substituted.observations.router.provider = 'zai'
  assert.throws(() => assertProofReceipt(substituted), /exact model and provider/u)
  const paid = structuredClone(free.evidence)
  paid.observations.completion.billedUsd = 0.01
  assert.throws(() => assertProofReceipt(paid), /reported charge/u)
})

test('protected Sandbox profiles retain each native harness and put only the stored plan reference on its connection', async () => {
  const descriptor = { apiKeyEnv: 'RELEASE_PLAN', baseUrl: 'https://api.z.ai/api/coding/paas/v4' }
  for (const [runner, provider] of [
    ['opencode', 'zai-coding-plan'],
    ['pi', 'zai'],
  ]) {
    const config = await prepareReleaseSandboxWorkspace({
      repository,
      environment: { BRAID_TANGLE_SANDBOX_MODEL_CREDENTIALS: JSON.stringify(descriptor) },
      kind: 'tangle-sandbox',
      endpoint: 'https://sandbox.example',
      runner,
      model: 'glm-5.3',
      modelProvider: 'tangle-router',
      providerOptions: {
        lifecycle: 'retained',
      },
    })
    try {
      const { loadProductionStartup } = await import('../../dist/bin/production-startup.js')
      const startup = await loadProductionStartup({
        workspace: config.workspace,
        configPath: config.configPath,
        databaseKeyFile: config.databaseKeyFile,
        dataDirectory: config.dataDirectory,
      })
      const connection = startup.connections.find(
        (candidate) => candidate.id === startup.connectionId,
      )
      assert.deepEqual(connection.providerOptions.modelCredentials, descriptor)
      assert.equal(connection.providerOptions.routing, undefined)
      assert.equal(startup.profile.harness, runner)
      assert.equal(startup.profile.model.default, 'glm-5.3')
      assert.equal(startup.profile.model.provider, provider)
      assert.equal(startup.profile.model.metadata.credentialSource, 'subscription')
    } finally {
      await config.cleanup()
    }
  }
})

const identity = {
  braidVersion: '0.3.0',
  gitCommit: 'a'.repeat(40),
  tarballSha256: 'b'.repeat(64),
  packageIntegrity: `sha512-${'A'.repeat(88)}`,
  dependencyDigest: 'c'.repeat(64),
  dependencies: [
    {
      name: '@tangle-network/agent-runtime',
      version: '0.185.2',
      integrity: `sha512-${'B'.repeat(88)}`,
    },
  ],
}

function receipt(environment) {
  return proofReceipt({
    invocationId: 'live-required-test-invocation',
    operation: PROOF_OPERATIONS.tangleInference,
    startedAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-01T00:00:01.000Z',
    runIds: ['run-1', 'run-2'],
    facts: {
      normalRunId: 'run-1',
      cancelledRunId: 'run-2',
      cancellationStatus: 'confirmed',
      cancellationResponseCode: null,
    },
    checks: ['normal-turn', 'cancelled-turn', 'materialization-receipt'],
    observations: { provider: 'real' },
    environment,
  })
}

test('proof receipts accept the exact candidate binding and reject a stale Runtime version', () => {
  const environment = {
    BRAID_RELEASE_LIVE_EVIDENCE_BINDING: serializedLiveEvidenceBinding(identity),
  }
  const bound = receipt(environment)
  assert.equal(bound.releaseBinding.runtimeVersion, '0.185.2')
  assert.doesNotThrow(() => assertProofReceipt(bound))

  assert.throws(
    () =>
      assertLiveEvidenceBinding(
        {
          ...bound.releaseBinding,
          runtimeVersion: '0.185.1',
        },
        identity,
        'LIVE-10 evidence',
      ),
    /differs/u,
  )
})

test('proof receipts without a release binding remain valid outside collection', () => {
  const unbound = receipt({})
  assert.equal(Object.hasOwn(unbound, 'releaseBinding'), false)
  assert.doesNotThrow(() => assertProofReceipt(unbound))
  assert.deepEqual(
    liveEvidenceBinding(identity),
    JSON.parse(serializedLiveEvidenceBinding(identity)),
  )
})

test('candidate-bound workspace proofs reject source Runtime modules and stale aggregate rows', () => {
  const environment = {
    BRAID_RELEASE_LIVE_EVIDENCE_BINDING: serializedLiveEvidenceBinding(identity),
  }
  assert.throws(
    () => runtimeModuleRoot('/work/braid', environment),
    (error) => error.code === 'BRAID_PACKED_PACKAGE_REQUIRED',
  )
  for (const sourcePath of ['/work/braid/dist', '/work/braid/other']) {
    assert.throws(
      () =>
        runtimeModuleRoot('/work/braid', { ...environment, BRAID_LIVE_PACKAGE_ROOT: sourcePath }),
      (error) => error.code === 'BRAID_PACKED_PACKAGE_REQUIRED',
    )
  }
  const packageRoot = '/tmp/braid-install/node_modules/@tangle-network/braid'
  assert.equal(
    runtimeModuleRoot('/work/braid', { ...environment, BRAID_LIVE_PACKAGE_ROOT: packageRoot }),
    `${packageRoot}/dist`,
  )

  const evidence = receipt(environment)
  const aggregate = tangleReceiptsArtifact([
    { row: 'LIVE-06', status: 'passed', evidence },
    ...['LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10'].map((row) => ({
      row,
      status: 'unavailable',
      reason: 'fixture row not exercised',
    })),
  ])
  assert.doesNotThrow(() => assertTangleReceipts(aggregate, identity))
  const stale = structuredClone(aggregate)
  stale.flows.find(({ row }) => row === 'LIVE-06').evidence.releaseBinding.runtimeVersion =
    '0.185.1'
  assert.throws(() => assertTangleReceipts(stale, identity), /differs/u)
})
