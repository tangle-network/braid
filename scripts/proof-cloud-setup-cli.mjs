import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'

// Real executable, encrypted storage and HTTP. The endpoint deliberately refuses preflight.
// This proves setup and later submission, NOT successful execution in a live Tangle sandbox.
const repository = fileURLToPath(new URL('../', import.meta.url))
const binary = resolve(process.argv[2] ?? join(repository, 'dist/bin/braid.js'))
const publicProbe = process.argv.includes('--public-probe')
const compact = process.argv.includes('--compact')
const columns = compact ? 80 : 120
const rows = compact ? 24 : 40
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
const credential = randomBytes(24).toString('hex')
const requests = []
const server = createServer((request, response) => {
  requests.push({
    method: request.method,
    path: request.url,
    credentialReceived: Object.values(request.headers).some(
      (value) => typeof value === 'string' && value.includes(credential),
    ),
  })
  request.resume()
  response.writeHead(503, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { message: 'CLOUD_SETUP_LOOPBACK_REFUSAL' } }))
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
  provider: 'loopback HTTP preflight refusal; no live Tangle execution',
  publicProbe,
  columns,
  rows,
  commands: [],
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
  return value
}
async function openSetup() {
  await key('\u000b')
  await expect(/Setup/u)
  capture('setup menu')
  await key('\u001b[B')
  await key('\r')
  await expect(/choose an AgentProfile/u)
  await key('\r')
  await expect(/choose a connection/u)
  await key('\r')
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
  child.onExit((value) => {
    exit = value
  })
  child.onData((chunk) => {
    raw += chunk
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
    assert.equal(requests.length, 0)
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
    assert.equal(requests.length, 0)
    const afterSave = await snapshot()
    assert.equal(afterSave.state.runs.length, 0)
    await key('\u001b')
    await reopenedWorkspace('reopened in same process')
    assert.deepEqual(await readFile(configPath), savedBytes)
    assert.equal(requests.length, 0)
    // A later user submission must reach the existing authenticated provider preflight.
    await key('CLOUD_SETUP_LATER_TASK\r')
    await expect(/SERVER_ERROR/u)
    assert.ok(requests.length > 0)
    assert.ok(requests.some((request) => request.credentialReceived))
    capture('later explicit submission; unchanged provider refusal')
    await key('\u001b')
    await stop()
    const beforeReloadRequests = requests.length
    await start(endpoint, 'disk-reloaded-cli')
    await reopenedWorkspace('reopened after encrypted disk reload')
    assert.deepEqual(await readFile(configPath), savedBytes)
    assert.equal(requests.length, beforeReloadRequests)
    await key('CLOUD_SETUP_RELOADED_TASK\r')
    await expect(/SERVER_ERROR/u)
    assert.ok(requests.slice(beforeReloadRequests).some((request) => request.credentialReceived))
    capture('reloaded credential used by later submission')
    await key('\u001b')
    evidence.afterSaveRunCount = afterSave.state.runs.length
    evidence.savedWorkspaceRequest = saved.workspaceRequest
    evidence.savedLifecycle = connection.providerOptions.lifecycle
    evidence.result =
      'save, same-process reopen, cancel, disk reload and authenticated preflight verified; no cloud task completed'
  }
  await stop()
  evidence.exit = exit
} finally {
  if (child && exit === undefined) child.kill('SIGKILL')
  emulator?.dispose()
  server.closeAllConnections()
  if (server.listening) await new Promise((done) => server.close(done))
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ ...evidence, requests, frames }, null, 2))
}
