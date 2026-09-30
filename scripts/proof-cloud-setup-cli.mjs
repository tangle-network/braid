import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'

// Real executable, encrypted storage and loopback HTTP. Reads succeed; writes are refused.
// This proves local setup and task admission, NOT execution in a live Tangle sandbox.
const repository = fileURLToPath(new URL('../', import.meta.url))
const binary = resolve(process.argv[2] ?? join(repository, 'dist/bin/braid.js'))
const publicProbe = process.argv.includes('--public-probe')
const compact = process.argv.includes('--compact')
const columns = Number(process.env.BRAID_PROOF_COLUMNS ?? (compact ? 80 : 120))
const rows = Number(process.env.BRAID_PROOF_ROWS ?? (compact ? 24 : 40))
if (!Number.isInteger(columns) || columns < 1 || !Number.isInteger(rows) || rows < 1)
  throw new Error('BRAID_PROOF_COLUMNS and BRAID_PROOF_ROWS must be positive integers')
const castPath = process.env.BRAID_PROOF_CAST
const castStartedAt = performance.now()
const castTimestamp = Math.floor(Date.now() / 1000)
const castEvents = []
if (castPath) {
  const castDirectory = dirname(castPath)
  await mkdir(castDirectory, { recursive: true, mode: 0o700 })
  await writeFile(castPath, '', { flag: 'wx', mode: 0o600 })
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const root = await mkdtemp(join(tmpdir(), 'braid-cloud-cli-'))
const workspace = join(root, 'workspace')
const configPath = join(root, 'config.json')
const keyPath = join(root, 'database.key')
const requested = {
  repoUrl: 'https://github.com/tangle-network/braid.git',
  gitRef: 'main',
  cwd: { base: 'repository', path: 'src' },
}
const setupReadPaths = new Set(['/v1/backends', '/v1/me', '/usage', '/subscription'])
const credential = randomBytes(24).toString('hex')
const credentialB = randomBytes(24).toString('hex')
const credentialCanaryTailLength = Math.max(credential.length, credentialB.length) - 1
const requests = []
const localReadResponses = new Map([
  [
    '/v1/backends',
    {
      backends: [
        {
          type: 'opencode',
          name: 'OpenCode',
          description: 'Loopback setup proof backend',
          capabilities: {
            streaming: true,
            toolUse: true,
            reasoning: true,
            multimodal: false,
            imageInput: false,
            contextWindow: 128_000,
            mcp: false,
            sessions: true,
            configurable: true,
            interactions: ['question', 'permission', 'plan'],
          },
        },
      ],
      timestamp: '2026-09-29T00:00:00.000Z',
    },
  ],
  [
    '/v1/me',
    {
      success: true,
      data: {
        customer_id: 'loopback-customer',
        billing_owner_id: 'loopback-billing-owner',
        api_key_id: 'loopback-api-key',
        billing_delegation_authorized: false,
      },
    },
  ],
  [
    '/usage',
    {
      computeMinutes: 0,
      gpuSeconds: 0,
      gpuCostUsd: 0,
      gpuProviderCostUsd: 0,
      activeSandboxes: 0,
      totalSandboxes: 0,
      periodStart: '2026-09-01T00:00:00.000Z',
      periodEnd: '2026-10-01T00:00:00.000Z',
    },
  ],
  [
    '/subscription',
    {
      plan: 'loopback-test',
      status: 'active',
      creditsAvailableUsd: 0,
      creditsUsedUsd: 0,
      monthlyBalanceUsd: 0,
      maxConcurrentSandboxes: 1,
      overageAllowed: false,
      limits: { maxCpuCores: 1, maxRamGB: 2, maxStorageGB: 50 },
    },
  ],
])
const server = createServer((request, response) => {
  const requestUrl = request.url ?? '/'
  const path = new URL(requestUrl, 'http://127.0.0.1').pathname
  const readResponse = request.method === 'GET' ? localReadResponses.get(path) : undefined
  const responseStatus = readResponse === undefined ? 503 : 200
  const idempotencyKey = request.headers['idempotency-key']
  let requestBodyTail = ''
  let credentialInBody = false
  const authorization = request.headers.authorization
  const nonAuthorizationHeaderValues = Object.entries(request.headers)
    .filter(([name]) => name.toLowerCase() !== 'authorization')
    .flatMap(([, value]) => (Array.isArray(value) ? value : value === undefined ? [] : [value]))
  const matchesCredential = (value) =>
    [credential, credentialB].some((canary) => value.includes(canary))
  const credentialInNonAuthorizationHeader = nonAuthorizationHeaderValues.some(matchesCredential)
  const credentialInMalformedAuthorization =
    typeof authorization === 'string' &&
    [credential, credentialB].some((canary) => authorization.includes(canary)) &&
    authorization !== `Bearer ${credential}` &&
    authorization !== `Bearer ${credentialB}`
  const recordedRequest = {
    method: request.method,
    path,
    responseStatus,
    ...(typeof idempotencyKey === 'string'
      ? { idempotencyKeyFingerprint: createHash('sha256').update(idempotencyKey).digest('hex') }
      : {}),
    credentialAReceived: authorization === `Bearer ${credential}`,
    credentialBReceived: authorization === `Bearer ${credentialB}`,
    credentialInNonAuthorizationHeader,
    credentialInMalformedAuthorization,
    credentialInUrl: [credential, credentialB].some((value) => requestUrl.includes(value)),
    credentialInBody: false,
    requestBodyComplete: false,
  }
  requests.push(recordedRequest)
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    const bodyWindow = requestBodyTail + chunk
    credentialInBody ||= [credential, credentialB].some((value) => bodyWindow.includes(value))
    requestBodyTail = bodyWindow.slice(-credentialCanaryTailLength)
  })
  request.on('end', () => {
    recordedRequest.credentialInBody = credentialInBody
    recordedRequest.requestBodyComplete = true
  })
  request.resume()
  response.writeHead(responseStatus, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify(readResponse ?? { error: { message: 'CLOUD_SETUP_LOOPBACK_REFUSAL' } }),
  )
})
let child
let emulator
let statePath
let screen = ''
let exit
let raw = ''
const frames = []
const evidence = {
  binary,
  provider: 'loopback fixture reads; all writes receive 503; no live Tangle execution',
  publicProbe,
  columns,
  rows,
  commands: [],
  processes: [],
  processExitCodes: [],
  taskPostAttemptCounts: [],
  taskRunStatuses: [],
  providerPreflightReadPaths: [],
}

