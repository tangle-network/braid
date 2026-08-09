import { spawn } from 'node:child_process'

import { StreamingRedactor } from './capture.mjs'
import { exitCodes } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import {
  processTreeStatus,
  releaseProcessTree,
  sendTreeSignal,
  waitForTreeGone,
} from './process-tree.mjs'
import { spawnWindowsJob } from './windows-job-host.mjs'

const defaultNaturalExitTimeoutMs = 2_000
const defaultTermTimeoutMs = 2_000
const defaultKillTimeoutMs = 2_000

export { appendBounded } from './capture.mjs'

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export async function managedSpawn(command, args, options) {
  if (process.platform === 'win32') return await spawnWindowsJob(command, args, options)
  return spawn(command, args, { ...options, detached: true })
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    let settled = false
    const finish = (exited) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('close', onClose)
      resolveExit(exited)
    }
    const onClose = () => finish(true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('close', onClose)
  })
}

function terminationResult(child, values) {
  const tree = values.tree ?? processTreeStatus(child)
  return {
    strategy: values.strategy,
    termTimeoutMs: values.termTimeoutMs,
    killTimeoutMs: values.killTimeoutMs,
    termSent: values.termSent,
    killSent: values.killSent,
    forcedKill: values.killSent,
    exited: values.exited,
    descendantsExited: tree.supported && tree.gone,
    descendantsVerified: tree.supported && tree.gone,
    cleanupStatus: values.cleanupStatus,
    termSignal: values.termSignal,
    killSignal: values.killSignal,
    tree,
  }
}

export async function observeNaturalExit(
  child,
  { naturalExitTimeoutMs = defaultNaturalExitTimeoutMs, treeTimeoutMs = defaultTermTimeoutMs } = {},
) {
  const exited = await waitForExit(child, naturalExitTimeoutMs)
  if (!exited)
    return terminationResult(child, {
      strategy: 'grace-period',
      termTimeoutMs: 0,
      killTimeoutMs: 0,
      termSent: false,
      killSent: false,
      exited: false,
      cleanupStatus: 'still-running',
    })
  const tree = await waitForTreeGone(child, treeTimeoutMs)
  const result = terminationResult(child, {
    strategy: tree.supported ? 'natural-exit' : 'unsupported',
    termTimeoutMs: naturalExitTimeoutMs,
    killTimeoutMs: treeTimeoutMs,
    termSent: false,
    killSent: false,
    exited: true,
    cleanupStatus: tree.supported && tree.gone ? 'natural-exit' : 'unsupported',
    tree,
  })
  if (result.cleanupStatus === 'natural-exit') releaseProcessTree(child)
  return result
}

export async function terminateProcess(
  child,
  { termTimeoutMs = defaultTermTimeoutMs, killTimeoutMs = defaultKillTimeoutMs } = {},
) {
  const initialTree = processTreeStatus(child)
  const initialExited = hasExited(child)
  let termSignal
  let killSignal
  let termSent = false
  let killSent = false
  let exited = initialExited
  let tree = initialTree
  const usesWindowsJob = tree.mechanism === 'windows-job-object'
  if (usesWindowsJob && !tree.gone) {
    killSignal = await sendTreeSignal(child, 'SIGKILL')
    killSent = killSignal.sent
    exited = exited || (await waitForExit(child, killTimeoutMs))
    tree = await waitForTreeGone(child, killTimeoutMs)
  }
  if (!usesWindowsJob && (!tree.supported || !tree.gone)) {
    termSignal = await sendTreeSignal(child, 'SIGTERM')
    termSent = termSignal.sent
    exited = exited || (await waitForExit(child, termTimeoutMs))
    tree = await waitForTreeGone(child, termTimeoutMs)
  }
  if (!usesWindowsJob && (!tree.supported || !tree.gone)) {
    killSignal = await sendTreeSignal(child, 'SIGKILL')
    killSent = killSignal.sent
    exited = exited || (await waitForExit(child, killTimeoutMs))
    tree = await waitForTreeGone(child, killTimeoutMs)
  }
  const strategy =
    termSignal?.method ??
    killSignal?.method ??
    (initialTree.supported ? 'already-exited' : 'unsupported')
  const cleanupStatus = !tree.supported
    ? 'unsupported'
    : tree.gone && !termSent && !killSent
      ? 'already-exited'
      : tree.gone && !killSent
        ? 'term'
        : tree.gone
          ? 'kill'
          : 'descendants-still-running'
  const result = terminationResult(child, {
    strategy,
    termTimeoutMs,
    killTimeoutMs,
    termSent,
    killSent,
    exited,
    cleanupStatus,
    termSignal,
    killSignal,
    tree,
  })
  releaseProcessTree(child)
  return result
}

