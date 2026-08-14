import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  bridgeLaunchEnvironment,
  bridgeSourceDirectory,
  discoverBridge,
  releaseTargetDefinitions,
  selectBridgeTargets,
} from './bridge.mjs'
import { createLiveCredentialId, profileForBridgeTarget, writeTargetConfig } from './config.mjs'
import { runAdversarialMatrix } from './matrix-adversarial.mjs'
import {
  assertSemanticOutcome,
  cancelSemanticStatus,
  capabilityAvailability,
  exactMarker,
  interactionFromResponse,
  semanticCommandStatus,
} from './protocol.mjs'
import { executeReleaseProofs } from './release-proofs.mjs'
import { verifyCancel } from './target-actions.mjs'
import { defaultTargetPolicy, readTargetPolicy, targetPolicyEvidence } from './target-policy.mjs'

async function withFakeBridge(
  models,
  backends,
  callback,
  {
    modelsStatus = 200,
    capabilities = {
      profileMaterialization: 'cli-bridge.profile-materialization.v2',
      usageCostProvenance: 'cli-bridge.usage-cost.v1',
    },
  } = {},
) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ name: 'cli-bridge', capabilities }))
      return
    }
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', backends }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(modelsStatus, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }))
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake bridge did not expose a port')
  try {
    return await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function runTargetPolicyMatrix() {
  const both = defaultTargetPolicy.definitions
  const exactGlm = both[0].modelId
  const exactPiGlm = both[1].modelId
  const readyBackends = [
    { name: 'opencode', state: 'ready' },
    { name: 'pi', state: 'ready' },
    { name: 'claude-code', state: 'starting' },
  ]
  await withFakeBridge([exactGlm, exactPiGlm], readyBackends, async (endpoint) => {
    const evidence = {}
    const result = await discoverBridge(endpoint, undefined, evidence, process.cwd(), both)
    assert.deepEqual(
      result.selected.map(({ modelId }) => modelId),
      [exactGlm, exactPiGlm],
    )
  })
  await withFakeBridge([exactGlm], readyBackends, async (endpoint) => {
    const evidence = {}
    await assert.rejects(
      discoverBridge(endpoint, undefined, evidence, process.cwd(), both),
      (error) => error.code === 'TARGET_MODEL_NOT_ADVERTISED' && error.exitCode === 2,
    )
    assert.deepEqual(
      evidence.missingTargets.map(({ modelId }) => modelId),
      [exactPiGlm],
    )
  })
  await withFakeBridge(
    [exactGlm],
    readyBackends,
    async (endpoint) => {
      const evidence = {}
      await assert.rejects(
        discoverBridge(endpoint, undefined, evidence, process.cwd(), both),
        (error) => error.code === 'BRIDGE_MODEL_DISCOVERY_FAILED' && error.exitCode === 1,
      )
    },
    { modelsStatus: 503 },
  )
  await withFakeBridge(
    [exactGlm, exactPiGlm],
    readyBackends,
    async (endpoint) => {
      const evidence = {}
      await assert.rejects(
        discoverBridge(endpoint, undefined, evidence, process.cwd(), both),
        (error) => error.code === 'BRIDGE_RUNTIME_CONTRACT_UNAVAILABLE' && error.exitCode === 2,
      )
    },
    { capabilities: {} },
  )
  await withFakeBridge([exactPiGlm], readyBackends, async (endpoint) => {
    const evidence = {}
    await assert.rejects(
      discoverBridge(endpoint, undefined, evidence, process.cwd(), both),
      (error) => error.code === 'TARGET_MODEL_NOT_ADVERTISED' && error.exitCode === 2,
    )
    assert.deepEqual(
      evidence.missingTargets.map(({ modelId }) => modelId),
      [exactGlm],
    )
  })
  await withFakeBridge(
    [exactGlm, exactPiGlm],
    [{ name: 'opencode', state: 'ready' }],
    async (endpoint) => {
      const evidence = {}
      await assert.rejects(
        discoverBridge(endpoint, undefined, evidence, process.cwd(), both),
        (error) => error.code === 'TARGET_BACKEND_NOT_READY' && error.exitCode === 2,
      )
    },
  )
  const pilot = readTargetPolicy('glm-5.2')
  assert.deepEqual(targetPolicyEvidence(pilot).required, [
    { key: 'glm-5.2', label: 'GLM 5.2', modelId: exactGlm, backend: 'opencode' },
  ])
  await withFakeBridge([exactGlm], readyBackends, async (endpoint) => {
    const evidence = {}
    const result = await discoverBridge(
      endpoint,
      undefined,
      evidence,
      process.cwd(),
      pilot.definitions,
    )
    assert.deepEqual(
      result.selected.map(({ modelId }) => modelId),
      [exactGlm],
    )
  })

  const releaseHealth = {
    ok: true,
    status: 200,
    body: {
      status: 'ok',
      backends: [
        { name: 'opencode', state: 'ready' },
        { name: 'pi', state: 'ready' },
        { name: 'codex', state: 'ready' },
      ],
    },
  }
  const releaseModels = {
    ok: true,
    body: {
      data: [{ id: exactGlm }, { id: exactPiGlm }, { id: 'codex/default' }],
    },
  }
  const releaseDefinitions = releaseTargetDefinitions(both, releaseModels, releaseHealth)
  assert.deepEqual(
    releaseDefinitions.map(({ modelId }) => modelId),
    [exactGlm, exactPiGlm, 'codex/default'],
  )
  assert.equal(releaseDefinitions[2].bridgeModelId, 'codex/default')
  const releaseEvidence = {}
  const releaseTargets = selectBridgeTargets(
    releaseDefinitions,
    releaseModels,
    releaseHealth,
    releaseEvidence,
  )
  assert.deepEqual(
    releaseTargets.map(({ modelId, bridgeModelId }) => ({ modelId, bridgeModelId })),
    [
      { modelId: exactGlm, bridgeModelId: exactGlm },
      { modelId: exactPiGlm, bridgeModelId: exactPiGlm },
      { modelId: 'codex/default', bridgeModelId: 'codex/default' },
    ],
  )
}

async function runConfigurationMatrix() {
  const [glm, piGlm] = defaultTargetPolicy.definitions
  assert.deepEqual(profileForBridgeTarget(glm), {
    name: `Braid live ${glm.modelId}`,
    description: 'Opt-in packed CLI Bridge smoke profile',
    version: '0.1.0',
    harness: 'opencode',
    model: { provider: 'zai-coding-plan', default: 'glm-5.2', reasoningEffort: 'none' },
  })
  assert.deepEqual(profileForBridgeTarget(piGlm), {
    name: `Braid live ${piGlm.modelId}`,
    description: 'Opt-in packed CLI Bridge smoke profile',
    version: '0.1.0',
    harness: 'pi',
    model: {
      provider: 'tangle-router',
      default: 'glm-5.2',
      reasoningEffort: 'none',
    },
  })
  assert.deepEqual(
    profileForBridgeTarget({
      key: 'codex-default',
      label: 'codex default',
      modelId: 'codex/default',
      backend: 'codex',
    }),
    {
      name: 'Braid live codex/default',
      description: 'Opt-in packed CLI Bridge smoke profile',
      version: '0.1.0',
      harness: 'codex',
      model: { default: 'default', reasoningEffort: 'none' },
    },
  )
  assert.throws(
    () => profileForBridgeTarget({ ...piGlm, backend: 'codex' }),
    (error) => error.code === 'TARGET_MODEL_ROUTE_INVALID' && error.exitCode === 2,
  )
  assert.match(createLiveCredentialId('00000000-0000-0000-0000-000000000000'), /^credential-/u)

  const endpoint = 'http://127.0.0.1:4567'
  const linuxEnvironment = bridgeLaunchEnvironment([piGlm], endpoint, {
    environment: { PATH: '/usr/bin' },
    platform: 'linux',
  })
  assert.equal(linuxEnvironment.BRIDGE_BACKENDS, 'pi')
  assert.equal(linuxEnvironment.BRIDGE_JAIL_MODE, 'fs-jail')
  assert.equal(linuxEnvironment.BRIDGE_PORT, '4567')
  assert.equal(
    bridgeLaunchEnvironment([piGlm], endpoint, {
      environment: { BRIDGE_JAIL_MODE: 'off' },
      platform: 'linux',
    }).BRIDGE_JAIL_MODE,
    'off',
  )
  assert.equal(
    bridgeLaunchEnvironment([piGlm], endpoint, {
      environment: {},
      platform: 'darwin',
    }).BRIDGE_JAIL_MODE,
    undefined,
  )
  assert.equal(
    bridgeSourceDirectory('/workspace/braid'),
    resolve('/workspace/braid', '..', 'cli-bridge'),
  )
  assert.equal(
    bridgeSourceDirectory('/workspace/braid', '/opt/cli-bridge'),
    resolve('/opt/cli-bridge'),
  )

  const root = await mkdtemp(join(tmpdir(), 'braid-live-config-matrix-'))
  try {
    const written = await writeTargetConfig(root, endpoint, piGlm, undefined)
    assert.deepEqual(JSON.parse(await readFile(written.profilePath, 'utf8')), written.profile)
    assert.equal(written.profile.model.default, 'glm-5.2')
    assert.equal(written.profile.model.provider, 'tangle-router')
    const credential = await writeTargetConfig(root, endpoint, glm, {
      recordRef: createLiveCredentialId('11111111-1111-1111-1111-111111111111'),
    })
    const document = JSON.parse(await readFile(credential.configPath, 'utf8'))
    assert.match(document.connections[0].credentialRef, /^credential-/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function runSemanticMatrix() {
  assert.deepEqual(capabilityAvailability(true, false), {
    advertisedByProvider: true,
    advertised: false,
  })
  assert.deepEqual(capabilityAvailability(false, { available: true }), {
    advertisedByProvider: false,
    advertised: true,
  })
  for (const name of ['reconnect', 'cancel', 'interaction']) {
    assert.doesNotThrow(() => assertSemanticOutcome(name, 'verified', true))
    assert.doesNotThrow(() => assertSemanticOutcome(name, 'reported-unavailable', false))
    for (const [status, advertised] of [
      ['unexpected', false],
      ['advertised-but-rejected', true],
      ['advertised-but-not-terminal-cancelled', true],
    ]) {
      assert.throws(
        () => assertSemanticOutcome(name, status, advertised),
        (error) => error.code === 'LIVE_CAPABILITY_CONTRADICTION' && error.exitCode === 1,
      )
    }
  }
  assert.equal(semanticCommandStatus({ type: 'ack' }, true), 'verified')
  assert.equal(semanticCommandStatus({ type: 'error' }, true), 'advertised-but-rejected')
  assert.equal(
    semanticCommandStatus({ type: 'error', code: 'CAPABILITY_UNAVAILABLE' }, false),
    'reported-unavailable',
  )
  assert.equal(semanticCommandStatus({ type: 'ack' }, false), 'unexpected')
  assert.equal(cancelSemanticStatus({ type: 'ack' }, { status: 'aborted' }, true), 'verified')
  assert.equal(
    cancelSemanticStatus({ type: 'error' }, { status: 'aborted' }, true),
    'advertised-but-rejected',
  )
  assert.equal(
    cancelSemanticStatus({ type: 'ack' }, { status: 'running' }, true),
    'advertised-but-not-terminal-cancelled',
  )
  assert.equal(
    cancelSemanticStatus({ type: 'error', code: 'CAPABILITY_UNAVAILABLE' }, undefined, false),
    'reported-unavailable',
  )
  assert.equal(exactMarker(' LIVE_BRAID_GLM_5_2_OK\n', 'LIVE_BRAID_GLM_5_2_OK'), true)
  assert.equal(exactMarker('LIVE_BRAID_GLM_5_2_OK extra', 'LIVE_BRAID_GLM_5_2_OK'), false)
  const interactionRequest = { id: 'interaction-live', kind: 'permission' }
  assert.deepEqual(
    interactionFromResponse(
      {
        type: 'event',
        event: { kind: 'run.interaction', runId: 'run-live', request: interactionRequest },
      },
      'run-live',
    ),
    { runId: 'run-live', interactionId: 'interaction-live', request: interactionRequest },
  )
  assert.equal(
    interactionFromResponse(
      { type: 'event', event: { kind: 'run.interaction', runId: 'other-run' } },
      'run-live',
    ),
    undefined,
  )

  const emptyRelease = await executeReleaseProofs({ targets: [], targetRecords: [] })
  assert.equal(emptyRelease.passed, false)
  assert.deepEqual(emptyRelease.releaseProofs, [])
  assert.equal(emptyRelease.failures.length, 5)

  const requests = []
  const unavailableSession = {
    send: (request) => requests.push(request),
    waitFor: async () => ({
      version: 1,
      type: 'error',
      requestId: 'cancel-glm-5.2',
      code: 'CAPABILITY_UNAVAILABLE',
      message: 'Cancellation is unavailable',
      retryable: false,
    }),
  }
  const unavailableResult = { targetKey: 'glm-5.2', requests: [] }
  await verifyCancel(
    unavailableSession,
    unavailableResult,
    defaultTargetPolicy.definitions[0],
    {
      id: 'run-complete',
      status: 'completed',
      capabilities: { controls: { cancel: false } },
    },
    { controls: { cancel: false } },
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0].command, 'cancel_run')
  assert.equal(requests[0].params.runId, 'run-complete')
  assert.equal(unavailableResult.cancel.attemptedRun, false)
  assert.equal(unavailableResult.cancel.status, 'reported-unavailable')

  const admittedRequests = []
  const admittedResponses = [
    {
      version: 1,
      type: 'ack',
      requestId: 'cancel-send-glm-5.2',
      runId: 'run-cancel-live',
      admission: { capabilities: { controls: { cancel: true } } },
    },
    {
      version: 1,
      type: 'state',
      state: { runs: [{ id: 'run-cancel-live', status: 'streaming' }] },
    },
    {
      version: 1,
      type: 'ack',
      requestId: 'cancel-glm-5.2',
    },
    {
      version: 1,
      type: 'state',
      requestId: 'cancel-glm-5.2',
      state: { runs: [{ id: 'run-cancel-live', status: 'aborted' }] },
    },
  ]
  const admittedSession = {
    send: (request) => admittedRequests.push(request),
    waitFor: async () => admittedResponses.shift(),
  }
  const admittedResult = {
    targetKey: 'glm-5.2',
    requests: [],
    send: { admission: { capabilities: { controls: { cancel: true } } } },
    conversationId: 'conv-live',
    branchId: 'branch-live',
  }
  await verifyCancel(
    admittedSession,
    admittedResult,
    defaultTargetPolicy.definitions[0],
    { id: 'run-complete', status: 'completed' },
    { controls: { cancel: false } },
  )
  assert.equal(admittedRequests.length, 2)
  assert.equal(admittedRequests[0].command, 'send')
  assert.equal(admittedRequests[1].command, 'cancel_run')
  assert.equal(admittedResult.cancel.advertisedByNormalAdmission, true)
  assert.equal(admittedResult.cancel.attemptedRun, true)
  assert.equal(admittedResult.cancel.status, 'verified')
}

await runTargetPolicyMatrix()
await runConfigurationMatrix()
await runSemanticMatrix()
await runAdversarialMatrix()
process.stdout.write('Live Bridge adversarial matrix passed\n')