function assertNoTaskDispatches(observedRequests = requests) {
  assert.ok(
    observedRequests.every(
      (request) =>
        request.method === 'GET' &&
        setupReadPaths.has(request.path) &&
        request.responseStatus === 200 &&
        (request.credentialAReceived || request.credentialBReceived),
    ),
    'setup or reopen sent a mutation or failed an authenticated identity/capability read',
  )
}

function assertSuccessfulSetupReads(observedRequests = requests) {
  const reads = observedRequests.filter((request) => request.method === 'GET')
  assert.ok(
    reads.every(
      (request) =>
        setupReadPaths.has(request.path) &&
        request.responseStatus === 200 &&
        (request.credentialAReceived || request.credentialBReceived),
    ),
    'an observed setup read was unauthenticated, failed, or outside the expected endpoint set',
  )
  for (const path of setupReadPaths) {
    assert.ok(
      reads.some(
        (request) =>
          request.path === path &&
          request.responseStatus === 200 &&
          (request.credentialAReceived || request.credentialBReceived),
      ),
      `setup did not complete authenticated ${path}`,
    )
  }
}

function assertProviderPreflightBeforeCreate(observedRequests) {
  const firstCreateIndex = observedRequests.findIndex(
    (request) => request.method === 'POST' && request.path === '/v1/sandboxes',
  )
  assert.ok(firstCreateIndex >= 0, 'task did not reach sandbox creation after provider preflight')
  const preflightRequests = observedRequests.slice(0, firstCreateIndex)
  assertNoTaskDispatches(preflightRequests)
  assertSuccessfulSetupReads(preflightRequests)
  evidence.providerPreflightReadPaths.push([
    ...new Set(preflightRequests.map((request) => request.path)),
  ])
}

