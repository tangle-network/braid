import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
const work = mkdtempSync(join(process.cwd(), 'ws-'))
const keyFile = join(process.cwd(), 'db.key')
writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 })
const bin = process.argv[2]
const child = spawn(
  'node',
  [bin, 'rpc', '--fixture', 'deterministic', '--workspace', work, '--database-key-file', keyFile],
  {
    env: { ...process.env, BRAID_STATE_PATH: join(work, 'state.sqlite') },
    stdio: ['pipe', 'pipe', 'inherit'],
  },
)
const lines = []
const waiters = []
createInterface({ input: child.stdout }).on('line', (line) => {
  lines.push(line)
  for (const w of [...waiters]) w()
})
let n = 0
const send = (command, params, op = true) => {
  const requestId = `req-${++n}`
  child.stdin.write(
    JSON.stringify({
      version: 1,
      requestId,
      ...(op ? { operationId: `op-${n}` } : {}),
      command,
      ...(params ? { params } : {}),
    }) + '\n',
  )
  return requestId
}
const until = (pred, ms = 20000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout')), ms)
    const check = () => {
      const hit = lines.map((l) => JSON.parse(l)).find(pred)
      if (hit) {
        clearTimeout(t)
        res(hit)
      }
    }
    waiters.push(check)
    check()
  })
const init = send('initialize', { workspace: work, subscribe: true }, false)
const st = await until((r) => r.requestId === init && r.type === 'state')
const s = st.state
const conversationId = s.activeConversationId ?? s.conversations?.[0]?.id
const branchId = s.activeBranchId ?? s.branches?.[0]?.id
send('send', { conversationId, branchId, text: 'hello from the launch probe' })
await until((r) => r.type === 'event' && r.event?.kind === 'run.finished', 30000).catch(() => null)
await new Promise((r) => setTimeout(r, 1500))
const exp = send('export', {
  target: conversationId,
  format: 'json',
  destination: join(process.cwd(), 'conversation-export.json'),
})
await until(
  (r) => r.requestId === exp && (r.type === 'result' || r.type === 'error' || r.type === 'ack'),
  10000,
).catch(() => null)
await new Promise((r) => setTimeout(r, 1500))
send('shutdown')
child.on('close', (code) => {
  writeFileSync('rpc-transcript.jsonl', lines.join('\n') + '\n')
  console.log('exit', code, 'lines', lines.length, 'conv', conversationId, 'branch', branchId)
})
