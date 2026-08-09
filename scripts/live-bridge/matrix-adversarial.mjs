import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StreamingRedactor } from './capture.mjs'
import { runCommand } from './command.mjs'
import { appendBounded, RpcSession, sleep } from './process.mjs'
import { evidenceValue, redactString } from './redaction.mjs'
import { WindowsProcessTracker } from './windows-process-tracker.mjs'

async function runRedactionMatrix() {
  const value = evidenceValue({
    output: 'safe output with no credential material',
    tokenCount: 17,
    tokenizer: 'keep',
    secretSauce: 'keep',
    apiKeyId: 'keep',
    credentialConfigured: true,
    credentialRef: 'cred:v1:opaque',
  })
  assert.equal(value.tokenCount, 17)
  assert.equal(value.tokenizer, 'keep')
  assert.equal(value.secretSauce, 'keep')
  assert.equal(value.apiKeyId, 'keep')
  assert.equal(value.credentialConfigured, true)
  assert.equal(value.credentialRef, 'cred:v1:opaque')

  const stream = new StreamingRedactor()
  stream.push('bridge ready\n')
  assert.equal(typeof stream.snapshot(), 'string')
  stream.push('request complete\nbridge stopped\n')
  const finished = stream.finish()
  assert.equal(finished.includes('bridge ready'), true)
  assert.equal(finished.includes('request complete'), true)
  assert.equal(finished.includes('bridge stopped'), true)

  const monitor = { supported: true, unsubscribe() {} }
  const tracker = new WindowsProcessTracker(monitor)
  tracker.attach(100)
  tracker.record({ type: 'start', processId: 100, parentProcessId: 1, createdAt: '1' })
  tracker.record({ type: 'start', processId: 101, parentProcessId: 100, createdAt: '2' })
  tracker.record({ type: 'start', processId: 102, parentProcessId: 101, createdAt: '3' })
  tracker.record({ type: 'stop', processId: 101, createdAt: '4' })
  const windowsTree = tracker.status(false)
  assert.deepEqual(windowsTree.pids, [100, 102])
  assert.equal(windowsTree.gone, false)
  assert.deepEqual(windowsTree.roots, [100, 102])
  tracker.record({ type: 'stop', processId: 100, createdAt: '5' })
  assert.deepEqual(tracker.status(true).pids, [102])
  tracker.record({ type: 'stop', processId: 102, createdAt: '6' })
  assert.equal(tracker.status(true).gone, true)
}