function assertTaskRequestAllowlist(observedRequests) {
  assert.ok(
    observedRequests.every(
      (request) =>
        (request.method === 'GET' &&
          setupReadPaths.has(request.path) &&
          request.responseStatus === 200 &&
          (request.credentialAReceived || request.credentialBReceived)) ||
        (request.method === 'POST' &&
          request.path === '/v1/sandboxes' &&
          request.responseStatus === 503 &&
          request.credentialAReceived &&
          !request.credentialBReceived),
    ),
    'task sent a request outside authenticated setup reads and bounded sandbox-create retries',
  )
}

function assertCapabilityReadOnlyRequests(observedRequests) {
  assert.ok(
    observedRequests.length > 0 &&
      observedRequests.every(
        (request) =>
          request.method === 'GET' &&
          setupReadPaths.has(request.path) &&
          request.responseStatus === 200 &&
          request.credentialAReceived &&
          !request.credentialBReceived,
      ),
    'rejected continuation sent something other than authenticated read-only setup requests',
  )
}

function assertNoCredentialLeak(observedRequests = requests) {
  assert.ok(observedRequests.every((request) => request.requestBodyComplete))
  assert.ok(observedRequests.every((request) => !request.credentialInUrl))
  assert.ok(observedRequests.every((request) => !request.credentialInBody))
  assert.ok(observedRequests.every((request) => !request.credentialInNonAuthorizationHeader))
  assert.ok(observedRequests.every((request) => !request.credentialInMalformedAuthorization))
}

async function waitForRequestBodies(label) {
  await until(() => requests.every((request) => request.requestBodyComplete), label)
}

function assertTaskDispatch(observedRequests) {
  assert.ok(
    observedRequests.some(
      (request) =>
        request.method === 'POST' &&
        request.path === '/v1/sandboxes' &&
        request.responseStatus === 503,
    ),
    'explicit task submission did not reach the refusing loopback provider',
  )
}

function assertStableCreateIdempotency(observedRequests) {
  const dispatches = observedRequests.filter(
    (request) => request.method === 'POST' && request.path === '/v1/sandboxes',
  )
  const fingerprints = dispatches.map((request) => request.idempotencyKeyFingerprint)
  assert.ok(dispatches.length >= 2, 'provider create did not perform a retry')
  assert.ok(dispatches.length <= 5, 'provider create exceeded its five-attempt retry bound')
  assert.equal(
    observedRequests.filter((request) => request.method === 'POST').length,
    dispatches.length,
    'task submission sent a POST outside sandbox creation',
  )
  assert.ok(fingerprints.every((fingerprint) => fingerprint !== undefined))
  assert.equal(new Set(fingerprints).size, 1, 'create retries changed their idempotency key')
  assert.ok(
    dispatches.every((request) => request.credentialAReceived && !request.credentialBReceived),
    'a sandbox-create retry did not use the selected connection A credential',
  )
}

function assertSnapshotRedacted(value) {
  const serialized = JSON.stringify(value)
  assert.ok(!serialized.includes(credential), 'credential A appeared in a saved snapshot')
  assert.ok(!serialized.includes(credentialB), 'credential B appeared in a saved snapshot')
}

