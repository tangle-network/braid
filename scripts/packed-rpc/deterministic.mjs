import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function runDeterministicRpcProof(binary, repository) {
  const requests = [
    {
      version: 1,
      requestId: 'req-init',
      command: 'initialize',
      params: { workspace: repository, subscribe: true },
    },
    {
      version: 1,
      requestId: 'req-send',
      operationId: 'op-packed-rpc',
      command: 'send',
      params: { text: 'packed rpc proof' },
    },
    {
      version: 1,
      requestId: 'req-stop',
      operationId: 'op-packed-shutdown',
      command: 'shutdown',
    },
  ]
  const fifoRoot = await mkdtemp(join(tmpdir(), 'braid-rpc-proof-'))
  const stdoutPath = join(fifoRoot, 'stdout')
  const stderrPath = join(fifoRoot, 'stderr')
  const journalPath = join(repository, `.braid/test-rpc-${randomUUID()}.jsonl`)
  try {
    await execFileAsync('mkfifo', [stdoutPath, stderrPath])
    const requestLine = (request) => `printf '%s\\n' ${shellArgument(JSON.stringify(request))}`
    const shellCommand = `{ ${requestLine(requests[0])}; ${requestLine(requests[1])}; sleep 1; ${requestLine(requests[2])}; } | exec ${shellArgument(binary)} rpc --fixture deterministic > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`
    const output = { value: '' }
    const error = { value: '' }
    const readFifo = (path, sink) =>
      new Promise((resolve, reject) => {
        const stream = createReadStream(path, { encoding: 'utf8' })
        stream.on('data', (chunk) => {
          sink.value += chunk
        })
        stream.on('error', reject)
        stream.on('end', resolve)
      })
    const session = spawn('/bin/sh', ['-c', shellCommand], {
      cwd: repository,
      env: {
        ...process.env,
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_JOURNAL_PATH: journalPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let wrapperStderr = ''
    session.stdout.resume()
    session.stderr.setEncoding('utf8')
    session.stderr.on('data', (chunk) => {
      wrapperStderr += chunk
    })
    const exited = new Promise((resolve, reject) => {
      session.on('error', reject)
      session.on('close', (code, signal) => resolve({ code, signal }))
    })
    const timeout = setTimeout(() => session.kill(), 5_000)
    const [exit] = await Promise.all([
      exited,
      readFifo(stdoutPath, output),
      readFifo(stderrPath, error),
    ])
    clearTimeout(timeout)
    if (exit.code !== 0)
      throw new Error(`packed RPC exited ${exit.code}\n${wrapperStderr}${error.value}`)
    const stdout = output.value
    const stderr = `${wrapperStderr}${error.value}`
    if (stderr) throw new Error(`packed RPC wrote stderr: ${stderr}`)
    const normalized = stdout.replace(/\r\n/gu, '\n').replace(/\r/gu, '')
    if (!normalized.trim()) throw new Error(`packed RPC produced no stdout; stderr=${stderr}`)
    const lines = normalized.trim().split('\n')
    const responses = lines.map((line) => JSON.parse(line))
    const state = responses
      .filter((response) => response.type === 'state' && response.requestId === 'req-send')
      .at(-1)
    if (state?.state.messages.at(-1)?.text !== 'Fixture response through pi: packed rpc proof')
      throw new Error(`packed RPC semantic proof failed\n${stdout}`)
    if (lines.some((line) => !line.startsWith('{')))
      throw new Error('packed RPC wrote non-JSONL stdout')
    process.stdout.write(`Packed RPC proof passed: ${lines.length} JSONL responses\n`)
  } finally {
    await rm(fifoRoot, { force: true, recursive: true })
    await rm(journalPath, { force: true })
  }
}
