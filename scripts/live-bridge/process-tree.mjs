import { releaseWindowsJob, terminateWindowsJob, windowsJobStatus } from './windows-job-host.mjs'

const pollMs = 25

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

export function releaseProcessTree(child) {
  if (process.platform === 'win32') releaseWindowsJob(child)
}

export function processTreeStatus(child) {
  if (process.platform === 'win32') return windowsJobStatus(child, childHasExited(child))
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
  while (true) {
    const status = processTreeStatus(child)
    if (!status.supported) return status
    if (status.gone) return status
    if (Date.now() >= deadline) return status
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())))
  }
}

export async function sendTreeSignal(child, signal) {
  if (process.platform === 'win32') return await terminateWindowsJob(child)
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
