import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { discover } from './discovery.mjs'
import { digest, redactedReceipt, writeEvidence } from './evidence.mjs'
import { RpcSession } from './rpc-session.mjs'
import { configureWithPublicTui } from './setup-tui.mjs'
import { nativeInstallEnvironment } from '../native-install-environment.mjs'
import { dispatchTurn, providerIdentity } from './turn-proof.mjs'

const exec = promisify(execFile)
const repository = new URL('../../', import.meta.url).pathname.replace(/\/$/u, '')
const endpoint = process.env.BRAID_LIVE_CORE_ENDPOINT ?? 'http://127.0.0.1:3344'
const outputPath =
  process.env.BRAID_LIVE_CORE_EVIDENCE ?? 'artifacts/verification/live-core/latest.json'
const timeoutMs = Number(process.env.BRAID_LIVE_CORE_TIMEOUT_MS ?? 180_000)
const runnerFilter = process.env.BRAID_LIVE_CORE_RUNNER

function turnEvidence(turn) {
  return {
    label: turn.label,
    operationId: turn.operationId,
    runId: turn.runId,
    prompt: turn.prompt,
    terminalState: turn.terminalState,
    output: turn.output,
    transcript: turn.transcript,
    eventTypes: turn.eventTypes,
    elapsedMs: turn.elapsedMs,
    providerSessionId: turn.providerSessionId,
    continuation: turn.continuation,
    receipt: turn.receipt,
  }
}

async function packInstall(root) {
  const packageRoot = join(root, 'package')
  const installRoot = join(root, 'install')
  const { stdout } = await exec('pnpm', ['pack', '--pack-destination', packageRoot], {
    cwd: repository,
  })
  const tarball = stdout.trim().split('\n').at(-1)
  assert.ok(tarball?.endsWith('.tgz'), `pnpm pack did not return a tarball: ${stdout}`)
  await mkdir(installRoot, { recursive: true })
  await writeFile(
    join(installRoot, 'package.json'),
    '{"name":"braid-live-core","private":true}\n',
    { mode: 0o600 },
  )
  const tarballPath = tarball.startsWith('/') ? tarball : join(packageRoot, tarball)
  await exec('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', tarballPath], {
    cwd: installRoot,
    env: nativeInstallEnvironment({ ...process.env, npm_config_loglevel: 'error' }),
  })
  return {
    tarball: tarballPath,
    binary: join(installRoot, 'node_modules/@tangle-network/braid/dist/bin/braid.js'),
    installRoot,
  }
}

