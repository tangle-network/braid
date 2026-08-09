import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

export const PROCESS_TREE_STRATEGY =
  process.platform === 'win32' ? 'windows-taskkill-tree' : 'posix-process-group'

function groupExists(pid) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

function signalGroup(child, signal) {
  if (typeof child.pid !== 'number' || child.pid <= 0) return false
  try {
    process.kill(-child.pid, signal)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }
}

function taskkill(child, force, timeoutMs) {
  if (process.platform !== 'win32' || typeof child.pid !== 'number') return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killer.kill()
      resolve(false)
    }, timeoutMs)
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    killer.once('error', () => finish(false))
    killer.once('close', (code) => finish(code === 0))
  })
}

async function waitForGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (groupExists(pid) && Date.now() < deadline) await sleep(25)
  return !groupExists(pid)
}

export async function terminateChildTree(child, timeoutMs = 800) {
  if (process.platform === 'win32') {
    const graceful = await taskkill(child, false, Math.max(100, timeoutMs / 2))
    const forced = await taskkill(child, true, Math.max(100, timeoutMs / 2))
    return graceful || forced
  }
  if (typeof child.pid !== 'number' || child.pid <= 0 || !groupExists(child.pid)) return true
  signalGroup(child, 'SIGTERM')
  if (await waitForGroupGone(child.pid, Math.floor(timeoutMs / 2))) return true
  signalGroup(child, 'SIGKILL')
  return waitForGroupGone(child.pid, Math.ceil(timeoutMs / 2))
}

export async function reapChildTree(child, timeoutMs = 800) {
  if (process.platform === 'win32') return taskkill(child, false, timeoutMs)
  if (typeof child.pid !== 'number' || child.pid <= 0 || !groupExists(child.pid)) return true
  return terminateChildTree(child, timeoutMs)
}
