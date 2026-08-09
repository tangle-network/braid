import { spawn, spawnSync } from 'node:child_process'

const pollMs = 25
const taskkillTimeoutMs = 2_000
const ancestryTimeoutMs = 2_000
const windowsProcessListCommand = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process | ForEach-Object { Write-Output ([string]$_.ProcessId + ',' + [string]$_.ParentProcessId) }",
].join('; ')

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

export function windowsTreeFromRows(pid, rows) {
  if (!Number.isInteger(pid) || pid <= 0)
    return { supported: false, gone: false, reason: 'The root process id is invalid' }
  const children = new Map()
  let rootPresent = false
  for (const row of rows) {
    if (!Number.isInteger(row.processId) || !Number.isInteger(row.parentProcessId)) continue
    if (row.processId === pid) rootPresent = true
    const siblings = children.get(row.parentProcessId) ?? []
    siblings.push(row.processId)
    children.set(row.parentProcessId, siblings)
  }
  const descendants = new Set()
  const pending = [pid]
  while (pending.length > 0) {
    const parent = pending.pop()
    for (const child of children.get(parent) ?? []) {
      if (child === pid || descendants.has(child)) continue
      descendants.add(child)
      pending.push(child)
    }
  }
  const pids = [...(rootPresent ? [pid] : []), ...descendants].sort((left, right) => left - right)
  return {
    supported: true,
    gone: pids.length === 0,
    present: pids.length > 0,
    pids,
  }
}

function windowsProcessTreeStatus(pid) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsProcessListCommand],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: ancestryTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    },
  )
  if (result.error !== undefined || result.status !== 0) {
    return {
      supported: false,
      gone: false,
      reason:
        result.error?.code === 'ETIMEDOUT'
          ? 'Windows process ancestry query timed out'
          : 'Windows process ancestry query failed',
    }
  }
  const rows = String(result.stdout)
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^(\d+),(\d+)$/u.exec(line.trim())
      return match === null
        ? []
        : [{ processId: Number(match[1]), parentProcessId: Number(match[2]) }]
    })
  if (rows.length === 0)
    return {
      supported: false,
      gone: false,
      reason: 'Windows process ancestry query returned no process records',
    }
  return windowsTreeFromRows(pid, rows)
}

export function processTreeStatus(pid) {
  if (process.platform === 'win32') return windowsProcessTreeStatus(pid)
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
  const tree = processTreeStatus(pid)
  const targets = tree.supported && tree.pids.length > 0 ? [...tree.pids].reverse() : [pid]
  const attempts = []
  for (const target of targets) {
    const killer = spawn('taskkill', ['/PID', String(target), '/T', ...(force ? ['/F'] : [])], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const result = await waitForTaskkill(killer, taskkillTimeoutMs)
    attempts.push({ pid: target, ...result })
  }
  return {
    method: 'windows-taskkill-tree',
    sent: attempts.some((attempt) => attempt.sent),
    timedOut: attempts.some((attempt) => attempt.timedOut),
    attempts,
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
