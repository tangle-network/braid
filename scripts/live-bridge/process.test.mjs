import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { mock } from 'node:test'
import * as pty from 'node-pty'
import { runCommand } from './command.mjs'
import { managedSpawn, RpcSession, terminateProcess } from './process.mjs'
import {
  processTreeEnvironment,
  processTreeStatus,
  sendTreeSignal,
  terminateTrackedProcessTree,
  trackProcessTree,
  waitForTreeGone,
} from './process-tree.mjs'

function waitForClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}

async function waitForFile(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

test('termination evidence marks a naturally exited process as unsignalled', async () => {
  const child = await managedSpawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  })
  await waitForClose(child)

  const result = await terminateProcess(child, { termTimeoutMs: 100, killTimeoutMs: 100 })

  assert.equal(result.initialExited, true)
  assert.equal(result.termSent, false)
  assert.equal(result.killSent, false)
  assert.equal(result.cleanupStatus, 'already-exited')
})

test('termination evidence records signal-driven process-tree cleanup', async () => {
  const child = await managedSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })

  const result = await terminateProcess(child, { termTimeoutMs: 1_000, killTimeoutMs: 1_000 })

  assert.equal(result.initialExited, false)
  assert.equal(result.initialTree.supported, true)
  assert.equal(result.initialTree.gone, false)
  assert.equal(result.termSent || result.killSent, true)
  assert.equal(result.exited, true)
  assert.equal(result.descendantsExited, true)
  assert.equal(result.descendantsVerified, true)
  assert.notEqual(result.cleanupStatus, 'already-exited')
})

test('tracked process-tree termination verifies absence without a child close event', async () => {
  const child = await managedSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })

  const result = await terminateTrackedProcessTree(child, {
    termTimeoutMs: 1_000,
    killTimeoutMs: 1_000,
  })

  assert.equal(result.termSent || result.killSent, true)
  assert.equal(result.descendantsExited, true, JSON.stringify(result))
  assert.equal(result.descendantsVerified, true, JSON.stringify(result))
  assert.equal(result.tree.gone, true, JSON.stringify(result))
})

test('tracked PTY termination verifies the exact process group used by live proofs', {
  skip: process.platform === 'win32',
}, async () => {
  const tracked = processTreeEnvironment(process.env)
  const child = pty.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: process.cwd(),
    env: tracked.environment,
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
  })
  trackProcessTree(child, tracked.token)

  const result = await terminateTrackedProcessTree(child, {
    termTimeoutMs: 1_000,
    killTimeoutMs: 1_000,
  })

  assert.equal(result.termSent || result.killSent, true)
  assert.equal(result.descendantsExited, true, JSON.stringify(result))
  assert.equal(result.descendantsVerified, true, JSON.stringify(result))
  assert.equal(result.tree.gone, true, JSON.stringify(result))
})

test('timeout cleanup terminates a tracked descendant set', async () => {
  const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: process.cwd(),
    timeoutMs: 50,
  })

  assert.equal(result.timedOut, true)
  assert.equal(result.cleanupOk, true, JSON.stringify(result.termination))
  assert.equal(result.termination.descendantsExited, true)
  assert.equal(result.termination.descendantsVerified, true)
})

test('missing POSIX owner identity refuses cleanup', async () => {
  const child = { pid: undefined }
  const status = processTreeStatus(child)

  assert.equal(status.supported, false)
  assert.equal(status.gone, false)
  assert.match(
    status.reason,
    /lifecycle tracker|valid owner PID|Windows Job Object host process id/u,
  )
  assert.deepEqual(await waitForTreeGone(child, 0), status)
  const signal = await sendTreeSignal(child, 'SIGTERM')
  assert.equal(signal.sent, false)
  assert.equal(
    signal.method,
    process.platform === 'win32' ? 'windows-job-object-unavailable' : 'unavailable',
  )
})

