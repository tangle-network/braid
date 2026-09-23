import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
const root = mkdtempSync(join(tmpdir(), 'braid-launch-fixture-'))
try {
  const work = join(root, 'workspace')
  mkdirSync(work)
  const keyFile = join(root, 'db.key')
  const exportFile = join(process.cwd(), 'conversation-export.json')
  rmSync(exportFile, { force: true })
  writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 })
  const bin = process.argv[2]
  const child = spawn(
    'node',
    [bin, 'rpc', '--fixture', 'deterministic', '--workspace', work, '--database-key-file', keyFile],
    {
      env: { ...process.env, BRAID_STATE_PATH: join(root, 'state.sqlite') },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  const childExit = new Promise((resolve) => child.once('close', resolve))
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
      `${JSON.stringify({
        version: 1,
        requestId,
        ...(op ? { operationId: `op-${n}` } : {}),
        command,
        ...(params ? { params } : {}),
      })}\n`,
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
  let conversationId
  let branchId
  let failed = false
  try {
    const init = send('initialize', { workspace: work, subscribe: true }, false)
    const st = await until(
      (r) => r.requestId === init && (r.type === 'state' || r.type === 'error'),
    )
    if (st.type !== 'state') throw new Error('fixture initialization failed')
    const s = st.state
    conversationId = s.activeConversationId ?? s.conversationId ?? s.conversations?.[0]?.id
    branchId = s.activeBranchId ?? s.branchId ?? s.branches?.[0]?.id
    if (!conversationId || !branchId) throw new Error('fixture has no conversation or branch')

    const sent = send('send', { conversationId, branchId, text: 'hello from the launch probe' })
    const admission = await until(
      (r) => r.requestId === sent && (r.type === 'ack' || r.type === 'error'),
      30000,
    )
    if (admission.type !== 'ack' || !admission.runId) {
      throw new Error('fixture run was not admitted')
    }
    const finished = await until(
      (r) =>
        r.type === 'event' &&
        r.event?.kind === 'run.finished' &&
        r.event?.payload?.runId === admission.runId,
      30000,
    )
    if (finished.event.payload.status !== 'completed') {
      throw new Error(`fixture run ended ${finished.event.payload.status}`)
    }

    const exp = send('export', {
      target: conversationId,
      format: 'json',
      destination: exportFile,
    })
    const exported = await until(
      (r) => r.requestId === exp && (r.type === 'ack' || r.type === 'error'),
      10000,
    )
    if (exported.type !== 'ack' || exported.command !== 'export') {
      throw new Error('fixture export was not acknowledged')
    }
    const document = JSON.parse(readFileSync(exportFile, 'utf8'))
    if (
      document.conversationId !== conversationId ||
      document.contentDigest !== exported.result?.contentDigest ||
      !document.content?.runs?.some(
        (run) => run.id === admission.runId && run.status === 'completed',
      )
    ) {
      throw new Error('fixture export does not match the completed run')
    }
    send('shutdown')
  } catch (error) {
    failed = true
    process.exitCode = 1
    console.error('fixture proof failed:', error)
    child.kill('SIGKILL')
  }
  const shutdownTimer = setTimeout(() => {
    failed = true
    process.exitCode = 1
    console.error('fixture process did not exit after shutdown')
    child.kill('SIGKILL')
  }, 10000)
  const code = await childExit
  clearTimeout(shutdownTimer)
  writeFileSync('rpc-transcript.jsonl', `${lines.join('\n')}\n`)
  if (!failed && code !== 0) process.exitCode = 1
  console.log('exit', code, 'lines', lines.length, 'conv', conversationId, 'branch', branchId)
} finally {
  rmSync(root, { recursive: true, force: true })
}
