import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { bridgeLaunchEnvironment, bridgeSourceDirectory, discoverBridge } from './bridge.mjs'
import { profileForBridgeTarget, writeTargetConfig } from './config.mjs'
import { runAdversarialMatrix } from './matrix-adversarial.mjs'
import {
  assertSemanticOutcome,
  cancelSemanticStatus,
  capabilityAvailability,
  exactMarker,
  semanticCommandStatus,
} from './protocol.mjs'
import { verifyCancel } from './target-actions.mjs'
import { defaultTargetPolicy, readTargetPolicy, targetPolicyEvidence } from './target-policy.mjs'

async function withFakeBridge(models, backends, callback) {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', backends }))
      return
    }
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
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
  const exactLuna = both[1].modelId
  const readyBackends = [
    { name: 'opencode', state: 'ready' },
    { name: 'pi', state: 'ready' },
    { name: 'claude-code', state: 'starting' },
  ]
  await withFakeBridge([exactGlm, exactLuna], readyBackends, async (endpoint) => {
    const evidence = {}
    const result = await discoverBridge(endpoint, undefined, evidence, process.cwd(), both)
    assert.deepEqual(
      result.selected.map(({ modelId }) => modelId),
      [exactGlm, exactLuna],
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
      [exactLuna],
    )
  })
  await withFakeBridge([exactLuna], readyBackends, async (endpoint) => {
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
    [exactGlm, exactLuna],
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
}

async function runConfigurationMatrix() {
  const [glm, luna] = defaultTargetPolicy.definitions
  assert.deepEqual(profileForBridgeTarget(glm), {
    name: `Braid live ${glm.modelId}`,
    description: 'Opt-in packed CLI Bridge smoke profile',
    version: '0.1.0',
    harness: 'opencode',
    model: { provider: 'zai-coding-plan', default: 'glm-5.2', reasoningEffort: 'none' },
  })
  assert.deepEqual(profileForBridgeTarget(luna), {
    name: `Braid live ${luna.modelId}`,
    description: 'Opt-in packed CLI Bridge smoke profile',
    version: '0.1.0',
    harness: 'pi',
    model: { provider: 'openai-codex', default: 'gpt-5.6-luna', reasoningEffort: 'none' },
  })
  assert.throws(
    () => profileForBridgeTarget({ ...luna, backend: 'codex' }),
    (error) => error.code === 'TARGET_MODEL_ROUTE_INVALID' && error.exitCode === 2,
  )

  const endpoint = 'http://127.0.0.1:4567'
  const linuxEnvironment = bridgeLaunchEnvironment([luna], endpoint, {
    environment: { PATH: '/usr/bin' },
    platform: 'linux',
  })
  assert.equal(linuxEnvironment.BRIDGE_BACKENDS, 'pi')
  assert.equal(linuxEnvironment.BRIDGE_JAIL_MODE, 'fs-jail')
  assert.equal(linuxEnvironment.BRIDGE_PORT, '4567')
  assert.equal(
    bridgeLaunchEnvironment([luna], endpoint, {
      environment: { BRIDGE_JAIL_MODE: 'off' },
      platform: 'linux',
    }).BRIDGE_JAIL_MODE,
    'off',
  )
  assert.equal(
    bridgeLaunchEnvironment([luna], endpoint, {
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
    const written = await writeTargetConfig(root, endpoint, luna, undefined)
    assert.deepEqual(JSON.parse(await readFile(written.profilePath, 'utf8')), written.profile)
    assert.equal(written.profile.model.default, 'gpt-5.6-luna')
    assert.equal(written.profile.model.provider, 'openai-codex')
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
}

await runTargetPolicyMatrix()
await runConfigurationMatrix()
await runSemanticMatrix()
await runAdversarialMatrix()
process.stdout.write('Live Bridge adversarial matrix passed\n')