async function boundedExit(exit, timeoutMs) {
  return await Promise.race([exit, sleep(timeoutMs).then(() => ({ timeout: true }))])
}

export class RpcSession {
  constructor(binary, workspace, env, timeoutMs) {
    this.binary = binary
    this.workspace = workspace
    this.env = env
    this.timeoutMs = timeoutMs
    this.responses = []
    this.stdout = ''
    this.stderr = ''
    this.stdoutCapture = new StreamingRedactor()
    this.stderrCapture = new StreamingRedactor()
    this.buffer = ''
    this.waiters = new Set()
  }

  static async create(binary, workspace, env, timeoutMs) {
    const session = new RpcSession(binary, workspace, env, timeoutMs)
    await session.#start()
    return session
  }

  async #start() {
    this.child = await managedSpawn(process.execPath, [this.binary, 'rpc'], {
      cwd: this.workspace,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.exit = new Promise((resolveExit, rejectExit) => {
      this.child.once('error', rejectExit)
      this.child.once('close', (code, signal) => {
        this.closed = true
        for (const waiter of this.waiters)
          waiter.reject(
            new LiveBridgeError(
              'RPC_PROCESS_EXITED',
              `packed Braid RPC exited before ${waiter.label} completed`,
              exitCodes.failed,
              { code, signal },
            ),
          )
        this.waiters.clear()
        resolveExit({ code, signal })
      })
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      this.#onStdout(chunk)
      this.stdout = this.stdoutCapture.push(chunk)
    })
    this.child.stderr.on('data', (chunk) => {
      this.stderr = this.stderrCapture.push(chunk)
    })
  }

  send(request) {
    if (this.closed || this.child.stdin.destroyed)
      throw new LiveBridgeError(
        'RPC_INPUT_CLOSED',
        'packed Braid RPC input closed before the request was sent',
        exitCodes.failed,
      )
    this.child.stdin.write(`${JSON.stringify(request)}\n`)
  }

  async waitFor(label, predicate, timeoutMs = this.timeoutMs) {
    const existing = this.responses.find(predicate)
    if (existing) return existing
    return new Promise((resolveWait, rejectWait) => {
      const waiter = { label, predicate, resolve: resolveWait, reject: rejectWait }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        rejectWait(
          new LiveBridgeError('RPC_TIMEOUT', `timed out waiting for ${label}`, exitCodes.failed, {
            timeoutMs,
          }),
        )
      }, timeoutMs)
      waiter.resolve = (value) => {
        clearTimeout(timer)
        resolveWait(value)
      }
      waiter.reject = (error) => {
        clearTimeout(timer)
        rejectWait(error)
      }
      this.waiters.add(waiter)
    })
  }

  async close() {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = (async () => {
      if (!this.child.stdin.destroyed) this.child.stdin.end()
      const natural = await observeNaturalExit(this.child)
      const termination =
        natural.cleanupStatus === 'natural-exit' ? natural : await terminateProcess(this.child)
      this.stdout = this.stdoutCapture.finish()
      this.stderr = this.stderrCapture.finish()
      const exit = await boundedExit(
        this.exit.catch((error) => ({
          error: error instanceof Error ? error.message : String(error),
        })),
        defaultKillTimeoutMs,
      )
      return { termination, natural, exit }
    })()
    return this.closePromise
  }

  #onStdout(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      if (line.trim()) {
        try {
          const response = JSON.parse(line)
          this.responses.push(response)
          for (const waiter of this.waiters) {
            if (!waiter.predicate(response)) continue
            this.waiters.delete(waiter)
            waiter.resolve(response)
            break
          }
        } catch {
          this.responses.push({ type: 'malformed', line })
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }
}
