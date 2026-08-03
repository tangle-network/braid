import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { shellArgument } from './visual-capture-terminal.mjs'

const run = promisify(execFile)

export async function capturePlainFrame({ binary, repository, rawRoot }) {
  const environment = { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' }
  const fifoRoot = await mkdtemp(join(tmpdir(), 'braid-plain-capture-'))
  const stdoutPath = join(fifoRoot, 'stdout')
  const stderrPath = join(fifoRoot, 'stderr')
  await run('mkfifo', [stdoutPath, stderrPath])
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
  const session = spawn(
    '/bin/sh',
    [
      '-c',
      `{ printf '%s\\n' 'W6 plain proof'; } | exec ${shellArgument(binary)} --plain --fixture deterministic --no-color > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`,
    ],
    {
      cwd: repository,
      env: { ...environment, BRAID_JOURNAL_PATH: join(rawRoot, `plain-${randomUUID()}.journal`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let wrapperStderr = ''
  session.stdout.resume()
  session.stderr.setEncoding('utf8')
  session.stderr.on('data', (chunk) => {
    wrapperStderr += chunk
  })
  const exited = new Promise((resolve, reject) => {
    session.on('error', reject)
    session.on('close', (code) => resolve({ exitCode: code }))
  })
  const timeout = setTimeout(() => session.kill(), 5_000)
  const [exit] = await Promise.all([
    exited,
    readFifo(stdoutPath, output),
    readFifo(stderrPath, error),
  ])
  clearTimeout(timeout)
  await rm(fifoRoot, { force: true, recursive: true })
  if (exit.exitCode !== 0) throw new Error(`plain capture exited ${exit.exitCode}`)
  const stdout = output.value
  const stderr = `${wrapperStderr}${error.value}`
  const normalizedOutput = stdout.replace(/\r\n/gu, '\n').replace(/\r/gu, '')
  if ([0x1b, 0x9b].some((code) => normalizedOutput.includes(String.fromCharCode(code))))
    throw new Error('plain output contains terminal controls')
  if (stderr) throw new Error(`plain capture wrote stderr: ${stderr}`)
  return normalizedOutput
}