async function runProcessMatrix() {
  const root = await mkdtemp(join(tmpdir(), 'braid-live-process-proof-'))
  const pidPath = join(root, 'descendant.pid')
  const script = [
    "import { spawn } from 'node:child_process'",
    "import { writeFileSync } from 'node:fs'",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' })",
    'writeFileSync(process.env.PID_PATH, String(child.pid))',
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
  ].join(';')
  let descendantPid
  try {
    const result = await runCommand(process.execPath, ['-e', script], {
      cwd: root,
      timeoutMs: 250,
      env: { PID_PATH: pidPath },
    })
    descendantPid = Number(await readFile(pidPath, 'utf8'))
    assert.equal(result.timedOut, true)
    assert.equal(result.termination.forcedKill, true)
    assert.equal(
      result.termination.strategy,
      process.platform === 'win32' ? 'windows-taskkill-tree' : 'process-group',
    )
    assert.equal(result.cleanupOk, true)
    assert.equal(result.termination.descendantsExited, true)
    assert.equal(result.termination.descendantsVerified, true)
    let alive = true
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        process.kill(descendantPid, 0)
      } catch {
        alive = false
        break
      }
      await sleep(50)
    }
    assert.equal(alive, false)

    const naturalPidPath = join(root, 'natural-descendant.pid')
    const orphanSource = [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: process.platform === 'win32', stdio: 'ignore' })",
      'child.unref()',
      'writeFileSync(process.env.PID_PATH, String(child.pid))',
    ].join(';')
    const naturalScript = [
      "import { spawn } from 'node:child_process'",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(orphanSource)}], { env: process.env, stdio: 'ignore' })`,
      "child.once('close', () => setTimeout(() => process.exit(0), 20))",
    ].join(';')
    const natural = await runCommand(process.execPath, ['-e', naturalScript], {
      cwd: root,
      timeoutMs: 5_000,
      env: { PID_PATH: naturalPidPath },
    })
    const naturalDescendantPid = Number(await readFile(naturalPidPath, 'utf8'))
    assert.equal(natural.code, 0)
    assert.equal(natural.cleanupOk, true)
    assert.equal(natural.termination.termSent || natural.termination.killSent, true)
    alive = true
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        process.kill(naturalDescendantPid, 0)
      } catch {
        alive = false
        break
      }
      await sleep(50)
    }
    assert.equal(alive, false)

    const rpcScript = join(root, 'rpc-natural.mjs')
    const rpcPidPath = join(root, 'rpc-descendant.pid')
    const rpcSource = [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      'process.stdin.resume()',
      "process.stdin.on('end', () => { const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); writeFileSync(process.env.PID_PATH, String(child.pid)); setTimeout(() => process.exit(0), 20) })",
    ].join('\n')
    await writeFile(rpcScript, rpcSource)
    const rpc = await RpcSession.create(
      rpcScript,
      root,
      {
        ...process.env,
        PID_PATH: rpcPidPath,
      },
      1_000,
    )
    const rpcResult = await rpc.close()
    assert.equal(rpcResult.termination.exited, true)
    assert.equal(['term', 'kill'].includes(rpcResult.termination.cleanupStatus), true)
    assert.equal(rpcResult.termination.termSent || rpcResult.termination.killSent, true)
    assert.equal(rpcResult.termination.descendantsExited, true)
    assert.equal(rpcResult.termination.descendantsVerified, true)

    const canary = 'chunked-boundary-canary-3e6a'
    const chunks = [
      `${'🙂'.repeat(600)}https://operator:`,
      canary.slice(0, 12),
      `${canary.slice(12)}@bridge.example/v1/chat?access_`,
      `token=${canary}&safe=keep`,
    ]
    const chunkScript = [
      `const chunks = ${JSON.stringify(chunks)}`,
      'let index = 0',
      'const emit = () => { if (index === chunks.length) process.exit(0); process.stdout.write(chunks[index]); process.stderr.write(chunks[index++]); setTimeout(emit, 10) }',
      'emit()',
    ].join(';')
    const captured = await runCommand(process.execPath, ['-e', chunkScript], {
      cwd: root,
      maxOutputBytes: 180,
    })
    const redacted = redactString(captured.stdout)
    const redactedStderr = redactString(captured.stderr)
    assert.equal(captured.code, 0)
    assert.equal(captured.cleanupOk, true)
    assert.equal(Buffer.byteLength(captured.stdout, 'utf8') <= 180, true)
    assert.equal(
      Buffer.byteLength(captured.stdout, 'utf8') < Buffer.byteLength(chunks.join(''), 'utf8'),
      true,
    )
    assert.equal(redacted.includes(canary), false)
    assert.equal(redacted.includes(canary.slice(0, 10)), false)
    assert.equal(redacted.includes(canary.slice(-10)), false)
    assert.equal(redacted.includes('Bearer chunked'), false)
    assert.equal(redacted.includes('operator:'), false)
    assert.equal(redacted.includes('safe=keep'), true)
    assert.equal(redactedStderr.includes(canary), false)
    assert.equal(redactedStderr.includes(canary.slice(0, 10)), false)
    assert.equal(redactedStderr.includes(canary.slice(-10)), false)
    assert.equal(redactedStderr.includes('Bearer chunked'), false)
    assert.equal(redactedStderr.includes('operator:'), false)
    assert.equal(redactedStderr.includes('safe=keep'), true)
    assert.equal(appendBounded('🙂🙂', '', 5).includes('\ufffd'), false)
    assert.equal(Buffer.byteLength(appendBounded('🙂🙂', '', 5), 'utf8') <= 5, true)
  } finally {
    if (process.platform === 'win32')
      for (const pid of [
        descendantPid,
        Number(await readFile(join(root, 'natural-descendant.pid'), 'utf8').catch(() => '0')),
      ]) {
        if (!Number.isInteger(pid) || pid <= 0) continue
        await runCommand('taskkill', ['/PID', String(pid), '/T', '/F'], {
          cwd: root,
          timeoutMs: 2_000,
        })
      }
    await rm(root, { force: true, recursive: true })
  }
}

export async function runAdversarialMatrix() {
  await runRedactionMatrix()
  await runProcessMatrix()
}
