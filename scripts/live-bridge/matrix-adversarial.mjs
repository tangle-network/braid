import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StreamingRedactor } from './capture.mjs'
import { runCommand } from './command.mjs'
import { appendBounded, RpcSession, sleep } from './process.mjs'
import { evidenceValue, redactString } from './redaction.mjs'

async function waitForPidGone(pid, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await sleep(50)
  }
  return false
}

async function waitForPidFile(path, child, stderr, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = Number(await readFile(path, 'utf8').catch(() => '0'))
    if (Number.isInteger(value) && value > 0) return value
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Parent-crash fixture exited before writing ${path}: ${stderr()}`)
    await sleep(25)
  }
  throw new Error(`Parent-crash fixture did not write ${path} within ${timeoutMs}ms: ${stderr()}`)
}

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
  let crashParent
  let crashHostPid
  let crashTargetPid
  let crashDescendantPid
  try {
    const result = await runCommand(process.execPath, ['-e', script], {
      cwd: root,
      timeoutMs: 5_000,
      env: { PID_PATH: pidPath },
    })
    descendantPid = Number(await readFile(pidPath, 'utf8').catch(() => '0'))
    assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true, JSON.stringify(result))
    assert.equal(result.timedOut, true)
    assert.equal(result.termination.forcedKill, true)
    assert.equal(
      result.termination.strategy,
      process.platform === 'win32' ? 'windows-job-object' : 'process-group',
    )
    assert.equal(result.cleanupOk, true, JSON.stringify(result.termination))
    assert.equal(result.termination.descendantsExited, true)
    assert.equal(result.termination.descendantsVerified, true)
    assert.equal(await waitForPidGone(descendantPid), true)

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
    assert.equal(natural.cleanupOk, true, JSON.stringify(natural.termination))
    if (process.platform === 'win32') assert.equal(natural.termination.tree.kernelContained, true)
    else assert.equal(natural.termination.termSent || natural.termination.killSent, true)
    assert.equal(await waitForPidGone(naturalDescendantPid), true)

    const rpcScript = join(root, 'rpc-natural.mjs')
    const rpcPidPath = join(root, 'rpc-descendant.pid')
    const rpcSource = [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      'process.stdin.resume()',
      "process.stdin.on('end', () => { const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: process.platform === 'win32', stdio: 'ignore' }); child.unref(); writeFileSync(process.env.PID_PATH, String(child.pid)); setTimeout(() => process.exit(0), 20) })",
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
    const rpcDescendantPid = Number(await readFile(rpcPidPath, 'utf8').catch(() => '0'))
    assert.equal(
      Number.isInteger(rpcDescendantPid) && rpcDescendantPid > 0,
      true,
      JSON.stringify(rpcResult),
    )
    assert.equal(rpcResult.termination.exited, true)
    assert.equal(rpcResult.exit.code, 0, JSON.stringify(rpcResult))
    if (process.platform === 'win32') {
      assert.equal(rpcResult.termination.cleanupStatus, 'natural-exit')
      assert.equal(rpcResult.termination.tree.kernelContained, true)
    } else {
      assert.equal(
        ['term', 'kill'].includes(rpcResult.termination.cleanupStatus),
        true,
        JSON.stringify(rpcResult.termination),
      )
      assert.equal(rpcResult.termination.termSent || rpcResult.termination.killSent, true)
    }
    assert.equal(rpcResult.termination.descendantsExited, true)
    assert.equal(rpcResult.termination.descendantsVerified, true)
    assert.equal(await waitForPidGone(rpcDescendantPid), true)

    if (process.platform === 'win32') {
      const crashTargetPath = join(root, 'crash-target.mjs')
      const crashParentPath = join(root, 'crash-parent.mjs')
      const crashHostPidPath = join(root, 'crash-host.pid')
      const crashTargetPidPath = join(root, 'crash-target.pid')
      const crashDescendantPidPath = join(root, 'crash-descendant.pid')
      const crashTargetSource = [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        'writeFileSync(process.env.TARGET_PID_PATH, String(process.pid))',
        "const child = spawn(process.execPath, ['-e', \"setInterval(() => {}, 1000)\"], { detached: true, stdio: 'ignore' })",
        'child.unref()',
        'writeFileSync(process.env.DESCENDANT_PID_PATH, String(child.pid))',
        'setInterval(() => {}, 1000)',
      ].join('\n')
      const processModuleUrl = new URL('./process.mjs', import.meta.url).href
      const crashParentSource = [
        "import { writeFileSync } from 'node:fs'",
        `import { managedSpawn } from ${JSON.stringify(processModuleUrl)}`,
        'const child = await managedSpawn(process.execPath, [process.env.TARGET_PATH], {',
        '  cwd: process.env.TEST_ROOT,',
        '  env: process.env,',
        "  stdio: ['ignore', 'ignore', 'ignore'],",
        '})',
        'writeFileSync(process.env.HOST_PID_PATH, String(child.pid))',
        'setInterval(() => {}, 1000)',
      ].join('\n')
      await writeFile(crashTargetPath, crashTargetSource)
      await writeFile(crashParentPath, crashParentSource)
      let crashStderr = ''
      crashParent = spawn(process.execPath, [crashParentPath], {
        cwd: root,
        env: {
          ...process.env,
          DESCENDANT_PID_PATH: crashDescendantPidPath,
          HOST_PID_PATH: crashHostPidPath,
          TARGET_PATH: crashTargetPath,
          TARGET_PID_PATH: crashTargetPidPath,
          TEMP: root,
          TEST_ROOT: root,
          TMP: root,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
      crashParent.stderr.setEncoding('utf8')
      crashParent.stderr.on('data', (chunk) => {
        crashStderr = appendBounded(crashStderr, chunk, 16_384)
      })
      const crashParentExit = new Promise((resolve) => {
        crashParent.once('close', (code, signal) => resolve({ code, signal }))
      })
      const stderr = () => crashStderr
      ;[crashHostPid, crashTargetPid, crashDescendantPid] = await Promise.all([
        waitForPidFile(crashHostPidPath, crashParent, stderr),
        waitForPidFile(crashTargetPidPath, crashParent, stderr),
        waitForPidFile(crashDescendantPidPath, crashParent, stderr),
      ])
      assert.equal(crashParent.kill('SIGKILL'), true)
      const crashExit = await crashParentExit
      assert.equal(crashExit.code === null || crashExit.code !== 0, true, JSON.stringify(crashExit))
      assert.equal(await waitForPidGone(crashHostPid, 100), true)
      assert.equal(await waitForPidGone(crashTargetPid, 100), true)
      assert.equal(await waitForPidGone(crashDescendantPid, 100), true)
    }

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
        crashParent?.pid,
        crashHostPid,
        crashTargetPid,
        crashDescendantPid,
        Number(await readFile(join(root, 'natural-descendant.pid'), 'utf8').catch(() => '0')),
        Number(await readFile(join(root, 'rpc-descendant.pid'), 'utf8').catch(() => '0')),
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
