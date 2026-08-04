import { spawn } from 'node:child_process'

import { REQUIRED_CHECKS } from '../release-check-catalog.mjs'
import { PROCESS_TREE_STRATEGY, reapChildTree, terminateChildTree } from './process-tree.mjs'
import {
  BoundedCapture,
  collectRedactionSecrets,
  redactText,
  sanitizeArgv,
  sanitizeEnvironment,
} from './redaction.mjs'

export {
  BoundedCapture,
  collectRedactionSecrets,
  PROCESS_TREE_STRATEGY,
  redactText,
  sanitizeArgv,
  sanitizeEnvironment,
}

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
export const DEFAULT_MAX_LOG_BYTES = 64 * 1024
const MAX_SETTLEMENT_GRACE_MS = 1_500

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function timestamp(milliseconds) {
  return new Date(Math.trunc(milliseconds)).toISOString()
}

function emptyCapture(maxLogBytes, secrets) {
  return new BoundedCapture(maxLogBytes, secrets).finish()
}

async function boundedAwait(promise, timeoutMs, fallback) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function settledSpawnError({ startedMilliseconds, maxLogBytes, secrets, error }) {
  const completedMilliseconds = Date.now()
  return {
    startedAt: timestamp(startedMilliseconds),
    completedAt: timestamp(completedMilliseconds),
    durationMs: Math.max(0, completedMilliseconds - startedMilliseconds),
    exitCode: null,
    signal: null,
    timedOut: false,
    settlementTimedOut: false,
    spawnError: redactText(error instanceof Error ? error.message : String(error), secrets),
    processTreeStrategy: PROCESS_TREE_STRATEGY,
    cleanupConfirmed: true,
    stdout: emptyCapture(maxLogBytes, secrets),
    stderr: emptyCapture(maxLogBytes, secrets),
  }
}

export function catalogCommandArgv(command) {
  const expected = [...REQUIRED_CHECKS.values()].some((entry) => entry.command === command)
  assert(expected, `Command is not in the release catalog: ${command}`)
  const parts = command.trim().split(/\s+/u)
  assert(parts[0] === 'pnpm' && parts.length > 1, `Catalog command is not a pnpm argv: ${command}`)
  assert(
    parts.every((part) => !part.includes('\0') && !part.includes('\n') && !part.includes('\r')),
    'Catalog command contains control input',
  )
  return Object.freeze({ file: parts[0], args: Object.freeze(parts.slice(1)) })
}

export async function executeArgv({
  file,
  args,
  cwd,
  environment,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  settlementGraceMs = MAX_SETTLEMENT_GRACE_MS,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  redactionSecrets = [],
  spawnProcess = spawn,
}) {
  assert(typeof file === 'string' && file.length > 0, 'Executable is required')
  assert(Array.isArray(args), 'Executable arguments must be an array')
  assert(typeof cwd === 'string' && cwd.length > 0, 'Command cwd is required')
  assert(Number.isInteger(timeoutMs) && timeoutMs > 0, 'Command timeout must be positive')
  assert(
    Number.isInteger(settlementGraceMs) && settlementGraceMs > 0,
    'Settlement grace must be positive',
  )
  const startedMilliseconds = Date.now()
  const secrets = collectRedactionSecrets(environment, redactionSecrets)
  const stdout = new BoundedCapture(maxLogBytes, secrets)
  const stderr = new BoundedCapture(maxLogBytes, secrets)
  let child
  try {
    child = spawnProcess(file, args, {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    return settledSpawnError({ startedMilliseconds, maxLogBytes, secrets, error })
  }

  let timedOut = false
  let spawnError
  let timeout
  let settlementTimer
  let settlementDeadline
  let terminationPromise
  let parentExitCleanup
  return new Promise((resolve) => {
    let settled = false
    const finish = async (exitCode, signal, settlementTimedOut = false) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(settlementTimer)
      const waitForCleanup = async (promise, fallback) => {
        if (settlementTimedOut) return fallback
        const remaining =
          settlementDeadline === undefined ? 800 : Math.max(0, settlementDeadline - Date.now())
        return boundedAwait(promise, remaining, fallback)
      }
      const terminationConfirmed = terminationPromise
        ? await waitForCleanup(terminationPromise, false)
        : !settlementTimedOut
      const reapPromise =
        parentExitCleanup ??
        Promise.resolve()
          .then(() => reapChildTree(child, 800))
          .catch(() => false)
      const reapConfirmed = settlementTimedOut ? false : await waitForCleanup(reapPromise, false)
      const settlementExpired = settlementDeadline !== undefined && Date.now() >= settlementDeadline
      const cleanupConfirmed =
        terminationConfirmed && reapConfirmed && !settlementTimedOut && !settlementExpired
      child.stdout?.destroy()
      child.stderr?.destroy()
      const completedMilliseconds = Date.now()
      resolve({
        startedAt: timestamp(startedMilliseconds),
        completedAt: timestamp(completedMilliseconds),
        durationMs: Math.max(0, completedMilliseconds - startedMilliseconds),
        exitCode: typeof exitCode === 'number' ? exitCode : null,
        signal: signal ?? null,
        timedOut,
        settlementTimedOut: settlementTimedOut || settlementExpired,
        spawnError: spawnError ? redactText(spawnError.message, secrets) : null,
        processTreeStrategy: PROCESS_TREE_STRATEGY,
        cleanupConfirmed,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      })
    }
    const settleAfterBound = () => {
      void finish(null, 'SIGKILL', true)
    }
    child.stdout?.on('data', (chunk) => stdout.push(chunk))
    child.stderr?.on('data', (chunk) => stderr.push(chunk))
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error))
      void finish(null, null)
    })
    child.once('exit', () => {
      parentExitCleanup = Promise.resolve()
        .then(() => reapChildTree(child, 800))
        .catch(() => false)
    })
    child.once('close', (exitCode, signal) => {
      void finish(exitCode, signal)
    })
    timeout = setTimeout(() => {
      timedOut = true
      settlementDeadline = Date.now() + settlementGraceMs
      terminationPromise = Promise.resolve()
        .then(() => terminateChildTree(child, 900))
        .catch(() => false)
      settlementTimer = setTimeout(settleAfterBound, settlementGraceMs)
    }, timeoutMs)
  })
}

export async function executeCatalogCheck({
  checkId,
  cwd,
  environment,
  timeoutMs,
  maxLogBytes,
  redactionSecrets = [],
}) {
  const entry = REQUIRED_CHECKS.get(checkId)
  assert(entry, `Unknown release check: ${checkId}`)
  const command = catalogCommandArgv(entry.command)
  const processResult = await executeArgv({
    ...command,
    cwd,
    environment,
    timeoutMs,
    maxLogBytes,
    redactionSecrets,
  })
  return {
    checkId,
    category: entry.category,
    command: entry.command,
    argv: [command.file, ...command.args],
    sanitizedArgv: sanitizeArgv(
      [command.file, ...command.args],
      collectRedactionSecrets(environment, redactionSecrets),
    ),
    sanitizedEnvironment: sanitizeEnvironment(environment),
    ...processResult,
  }
}
