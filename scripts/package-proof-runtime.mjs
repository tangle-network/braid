import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import * as pty from 'node-pty'
import { nativeInstallEnvironment } from './native-install-environment.mjs'

export const repository = new URL('../', import.meta.url).pathname
const SOURCE_EXCLUSIONS = new Set(['.git', 'node_modules', 'dist', '.test-dist', 'artifacts'])

export async function sourceDigest(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SOURCE_EXCLUSIONS.has(entry.name) || entry.name.startsWith('.test-dist-')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await walk(root)
  files.sort()
  const digest = createHash('sha256')
  for (const path of files) {
    digest.update(relative(root, path))
    digest.update('\0')
    digest.update(await readFile(path))
    digest.update('\0')
  }
  return digest.digest('hex')
}

export const gitValue = (...args) => {
  if (args.join(' ') === 'rev-parse HEAD' && process.env.BRAID_PACKAGE_PROOF_COMMIT)
    return process.env.BRAID_PACKAGE_PROOF_COMMIT
  if (args.join(' ') === 'rev-parse HEAD^{tree}' && process.env.BRAID_PACKAGE_PROOF_TREE)
    return process.env.BRAID_PACKAGE_PROOF_TREE
  try {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
  } catch (error) {
    if (error?.status === 0 && typeof error.stdout === 'string') return error.stdout.trim()
    throw error
  }
}

export function cleanEnvironment(extra = {}) {
  const environment = { ...process.env, ...extra }
  delete environment.FORCE_COLOR
  return environment
}

export function installEnvironment() {
  return nativeInstallEnvironment(cleanEnvironment())
}

export async function run(file, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? cleanEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${file} ${args.join(' ')} exited ${code}\n${stdout}\n${stderr}`))
    })
  })
}

export function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function runFifoCommand(command, cwd, env) {
  const fifoRoot = await mkdtemp(join(tmpdir(), 'braid-fifo-'))
  const stdoutPath = join(fifoRoot, 'stdout')
  const stderrPath = join(fifoRoot, 'stderr')
  await run('mkfifo', [stdoutPath, stderrPath])
  const readFifo = (path, sink) =>
    new Promise((resolve, reject) => {
      const stream = createReadStream(path, { encoding: 'utf8' })
      stream.on('data', (chunk) => {
        sink.value += chunk
      })
      stream.on('error', reject)
      stream.on('end', resolve)
    })
  const stdoutRead = { value: '' }
  const stderrRead = { value: '' }
  const child = spawn('/bin/sh', ['-c', command(stdoutPath, stderrPath)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let wrapperStderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    wrapperStderr += chunk
  })
  child.stdout.resume()
  const close = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  })
  const timeout = setTimeout(() => child.kill(), 5_000)
  try {
    const [exitCode] = await Promise.all([
      close,
      readFifo(stdoutPath, stdoutRead),
      readFifo(stderrPath, stderrRead),
    ])
    if (exitCode !== 0)
      throw new Error(`fifo command exited ${exitCode}\n${wrapperStderr}\n${stderrRead.value}`)
    return { stdout: stdoutRead.value, stderr: `${wrapperStderr}${stderrRead.value}` }
  } finally {
    clearTimeout(timeout)
    await rm(fifoRoot, { force: true, recursive: true })
  }
}

export async function runPty(file, args, options = {}) {
  const session = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 240,
    rows: 80,
    cwd: options.cwd,
    env: options.env ?? cleanEnvironment({ NODE_NO_WARNINGS: '1' }),
  })
  let stdout = ''
  session.onData((chunk) => {
    stdout += chunk
  })
  const exit = await new Promise((resolve) => session.onExit(resolve))
  if (exit.exitCode !== 0)
    throw new Error(`${file} ${args.join(' ')} exited ${exit.exitCode}\n${stdout}`)
  return { stdout: stdout.replace(/\r\n/gu, '\n').replace(/\r/gu, ''), stderr: '' }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}
