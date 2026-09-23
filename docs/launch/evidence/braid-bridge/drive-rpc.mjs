import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [bin, ws, key, out] = process.argv.slice(2)
const child = spawn('node', [bin, 'rpc', '--workspace', ws, '--database-key-file', key], {
  env: {
    ...process.env,
    BRAID_STATE_PATH: join(ws, '..', 'state.sqlite'),
    BRAID_CLI_BRIDGE_ENDPOINT: 'http://127.0.0.1:3391',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (d) => {
  stderr += d
})
const lines = []
const waiters = []
createInterface({ input: child.stdout }).on('line', (l) => {
  lines.push(l)
  writeFileSync(out, lines.join('\n') + '\n')
  for (const w of [...waiters]) w()
})
let n = 0
const send = (command, params, op = true) => {
  const requestId = `req-${++n}`
  child.stdin.write(
    JSON.stringify({
      version: 1,
      requestId,
      ...(op ? { operationId: `op-launch-${Date.now()}-${n}` } : {}),
      command,
      ...(params ? { params } : {}),
    }) + '\n',
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
const until = (pred, ms) =>
  new Promise((res) => {
    const t = setTimeout(() => res(null), ms)
    const check = () => {
      const hit = parsed().find(pred)
      if (hit) {
        clearTimeout(t)
        res(hit)
      }
    }
    waiters.push(check)
    check()
  })
const init = send('initialize', { workspace: ws, subscribe: true }, false)
const st = await until(
  (r) => r.requestId === init && (r.type === 'state' || r.type === 'error'),
  60000,
)
if (!st || st.type === 'error') {
  console.log('init failed', JSON.stringify(st), stderr.slice(0, 2000))
  child.kill()
  process.exit(1)
}
const conversationId = st.state.activeConversationId ?? st.state.conversationId
console.error('init ok', conversationId, 'lines', lines.length)
const finished = (k) =>
  parsed().filter((r) => r.type === 'event' && r.event?.kind === 'run.finished').length >= k
const waitFinished = (k, ms) =>
  new Promise((res) => {
    const t0 = Date.now()
    const tick = () => {
      if (finished(k) || Date.now() - t0 > ms) res(finished(k))
      else setTimeout(tick, 500)
    }
    tick()
  })
send('send', {
  conversationId,
  text: 'Which coding agent program are you running in? Answer with its name only.',
})
const first = await waitFinished(1, 240000)
console.error('first', first, lines.length)
const ov = send('set_run_override', { runner: 'codex', model: 'default' })
await until(
  (r) => r.requestId === ov && (r.type === 'state' || r.type === 'error' || r.type === 'ack'),
  20000,
)
send('send', {
  conversationId,
  text: 'Which coding agent program are you running in? Answer with its name only.',
})
const second = await waitFinished(2, 240000)
const exp = send('export', {
  target: conversationId,
  format: 'json',
  destination: join(ws, '..', 'conversation-export.json'),
})
await until((r) => r.requestId === exp && r.type !== 'event', 20000)
send('shutdown')
child.on('close', (code) => {
  writeFileSync(out, lines.join('\n') + '\n')
  console.log(
    JSON.stringify({
      exit: code,
      first,
      second,
      lines: lines.length,
      stderr: stderr.slice(0, 500),
    }),
  )
})