test('detached descendants stay owned after their parent exits', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-process-tree-'))
  const pidPath = join(root, 'detached.pid')
  let descendantPid
  try {
    const child = await managedSpawn(
      process.execPath,
      [
        '-e',
        [
          "import { spawn } from 'node:child_process'",
          "import { writeFileSync } from 'node:fs'",
          "const detached = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: 'ignore' })",
          'detached.unref()',
          'writeFileSync(process.env.PID_PATH, String(detached.pid))',
          'setTimeout(() => process.exit(0), 200)',
        ].join(';'),
      ],
      { cwd: root, env: { PID_PATH: pidPath }, stdio: 'ignore' },
    )
    descendantPid = Number(await waitForFile(pidPath))
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)
    await waitForClose(child)

    const observed = processTreeStatus(child)
    assert.equal(observed.supported, true, JSON.stringify(observed))
    assert.equal(observed.gone, false, JSON.stringify(observed))
    assert.equal(observed.escaped, true, JSON.stringify(observed))
    const stillRunning = await waitForTreeGone(child, 100)
    assert.equal(stillRunning.supported, true)
    assert.equal(stillRunning.gone, false)

    const termination = await terminateProcess(child, { termTimeoutMs: 100, killTimeoutMs: 1_000 })
    assert.equal(termination.descendantsExited, true, JSON.stringify(termination))
    assert.equal(termination.descendantsVerified, true, JSON.stringify(termination))
    assert.equal(await waitForTreeGone(child, 1_000).then((status) => status.gone), true)
  } finally {
    if (descendantPid !== undefined) {
      try {
        process.kill(descendantPid, 'SIGKILL')
      } catch {}
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('RPC stop cleanup proves terminal state and kills an unmarked process-group descendant', {
  skip: process.platform !== 'linux',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-rpc-stop-cleanup-'))
  const binary = join(root, 'rpc-child.mjs')
  const pidPath = join(root, 'descendant.pid')
  const source = `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

let buffer = ''
const run = { id: 'run-stop-proof', status: 'streaming' }
const emit = (value) => process.stdout.write(\`\${JSON.stringify(value)}\\n\`)
const state = () => emit({ type: 'state', state: { runs: [{ ...run }] } })
const respond = (request) => {
  if (request.command === 'initialize') {
    emit({ type: 'ack', requestId: request.requestId, command: request.command })
    state()
  } else if (request.command === 'cancel_run') {
    run.status = 'cancelled'
    emit({ type: 'ack', requestId: request.requestId, command: request.command })
    state()
  } else if (request.command === 'shutdown') {
    emit({ type: 'ack', requestId: request.requestId, command: request.command })
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\\n')
    if (newline < 0) break
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.length > 0) respond(JSON.parse(line))
  }
})
process.stdin.on('end', () => {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'inherit',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'BRAID_PROCESS_TREE_TOKEN')),
  })
  descendant.unref()
  writeFileSync(process.env.PID_PATH, String(descendant.pid))
  setTimeout(() => process.exit(0), 200)
})
`
  await writeFile(binary, source, { mode: 0o700 })

  let session
  try {
    session = await RpcSession.create(binary, root, { PID_PATH: pidPath }, 4_000)
    session.send({ requestId: 'request-initialize', command: 'initialize' })
    await session.waitFor(
      'running terminal state',
      (candidate) =>
        candidate.type === 'state' && candidate.state?.runs?.[0]?.status === 'streaming',
    )

    session.send({
      requestId: 'request-cancel',
      operationId: 'op-live-required-cancel-stop-proof',
      command: 'cancel_run',
      params: { runId: 'run-stop-proof' },
    })
    const stopped = await session.waitFor(
      'cancelled terminal state',
      (candidate) =>
        candidate.type === 'state' && candidate.state?.runs?.[0]?.status === 'cancelled',
    )
    assert.equal(stopped.state.runs[0].id, 'run-stop-proof')
    const closed = await session.close()
    assert.equal(closed.natural.cleanupStatus, 'still-running', JSON.stringify(closed))
    assert.equal(closed.termination.initialTree.processGroup, true, JSON.stringify(closed))
    assert.equal(closed.termination.termSignal?.method, 'process-group', JSON.stringify(closed))
    assert.equal(closed.termination.exited, true, JSON.stringify(closed))
    assert.equal(closed.termination.descendantsVerified, true, JSON.stringify(closed))
    assert.equal(closed.termination.tree.gone, true, JSON.stringify(closed))
    assert.equal(closed.exit.timeout, undefined, JSON.stringify(closed))
    assert.equal(closed.exit.code, 0, JSON.stringify(closed))
  } finally {
    try {
      const pid = Number(await readFile(pidPath, 'utf8'))
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
    } catch {}
    await session?.forceStop().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

test('refuses to signal a reused process group without an observed owner', {
  skip: process.platform !== 'linux',
}, async () => {
  const child = await managedSpawn(process.execPath, ['-e', 'process.exit(0)'], {
    stdio: 'ignore',
  })
  await waitForClose(child)

  const groupSignals = []
  const originalKill = process.kill
  const killMock = mock.method(process, 'kill', (pid, signal) => {
    if (pid === -child.pid) {
      if (signal !== 0) groupSignals.push({ pid, signal })
      if (signal === 0) return true
      const error = new Error('group signal must not be attempted')
      error.code = 'EPERM'
      throw error
    }
    return originalKill.call(process, pid, signal)
  })
  try {
    const result = await terminateTrackedProcessTree(child, {
      termTimeoutMs: 100,
      killTimeoutMs: 100,
    })

    assert.equal(result.termSent, false, JSON.stringify(result))
    assert.equal(result.killSent, false, JSON.stringify(result))
    assert.equal(result.tree.supported, false, JSON.stringify(result))
    assert.match(result.tree.reason, /without an observed tracked member/u)
    assert.deepEqual(groupSignals, [])
  } finally {
    killMock.mock.restore()
  }
})