async function runTarget(binary, root, target) {
  if (target.status !== 'selected') return { ...target, status: 'unavailable' }
  const targetRoot = await mkdtemp(join(root, `target-${target.runner}-`))
  const workspace = join(targetRoot, 'workspace')
  const keyFile = join(targetRoot, 'database.key')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await writeFile(keyFile, `${'a'.repeat(64)}\n`, { mode: 0o600 })
  const startedAt = Date.now()
  const result = {
    runner: target.runner,
    model: target.model,
    profile: { harness: target.runner, model: target.model },
    connection: { kind: 'cli-bridge', endpoint },
    commands: [],
    status: 'failed',
  }
  let first
  let restarted
  try {
    const setup = await configureWithPublicTui(
      binary,
      workspace,
      keyFile,
      endpoint,
      target.runner,
      target.model,
    )
    result.configure = {
      status: 'completed',
      profile: setup.config.profile,
      connectionId: setup.config.connectionId,
      configDigest: digest(setup.config),
    }
    first = new RpcSession(binary, workspace, keyFile, endpoint, timeoutMs)
    const init = first.send('initialize', { workspace, subscribe: true })
    await first.waitFor(
      'initialize acknowledgement',
      (response) => response.requestId === init.requestId && response.type === 'ack',
    )
    const initialState = await first.waitFor(
      'initialize state',
      (response) => response.type === 'state' && response.requestId === init.requestId,
    )
    const profiles = await first.request('list_profiles', {})
    const profileList = profiles.response.result?.profiles ?? []
    const selectedProfile = profileList.find((profile) => profile.model === target.model)
    assert.ok(
      selectedProfile?.id,
      `configured AgentProfile ${target.model} was not returned by list_profiles`,
    )
    const selectedProfileRef = selectedProfile.id
    const selectProfile = await first.request(
      'select_profile',
      { ref: selectedProfileRef, expectedRevision: initialState.revision },
      'op-live-core-select-profile',
    )
    const connections = await first.request('list_connections', {})
    assert.ok(
      connections.response.result?.connections?.some(
        (connection) => connection.id === setup.config.connectionId,
      ),
      'configured connection was not returned by list_connections',
    )
    const connectionId = setup.config.connectionId
    const selectedConnection = await first.request(
      'select_connection',
      { connectionId, expectedRevision: selectProfile.response.revision },
      'op-live-core-select-connection',
    )
    result.select = {
      profileRef: selectedProfileRef,
      connectionId,
      profileAck: selectProfile.response.result,
      connectionAck: selectedConnection.response.result,
    }
    const conversationId = initialState.state.conversationId
    const branchId = initialState.state.branchId
    const nonce = `BraidCoreNonce-${target.runner.toUpperCase()}-7Q4M`
    const firstPrompt = `Remember this exact nonce for our next turn and do not print it until asked: ${nonce}. Reply only ACK_NONCE_STORED.`
    const secondPrompt = 'What exact nonce did I ask you to remember? Reply with only the nonce.'
    assert.equal(secondPrompt.includes(nonce), false)
    const firstTurn = await dispatchTurn(first, {
      conversationId,
      branchId,
      prompt: firstPrompt,
      operationId: 'op-live-core-send-1',
      label: 'turn 1',
      timeoutMs,
    })
    result.dispatch = {
      conversationId,
      branchId,
      nonce,
      turns: [turnEvidence(firstTurn)],
    }
    assert.equal(
      firstTurn.output.trim(),
      'ACK_NONCE_STORED',
      `turn 1 terminal output was ${JSON.stringify(firstTurn.output)}`,
    )
    assert.equal(firstTurn.output.includes(nonce), false, 'turn 1 printed the hidden nonce')
    assert.ok(firstTurn.providerSessionId, 'turn 1 did not record the CLI Bridge session identity')
    const secondTurn = await dispatchTurn(first, {
      conversationId,
      branchId,
      prompt: secondPrompt,
      operationId: 'op-live-core-send-2',
      label: 'turn 2',
      timeoutMs,
    })
    result.dispatch = {
      conversationId,
      branchId,
      nonce,
      turns: [turnEvidence(firstTurn), turnEvidence(secondTurn)],
      sameProviderSessionId: secondTurn.providerSessionId === firstTurn.providerSessionId,
    }
    assert.equal(
      secondTurn.output.trim(),
      nonce,
      `turn 2 did not recover the nonce: ${JSON.stringify(secondTurn.output)}`,
    )
    assert.equal(
      secondTurn.providerSessionId,
      firstTurn.providerSessionId,
      'the two turns used different CLI Bridge session identities',
    )
    assert.notEqual(
      secondTurn.receipt?.digest,
      firstTurn.receipt?.digest,
      'two turns shared an immutable receipt',
    )
    result.dispatch = {
      conversationId,
      branchId,
      nonce,
      turns: [turnEvidence(firstTurn), turnEvidence(secondTurn)],
      sameProviderSessionId: true,
    }
    const preRestartState = await first.state('full', 30_000)
    await first.shutdown()
    restarted = new RpcSession(binary, workspace, keyFile, endpoint, timeoutMs)
    const restartInit = restarted.send('initialize', { workspace, subscribe: true })
    await restarted.waitFor(
      'restart acknowledgement',
      (response) => response.requestId === restartInit.requestId && response.type === 'ack',
    )
    await restarted.waitFor(
      'restart state',
      (response) => response.type === 'state' && response.requestId === restartInit.requestId,
    )
    const restartState = await restarted.state('full', 30_000)
    for (const turn of [firstTurn, secondTurn]) {
      const restartDetails = restarted.send('get_details', {
        entityType: 'run',
        entityId: turn.runId,
      })
      const restartDetailsAck = await restarted.waitFor(
        `${turn.label} restart receipt`,
        (response) => response.requestId === restartDetails.requestId && response.type === 'ack',
      )
      const restartedReceipt = redactedReceipt(restartDetailsAck.result)
      assert.equal(
        restartedReceipt?.digest,
        turn.receipt?.digest,
        `${turn.label} receipt digest changed after restart`,
      )
      assert.equal(
        providerIdentity(restartDetailsAck.result, restartState.state, turn.runId),
        turn.providerSessionId,
        `${turn.label} provider identity changed after restart`,
      )
    }
    const restartMessages = restartState.state.messages.filter(
      (message) => message.runId === firstTurn.runId || message.runId === secondTurn.runId,
    )
    assert.ok(
      restartMessages.some((message) => message.role === 'user' && message.text === firstPrompt),
      'turn 1 prompt was not durable after restart',
    )
    assert.ok(
      restartMessages.some(
        (message) => message.role === 'assistant' && message.text === firstTurn.output,
      ),
      'turn 1 output was not durable after restart',
    )
    assert.ok(
      restartMessages.some((message) => message.role === 'user' && message.text === secondPrompt),
      'turn 2 prompt was not durable after restart',
    )
    assert.ok(
      restartMessages.some(
        (message) => message.role === 'assistant' && message.text === secondTurn.output,
      ),
      'turn 2 output was not durable after restart',
    )
    const reconnect = restarted.send(
      'reconnect',
      { runId: secondTurn.runId },
      'op-live-core-reconnect-1',
    )
    const reconnectResponse = await restarted.waitFor(
      'reconnect response',
      (response) =>
        response.requestId === reconnect.requestId &&
        (response.type === 'ack' || response.type === 'error'),
      30_000,
    )
    let safeFollowUp
    if (secondTurn.providerSessionId && secondTurn.continuation) {
      const followUp = await dispatchTurn(restarted, {
        conversationId,
        branchId,
        prompt: 'Reply with exactly LIVE_CORE_FOLLOWUP_OK.',
        operationId: 'op-live-core-send-after-restart',
        label: 'post-restart follow-up',
        timeoutMs,
      })
      assert.equal(followUp.output.trim(), 'LIVE_CORE_FOLLOWUP_OK')
      assert.equal(
        followUp.providerSessionId,
        secondTurn.providerSessionId,
        'post-restart follow-up did not preserve the proven session identity',
      )
      safeFollowUp = {
        status: 'resumed',
        operationId: followUp.operationId,
        runId: followUp.runId,
        output: followUp.output,
        terminalState: followUp.terminalState,
        eventTypes: followUp.eventTypes,
        elapsedMs: followUp.elapsedMs,
        providerSessionId: followUp.providerSessionId,
        receipt: followUp.receipt,
      }
    } else {
      safeFollowUp = {
        status: 'refused',
        reason: secondTurn.providerSessionId
          ? 'Braid did not advertise sessions.continue after restart'
          : 'Braid did not record a provider session identity after restart',
      }
    }
    const postRestartSends = restarted.commands.filter((command) => command.command === 'send')
    if (safeFollowUp.status === 'refused')
      assert.equal(
        postRestartSends.length,
        0,
        'restart path resubmitted an outward send without proven identity',
      )
    else
      assert.deepEqual(
        postRestartSends.map((command) => command.operationId),
        ['op-live-core-send-after-restart'],
      )
    result.restart = {
      preRestartTranscript: preRestartState.state.messages.filter(
        (message) => message.runId === firstTurn.runId || message.runId === secondTurn.runId,
      ),
      state: restartState.state.runs.filter(
        (run) => run.id === firstTurn.runId || run.id === secondTurn.runId,
      ),
      transcript: restartMessages,
      reconnect: reconnectResponse,
      safeFollowUp,
      commands: restarted.commands,
      postRestartSendCount: postRestartSends.length,
    }
    await restarted.shutdown()
    result.status = 'passed'
  } catch (error) {
    result.error = {
      message: error instanceof Error ? error.message : String(error),
      response: error.response,
    }
  } finally {
    if (first && !first.closed) await first.forceStop().catch(() => undefined)
    if (restarted && !restarted.closed) await restarted.forceStop().catch(() => undefined)
    result.elapsedMs = Date.now() - startedAt
    await rm(targetRoot, { force: true, recursive: true })
  }
  return result
}

const root = await mkdtemp(join(tmpdir(), 'braid-live-core-'))
const evidence = {
  claim: 'packed-public-configure-dispatch-restart',
  command: 'node scripts/live-core/run.mjs',
  endpoint,
  startedAt: new Date().toISOString(),
  targets: [],
}
try {
  const live = await discover(endpoint)
  evidence.bridge = { health: live.health, models: live.models, inventory: live.inventory }
  const packed = await packInstall(root)
  evidence.artifact = { tarball: packed.tarball, binary: packed.binary }
  const targets = runnerFilter
    ? live.targets.filter((target) => target.runner === runnerFilter)
    : live.targets
  assert.ok(targets.length > 0, `No selected live target matched runner ${runnerFilter}`)
  for (const target of targets)
    evidence.targets.push(await runTarget(packed.binary, root, target, live))
  const passed = evidence.targets.filter((target) => target.status === 'passed').length
  evidence.status = passed === evidence.targets.length && passed > 0 ? 'passed' : 'failed'
  await writeEvidence(outputPath, evidence)
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`)
  process.exitCode = evidence.status === 'passed' ? 0 : 1
} finally {
  await rm(root, { force: true, recursive: true })
}
