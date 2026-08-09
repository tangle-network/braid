import { spawn } from 'node:child_process'

const pollMs = 25
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

export function processTreeStatus(pid) {
  if (process.platform === 'win32')
    return {
      supported: false,
      gone: false,
      reason: 'Windows process-tree verification is not available without tasklist ancestry data',
    }
  const present = processGroupPresent(pid)
  if (present === undefined)
    return {
      supported: false,
      gone: false,
      reason: 'The POSIX process group could not be inspected',
    }
  return { supported: true, gone: !present, present }
}

export async function waitForTreeGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const status = processTreeStatus(pid)
    if (!status.supported || status.gone || Date.now() >= deadline) return status
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

async function sendWindowsTreeSignal(pid, force) {
  if (!Number.isInteger(pid) || pid <= 0)
    return { method: 'windows-taskkill-unavailable', sent: false }
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
    stdio: 'ignore',
    windowsHide: true,
  })
  const result = await waitForTaskkill(killer, taskkillTimeoutMs)
  return {
    method: 'windows-taskkill-tree',
    sent: result.sent,
    timedOut: result.timedOut,
    error: result.error,
  }
}

export async function sendTreeSignal(child, signal) {
  if (process.platform === 'win32') return sendWindowsTreeSignal(child.pid, signal === 'SIGKILL')
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
