import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [bin, ws, key, out] = process.argv.slice(2)
const turnTimeoutMs = Number(process.env.BRAID_BRIDGE_PROBE_TURN_TIMEOUT_MS ?? 240000)
if (!Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs <= 0) {
  throw new Error('BRAID_BRIDGE_PROBE_TURN_TIMEOUT_MS must be a positive integer')
}
const child = spawn('node', [bin, 'rpc', '--workspace', ws, '--database-key-file', key], {
  env: {
    ...process.env,
    BRAID_STATE_PATH: join(ws, '..', 'state.sqlite'),
    BRAID_CLI_BRIDGE_ENDPOINT: 'http://127.0.0.1:3391',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
const childExit = new Promise((resolve) => child.once('close', resolve))
let stderr = ''
child.stderr.on('data', (d) => {
  stderr += d
})
child.stdin.on('error', (error) => {
  stderr += error.message
})
const lines = []
const waiters = []
createInterface({ input: child.stdout }).on('line', (l) => {
  lines.push(l)
  writeFileSync(out, `${lines.join('\n')}\n`)
  for (const w of [...waiters]) w()
})
let n = 0
const send = (command, params, op = true) => {
  const requestId = `req-${++n}`
  child.stdin.write(
    `${JSON.stringify({
      version: 1,
      requestId,
      ...(op ? { operationId: `op-launch-${Date.now()}-${n}` } : {}),
      command,
      ...(params ? { params } : {}),
    })}\n`,
  )
  return requestId
}
const parsed = () =>
  lines.map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return {}
    }
  })
const until = (pred, ms, label) =>
  new Promise((res, rej) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      rej(new Error(`Bridge process exited before ${label}`))
      return
    }
    const cleanup = () => {
      clearTimeout(t)
      child.off('close', onClose)
      const index = waiters.indexOf(check)
      if (index !== -1) waiters.splice(index, 1)
    }
    const onClose = () => {
      cleanup()
      rej(new Error(`Bridge process exited before ${label}`))
    }
    const check = () => {
      const hit = parsed().find(pred)
      if (hit) {
        cleanup()
        res(hit)
      }
    }
    const t = setTimeout(() => {
      cleanup()
      rej(new Error(`${label} timed out after ${ms} ms`))
    }, ms)
    child.once('close', onClose)
    waiters.push(check)
    check()
  })
let first = false
let second = false
try {
  const init = send('initialize', { workspace: ws, subscribe: true }, false)
  const st = await until(
    (r) => r.requestId === init && (r.type === 'state' || r.type === 'error'),
    60000,
    'initialization',
  )
  if (st.type !== 'state') throw new Error('Bridge initialization failed')
  const conversationId = st.state.activeConversationId ?? st.state.conversationId
  if (!conversationId) throw new Error('Bridge has no conversation')

  const prompt = 'Which coding agent program are you running in? Answer with its name only.'
  const firstRequest = send('send', { conversationId, text: prompt })
  const firstAdmission = await until(
    (r) => r.requestId === firstRequest && (r.type === 'ack' || r.type === 'error'),
    30000,
    'first admission',
  )
  if (firstAdmission.type !== 'ack' || !firstAdmission.runId) {
    throw new Error('first Bridge run was not admitted')
  }
  const firstFinished = await until(
    (r) =>
      r.type === 'event' &&
      r.event?.kind === 'run.finished' &&
      r.event?.payload?.runId === firstAdmission.runId,
    turnTimeoutMs,
    'first run.finished',
  )
  if (firstFinished.event.payload.status !== 'completed') {
    throw new Error(`first Bridge run ended ${firstFinished.event.payload.status}`)
  }
  first = true

  const ov = send('set_run_override', { runner: 'codex', model: 'default' })
  const override = await until(
    (r) => r.requestId === ov && (r.type === 'state' || r.type === 'error' || r.type === 'ack'),
    20000,
    'runner override',
  )
  if (override.type === 'error') throw new Error('Bridge runner override failed')

  const secondRequest = send('send', { conversationId, text: prompt })
  const secondAdmission = await until(
    (r) => r.requestId === secondRequest && (r.type === 'ack' || r.type === 'error'),
    30000,
    'second admission',
  )
  if (
    secondAdmission.type !== 'ack' ||
    !secondAdmission.runId ||
    secondAdmission.runId === firstAdmission.runId
  ) {
    throw new Error('second Bridge run was not admitted with a new run id')
  }
  const secondFinished = await until(
    (r) =>
      r.type === 'event' &&
      r.event?.kind === 'run.finished' &&
      r.event?.payload?.runId === secondAdmission.runId,
    turnTimeoutMs,
    'second run.finished',
  )
  if (secondFinished.event.payload.status !== 'completed') {
    throw new Error(`second Bridge run ended ${secondFinished.event.payload.status}`)
  }
  second = true

  const exportFile = join(ws, '..', 'conversation-export.json')
  rmSync(exportFile, { force: true })
  const exp = send('export', { target: conversationId, format: 'json', destination: exportFile })
  const exported = await until(
    (r) => r.requestId === exp && (r.type === 'ack' || r.type === 'error'),
    20000,
    'conversation export',
  )
  if (exported.type !== 'ack' || exported.command !== 'export') {
    throw new Error('Bridge export was not acknowledged')
  }
  const document = JSON.parse(readFileSync(exportFile, 'utf8'))
  if (
    document.conversationId !== conversationId ||
    document.contentDigest !== exported.result?.contentDigest ||
    ![firstAdmission.runId, secondAdmission.runId].every((id) =>
      document.content?.runs?.some((run) => run.id === id && run.status === 'completed'),
    )
  ) {
    throw new Error('Bridge export does not match both completed runs')
  }
  send('shutdown')
} catch (error) {
  process.exitCode = 1
  console.error('Bridge proof failed:', error)
  child.kill('SIGKILL')
}
const shutdownTimer = setTimeout(() => {
  process.exitCode = 1
  console.error('Bridge process did not exit after shutdown')
  child.kill('SIGKILL')
}, 10000)
const code = await childExit
clearTimeout(shutdownTimer)
writeFileSync(out, `${lines.join('\n')}\n`)
if (code !== 0) process.exitCode = 1
console.log(
  JSON.stringify({ exit: code, first, second, lines: lines.length, stderr: stderr.slice(0, 500) }),
)
