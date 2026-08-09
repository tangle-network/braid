import { spawn } from 'node:child_process'

import {
  prepareWindowsProcessTracking,
  registerWindowsProcess,
  releaseWindowsProcess,
  windowsProcessStatus,
} from './windows-process-tracker.mjs'

const pollMs = 25
const windowsEventQuietMs = 250
const taskkillTimeoutMs = 2_000

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function processGroupPresent(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    return undefined
  }
}

export async function prepareProcessTreeTracking() {
  if (process.platform !== 'win32') return undefined
  return await prepareWindowsProcessTracking()
}

export function registerProcessTree(child, tracker) {
  if (process.platform === 'win32') registerWindowsProcess(child, tracker)
}

export function releaseProcessTree(child) {
  if (process.platform === 'win32') releaseWindowsProcess(child)
}

export function processTreeStatus(child) {
  if (process.platform === 'win32') return windowsProcessStatus(child, childHasExited(child))
  const present = processGroupPresent(child.pid)
  if (present === undefined)
    return {
      supported: false,
      gone: false,
      reason: 'The POSIX process group could not be inspected',
    }
  return { supported: true, gone: !present, present }
}

export async function waitForTreeGone(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let quietSince
  let quietVersion
  while (true) {
    const status = processTreeStatus(child)
    if (!status.supported) return status
    if (Date.now() >= deadline) {
      if (process.platform !== 'win32' || !status.gone) return status
      return {
        ...status,
        gone: false,
        reason: 'Windows process events did not remain quiet before the cleanup timeout',
      }
    }
    if (!status.gone) {
      quietSince = undefined
      quietVersion = undefined
    } else if (process.platform !== 'win32') {
      return status
    } else if (quietVersion !== status.version) {
      quietSince = Date.now()
      quietVersion = status.version
    } else if (Date.now() - quietSince >= windowsEventQuietMs) {
      return status
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())))
  }
}

function waitForTaskkill(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {}
      resolve({ sent: false, timedOut: true })
    }, timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ sent: false, error: error instanceof Error ? error.message : String(error) })
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ sent: code === 0, code })
    })
  })
}

async function sendWindowsTreeSignal(child, force) {
  const tree = processTreeStatus(child)
  const targets = tree.supported
    ? tree.roots
    : !childHasExited(child) && Number.isInteger(child.pid) && child.pid > 0
      ? [child.pid]
      : []
  if (targets.length === 0)
    return {
      method: 'windows-taskkill-unavailable',
      sent: false,
      reason: tree.reason ?? 'No live process roots were available',
    }
  const attempts = await Promise.all(
    targets.map(async (target) => {
      const killer = spawn('taskkill', ['/PID', String(target), '/T', ...(force ? ['/F'] : [])], {
        stdio: 'ignore',
        windowsHide: true,
      })
      return { pid: target, ...(await waitForTaskkill(killer, taskkillTimeoutMs)) }
    }),
  )
  return {
    method: tree.supported ? 'windows-taskkill-tree' : 'windows-taskkill-root-fallback',
    sent: attempts.some((attempt) => attempt.sent),
    timedOut: attempts.some((attempt) => attempt.timedOut),
    timeoutMs: taskkillTimeoutMs,
    attempts,
  }
}

export async function sendTreeSignal(child, signal) {
  if (process.platform === 'win32') return sendWindowsTreeSignal(child, signal === 'SIGKILL')
  if (!Number.isInteger(child.pid) || child.pid <= 0) return { method: 'unavailable', sent: false }
  try {
    process.kill(-child.pid, signal)
    return { method: 'process-group', sent: true }
  } catch (error) {
    if (error?.code === 'ESRCH')
      return {
        method: childHasExited(child) ? 'already-exited' : 'process-group-gone',
        sent: false,
      }
    try {
      child.kill(signal)
      return { method: 'child-fallback', sent: true }
    } catch (fallbackError) {
      return {
        method: 'failed',
        sent: false,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      }
    }
  }
}