async function until(predicate, label, timeout = 20_000) {
  const deadline = Date.now() + timeout
  while (!(await predicate())) {
    assert.equal(
      exit,
      undefined,
      `CLI exited while waiting for ${label}: ${JSON.stringify(exit)}\n${screen}`,
    )
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}\n${screen}`)
    await sleep(25)
  }
}
const expect = (pattern) => until(() => pattern.test(screen), String(pattern))
async function key(value) {
  child.write(value)
  await sleep(100)
}
function capture(label) {
  assert.ok(!raw.includes(credential), 'credential appeared in terminal output')
  assert.ok(!raw.includes(credentialB), 'B credential appeared in terminal output')
  frames.push({ label, screen: screen.trim() })
}
async function snapshot() {
  const path = `${statePath}.frame`
  await rm(path, { force: true })
  process.kill(child.pid, 'SIGUSR2')
  let value
  await until(async () => {
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
      return true
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return false
      throw error
    }
  }, 'SIGUSR2 state snapshot')
  // The child verifies its atomic signal snapshot after rename; leave it a quiet interval before the next capture.
  await sleep(100)
  return value
}
async function waitForUnknownRun(previousRunCount, label, previousRequestCount) {
  await until(
    () =>
      requests
        .slice(previousRequestCount)
        .filter((request) => request.method === 'POST' && request.path === '/v1/sandboxes')
        .length === 5,
    `${label} five bounded create attempts`,
    60_000,
  )
  await waitForRequestBodies(`${label} request bodies`)
  let value
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    value = await snapshot()
    if (value.state.runs.length > previousRunCount && value.state.runs.at(-1)?.status === 'unknown')
      return value
    await sleep(250)
  }
  throw new Error(`Timed out: ${label} did not become unknown after five create attempts`)
}
async function waitForConversationCount(previousCount, label) {
  let value
  await until(async () => {
    value = await snapshot()
    return value.view.conversations.length > previousCount
  }, label)
  return value
}
async function openSetup(connectionKeys = ['\r']) {
  await key('\u000b')
  await expect(/Setup/u)
  capture('setup menu')
  await key('\u001b[B')
  await key('\r')
  await expect(/choose an AgentProfile/u)
  await key('\r')
  await expect(/choose a connection/u)
  for (const choiceKey of connectionKeys) await key(choiceKey)
  await expect(/workspace · cloud sandbox/u)
}
async function start(endpoint, phase) {
  exit = undefined
  screen = ''
  statePath = join(root, `${phase}.json`)
  emulator = new xterm.Terminal({ cols: columns, rows, allowProposedApi: true })
  const args = [
    binary,
    '--workspace',
    workspace,
    '--config',
    configPath,
    '--database-key-file',
    keyPath,
    '--no-color',
    '--record-state',
    statePath,
  ]
  evidence.commands.push([process.execPath, ...args])
  child = pty.spawn(process.execPath, args, {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      TERM: 'xterm-256color',
      NO_COLOR: '1',
      NODE_NO_WARNINGS: '1',
      BRAID_STATE_PATH: join(root, 'state.sqlite'),
      BRAID_CLI_BRIDGE_ENDPOINT: endpoint,
    },
  })
  evidence.processes.push(child.pid)
  if (castPath)
    castEvents.push([
      Number(((performance.now() - castStartedAt) / 1000).toFixed(3)),
      'm',
      `process-start:${phase}:pid-${child.pid}`,
    ])
  child.onExit((value) => {
    exit = value
    if (castPath)
      castEvents.push([
        Number(((performance.now() - castStartedAt) / 1000).toFixed(3)),
        'm',
        `process-exit:${phase}:${value.exitCode}`,
      ])
  })
  child.onData((chunk) => {
    raw += chunk
    if (castPath)
      castEvents.push([Number(((performance.now() - castStartedAt) / 1000).toFixed(3)), 'o', chunk])
    emulator.write(chunk, () => {
      const buffer = emulator.buffer.active
      screen = Array.from(
        { length: rows },
        (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
      ).join('\n')
    })
  })
  await expect(/new message/u)
  capture(phase)
}
async function stop() {
  await expect(/new message/u)
  await key('\u0015')
  await key('/quit\r')
  await until(() => exit !== undefined, 'CLI /quit')
  assert.equal(exit.exitCode, 0)
  evidence.processExitCodes.push(exit.exitCode)
  emulator.dispose()
  emulator = undefined
}
async function reopenedWorkspace(label) {
  await openSetup()
  capture(label)
  assert.match(screen, /main/u)
  assert.match(screen, /src/u)
  await key('\u000c')
  await expect(/files · lifetime/u)
  assert.match(screen, /1800/u)
  await key('\u001b')
  await key('\u001b')
  await expect(/new message/u)
}
try {
  evidence.version = execFileSync(process.execPath, [binary, '--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  await chmod(root, 0o700)
  await mkdir(workspace, { mode: 0o700 })
  await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
  // Seed only the pre-existing configuration. No file edits after starting the CLI.
  await writeFile(
    configPath,
    `${JSON.stringify({
      format: 'braid-startup-config',
      schemaVersion: 2,
      profile: defineAgentProfile({
        name: 'Cloud CLI proof',
        harness: 'opencode',
        model: { provider: 'tangle-router', default: 'tangle-router/glm-5.3' },
      }),
      connectionId: 'connection-tangle-sandbox',
      connections: [
        {
          id: 'connection-tangle-sandbox',
          kind: 'tangle-sandbox',
          name: 'Tangle Sandbox (loopback refusal)',
          endpoint,
          providerOptions: {
            transport: 'local',
            capabilityHints: ['stream', 'placement', 'usage'],
          },
          createdAt: '2026-09-29T00:00:00.000Z',
          updatedAt: '2026-09-29T00:00:00.000Z',
          lastHealth: { status: 'unknown' },
        },
        {
          id: 'connection-tangle-sandbox-b',
          kind: 'tangle-sandbox',
          name: 'Tangle Sandbox B (loopback refusal)',
          endpoint,
          providerOptions: {
            transport: 'local',
            capabilityHints: ['stream', 'placement', 'usage'],
          },
          createdAt: '2026-09-29T00:00:00.000Z',
          updatedAt: '2026-09-29T00:00:00.000Z',
          lastHealth: { status: 'unknown' },
        },
      ],
      databaseKeyFile: keyPath,
    })}\n`,
    { mode: 0o600 },
  )
  const initialBytes = await readFile(configPath)
  await start(endpoint, 'configured-cli')
  if (publicProbe) {
    await key('\u000b')
    await expect(/Run configuration/u)
    capture('public CLI Ctrl+K')
    evidence.result = /Setup/u.test(screen)
      ? 'setup menu present; full proof required'
      : 'setup menu absent'
    assert.deepEqual(await readFile(configPath), initialBytes)
    assert.equal(requests.length, 0)
    await key('\u001b')
  } else {
    await openSetup()
    assert.match(screen, /files: ephemeral/u)
    await key(requested.repoUrl)
    await key('\r')
    await key(requested.gitRef)
    await key('\r')
    await key(requested.cwd.path)
    await key('\u000c')
    await expect(/files · lifetime/u)
    await key('\u001b[B')
    await key('\r')
    await key('\u0005\u00151800')
    capture('retained lifetime')
    await key('\r')
    await expect(/credential|API key|api key/u)
    await key(credential)
    await key('\r')
    await expect(/review and/u)
    capture('review without execution')
    assertNoTaskDispatches()
    await key('\r')
    await expect(/selection applied/u)
    capture('saved without execution')
    assert.match(screen, /credentials saved securely|cred saved/u)
    assert.doesNotMatch(screen, /credentials not configured|cred not set/u)
    const savedBytes = await readFile(configPath)
    const saved = JSON.parse(savedBytes.toString('utf8'))
    assert.deepEqual(saved.workspaceRequest, requested)
    const connection = saved.connections.find((entry) => entry.id === saved.connectionId)
    assert.equal(connection.endpoint, endpoint)
    assert.equal(connection.providerOptions.lifecycle, 'retained')
    assert.equal(connection.providerOptions.idleTtlSeconds, 1800)
    assert.equal(typeof connection.credentialRef, 'string')
    assert.ok(!savedBytes.includes(credential))
    assertNoTaskDispatches()
    const afterSave = await snapshot()
    assertSnapshotRedacted(afterSave)
    assert.equal(afterSave.state.runs.length, 0)
    await key('\u001b')
    await expect(/new message/u)
    await reopenedWorkspace('reopened in same process')
    assert.deepEqual(await readFile(configPath), savedBytes)
    assertNoTaskDispatches()
    await openSetup(['\u001b[B', '\r'])
    await key('\u000c')
    await expect(/files · lifetime/u)
    await key('\r')
    await expect(/credential · Tangle Sandbox B/u)
    await key(credentialB)
    await key('\r')
    await expect(/review and/u)
    await key('\r')
    await expect(/selection applied/u)
    const selectedBBytes = await readFile(configPath)
    const selectedB = JSON.parse(selectedBBytes.toString('utf8'))
    assert.equal(selectedB.connectionId, 'connection-tangle-sandbox-b')
    assert.ok(!selectedBBytes.includes(credentialB))
    const afterB = await snapshot()
    assertSnapshotRedacted(afterB)
    assert.equal(afterB.state.runConfiguration.connectionId, 'connection-tangle-sandbox-b')
    await key('\u001b')
    await expect(/new message/u)
    await openSetup(['\u001b[A', '\r'])
    await key('\u000c')
    await expect(/files · lifetime/u)
    await key('\r')
    await key('\r')
    await expect(/review and/u)
    await key('\r')
    await expect(/selection applied/u)
    const selectedABytes = await readFile(configPath)
    const selectedA = JSON.parse(selectedABytes.toString('utf8'))
    assert.equal(selectedA.connectionId, 'connection-tangle-sandbox')
    const afterA = await snapshot()
    assertSnapshotRedacted(afterA)
    assert.equal(afterA.state.runConfiguration.connectionId, 'connection-tangle-sandbox')
    await key('\u001b')
    await expect(/new message/u)
    assert.deepEqual(await readFile(configPath), selectedABytes)
    assertNoTaskDispatches()
    const beforeTaskRequests = requests.length
    const beforeTaskRunCount = afterA.state.runs.length
    // A later user submission must reach the existing authenticated provider preflight.
    await key('CLOUD_SETUP_LATER_TASK\r')
    const afterTask = await waitForUnknownRun(
      beforeTaskRunCount,
      'loopback task refusal',
      beforeTaskRequests,
    )
    assertSnapshotRedacted(afterTask)
    const refusedRun = afterTask.state.runs.at(-1)
    assert.equal(refusedRun?.status, 'unknown')
    const refusedUserMessage = afterTask.state.messages.find(
      (message) => message.runId === refusedRun.id && message.role === 'user',
    )
    assert.ok(refusedUserMessage, `run ${refusedRun.id} has no durable user message`)
    assert.ok(refusedUserMessage.text.includes('CLOUD_SETUP_LATER_TASK'))
    await expect(/outcome unverified/u)
    const taskRequests = requests.slice(beforeTaskRequests)
    await waitForRequestBodies('first task request bodies')
    assertProviderPreflightBeforeCreate(taskRequests)
    assertTaskRequestAllowlist(taskRequests)
    assertTaskDispatch(taskRequests)
    assertStableCreateIdempotency(taskRequests)
    assertNoCredentialLeak()
    evidence.taskPostAttemptCounts.push(
      taskRequests.filter((request) => request.method === 'POST').length,
    )
    evidence.taskRunStatuses.push(afterTask.state.runs.at(-1)?.status)
    assert.equal(afterTask.state.runConfiguration.connectionId, 'connection-tangle-sandbox')
    capture('later explicit submission; unchanged provider refusal')
    await key('\u001b')
    await stop()
    const beforeReloadRequests = requests.length
    await start(endpoint, 'disk-reloaded-cli')
    await reopenedWorkspace('reopened after encrypted disk reload')
    assert.deepEqual(await readFile(configPath), selectedABytes)
    assertNoTaskDispatches(requests.slice(beforeReloadRequests))
    const afterReload = await snapshot()
    assertSnapshotRedacted(afterReload)
    assert.equal(afterReload.state.conversationId, afterTask.state.conversationId)
    assert.equal(afterReload.state.branchId, afterTask.state.branchId)
    assert.equal(afterReload.state.runs.length, afterTask.state.runs.length)
    assert.deepEqual(
      afterReload.state.runs.find((run) => run.id === refusedRun.id),
      refusedRun,
      'the refused run did not survive encrypted disk reload unchanged',
    )
    assert.deepEqual(
      afterReload.state.messages.find((message) => message.id === refusedUserMessage.id),
      refusedUserMessage,
      'the refused task message did not survive encrypted disk reload unchanged',
    )
    evidence.reopenedRunStatus = afterReload.state.runs.at(-1)?.status
    evidence.reopenedTaskMessagePersisted = true
    const beforeContinuationRequests = requests.length
    const beforeContinuationCreateAttempts = requests.filter(
      (request) => request.method === 'POST' && request.path === '/v1/sandboxes',
    ).length
    const beforeContinuationRunCount = afterReload.state.runs.length
    const beforeContinuationMessageCount = afterReload.state.messages.length
    await key('CLOUD_SETUP_RESUMED_TASK\r')
    await expect(/CONTEXT_TRANSFER_UNAVAILABLE/u)
    const continuationRequests = requests.slice(beforeContinuationRequests)
    assertCapabilityReadOnlyRequests(continuationRequests)
    assert.equal(
      requests.filter((request) => request.method === 'POST' && request.path === '/v1/sandboxes')
        .length,
      beforeContinuationCreateAttempts,
      'rejected continuation attempted sandbox creation',
    )
    await key('\u001b')
    await until(
      () => !screen.includes('CONTEXT_TRANSFER_UNAVAILABLE') && screen.includes('new message'),
      'close continuation refusal',
    )
    const afterRejectedContinuation = await snapshot()
    assert.equal(afterRejectedContinuation.state.conversationId, afterReload.state.conversationId)
    assert.equal(afterRejectedContinuation.state.branchId, afterReload.state.branchId)
    assert.deepEqual(afterRejectedContinuation.state.runs, afterReload.state.runs)
    assert.deepEqual(afterRejectedContinuation.state.messages, afterReload.state.messages)
    assert.equal(afterRejectedContinuation.state.runs.length, beforeContinuationRunCount)
    assert.equal(afterRejectedContinuation.state.messages.length, beforeContinuationMessageCount)
    assertSnapshotRedacted(afterRejectedContinuation)
    evidence.sameBranchContinuation =
      'CONTEXT_TRANSFER_UNAVAILABLE; authenticated read-only identity, capability, usage, and subscription GETs only; zero sandbox creates or run/message changes'
    evidence.sameBranchReadOnlyRequestPaths = [
      ...new Set(continuationRequests.map((request) => request.path)),
    ]
    evidence.sameBranchReadOnlyRequestCount = continuationRequests.length
    assert.equal(
      afterRejectedContinuation.state.draft,
      'CLOUD_SETUP_RESUMED_TASK',
      'rejected continuation text was not retained in the draft',
    )
    evidence.rejectedContinuationDraftRetained = true
    assertNoCredentialLeak()
    let stateBeforeNew = afterRejectedContinuation
    await key('\u0015')
    await until(async () => {
      stateBeforeNew = await snapshot()
      return stateBeforeNew.state.draft.length === 0
    }, 'clear rejected continuation draft')
    assert.deepEqual(stateBeforeNew.state.runs, afterRejectedContinuation.state.runs)
    assert.deepEqual(stateBeforeNew.state.messages, afterRejectedContinuation.state.messages)
    evidence.rejectedContinuationDraftCleared = true
    const beforeConversationCount = stateBeforeNew.view.conversations.length
    await key('/new Cloud CLI proof fresh\r')
    const freshConversation = await waitForConversationCount(
      beforeConversationCount,
      'fresh conversation after reopened unresolved run',
    )
    await expect(/new message/u)
    assert.notEqual(freshConversation.state.conversationId, stateBeforeNew.state.conversationId)
    assert.equal(
      freshConversation.state.messages.length,
      0,
      'new conversation did not open with an empty active transcript',
    )
    assert.deepEqual(
      freshConversation.state.runs.map((run) => run.id),
      stateBeforeNew.state.runs.map((run) => run.id),
      'new conversation admitted a run before its first task',
    )
    assert.equal(freshConversation.state.runConfiguration.connectionId, 'connection-tangle-sandbox')
    const beforeReloadTaskRunCount = freshConversation.state.runs.length
    const beforeFreshTaskRequests = requests.length
    await key('CLOUD_SETUP_RELOADED_TASK\r')
    const afterReloadTask = await waitForUnknownRun(
      beforeReloadTaskRunCount,
      'reloaded loopback task refusal',
      beforeFreshTaskRequests,
    )
    assertSnapshotRedacted(afterReloadTask)
    assert.equal(afterReloadTask.state.runs.at(-1)?.status, 'unknown')
    await expect(/outcome unverified/u)
    const reloadedTaskRequests = requests.slice(beforeFreshTaskRequests)
    await waitForRequestBodies('reloaded task request bodies')
    assertProviderPreflightBeforeCreate(reloadedTaskRequests)
    assertTaskRequestAllowlist(reloadedTaskRequests)
    assertTaskDispatch(reloadedTaskRequests)
    assertStableCreateIdempotency(reloadedTaskRequests)
    evidence.taskPostAttemptCounts.push(
      reloadedTaskRequests.filter((request) => request.method === 'POST').length,
    )
    evidence.taskRunStatuses.push(afterReloadTask.state.runs.at(-1)?.status)
    assert.ok(
      requests
        .filter((request) => request.method !== 'GET')
        .every((request) => request.responseStatus === 503),
      'loopback unexpectedly accepted a mutating operation',
    )
    await waitForRequestBodies('final loopback request bodies')
    assertNoCredentialLeak()
    capture('reloaded credential used by later submission')
    await key('\u001b')
    evidence.afterSaveRunCount = afterSave.state.runs.length
    evidence.savedWorkspaceRequest = saved.workspaceRequest
    evidence.savedLifecycle = connection.providerOptions.lifecycle
    evidence.result =
      'save, A→B→A, same-process reopen and encrypted reload passed; loopback task writes were refused; no cloud task or resource was created'
  }
  await stop()
  evidence.exit = exit
} finally {
  let forcedCleanupExitMissing = false
  if (child && exit === undefined) {
    child.kill('SIGKILL')
    const deadline = Date.now() + 5_000
    while (exit === undefined && Date.now() < deadline) await sleep(25)
    evidence.forcedCleanupExitObserved = exit !== undefined
    forcedCleanupExitMissing = exit === undefined
  }
  if (exit !== undefined && evidence.processExitCodes.length < evidence.processes.length)
    evidence.processExitCodes.push(exit.exitCode)
  emulator?.dispose()
  server.closeAllConnections()
  if (server.listening) await new Promise((done) => server.close(done))
  if (!forcedCleanupExitMissing) {
    await rm(root, { recursive: true, force: true })
    await assert.rejects(() => lstat(root), { code: 'ENOENT' })
    evidence.temporaryStateRemoved = true
  } else {
    evidence.temporaryStateRemoved = false
  }
  if (castPath) {
    assert.ok(!raw.includes(credential), 'credential A appeared in recorded terminal output')
    assert.ok(!raw.includes(credentialB), 'credential B appeared in recorded terminal output')
    await mkdir(dirname(castPath), { recursive: true, mode: 0o700 })
    const header = {
      version: 2,
      width: columns,
      height: rows,
      timestamp: castTimestamp,
      title: `Braid 0.3.4 CLI proof ${columns}x${rows}; loopback writes refused; output only`,
      env: { TERM: 'xterm-256color', BRAID_PACKAGE: evidence.version ?? '0.3.4' },
    }
    await chmod(castPath, 0o600)
    await writeFile(
      castPath,
      `${[header, ...castEvents].map((event) => JSON.stringify(event)).join('\n')}\n`,
    )
    evidence.recording = {
      path: castPath,
      events: castEvents.length,
      mode: 'PTY output only; key events are omitted, but rendered prompt text may appear; process boundaries are labeled',
    }
  }
  console.log(JSON.stringify({ ...evidence, requests, frames }, null, 2))
  if (forcedCleanupExitMissing) process.exitCode = 1
}
