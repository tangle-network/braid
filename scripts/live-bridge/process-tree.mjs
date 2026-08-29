import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'

import { releaseWindowsJob, terminateWindowsJob, windowsJobStatus } from './windows-job-host.mjs'

const pollMs = 25
const procRoot = '/proc'
const processTreeToken = 'BRAID_PROCESS_TREE_TOKEN'
const processTreeTrackers = new WeakMap()

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function unsupported(reason) {
  return {
    supported: false,
    gone: false,
    mechanism: 'posix-descendant-tracker',
    reason,
  }
}

function numericPid(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function procFile(pid, name) {
  return `${procRoot}/${pid}/${name}`
}

function processStat(pid) {
  const normalizedPid = numericPid(pid)
  if (normalizedPid === undefined) return undefined
  try {
    const value = readFileSync(procFile(normalizedPid, 'stat'), 'utf8')
    const closingParenthesis = value.lastIndexOf(') ')
    if (closingParenthesis < 0) throw new Error('Linux process stat has no command terminator')
    const fields = value
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/u)
    const ppid = Number(fields[1])
    const processGroup = Number(fields[2])
    const startTime = fields[19]
    if (
      !Number.isInteger(ppid) ||
      ppid < 0 ||
      !Number.isInteger(processGroup) ||
      processGroup < 0 ||
      typeof startTime !== 'string' ||
      startTime.length === 0
    ) {
      throw new Error(`Linux process stat for ${normalizedPid} is incomplete`)
    }
    return {
      pid: normalizedPid,
      ppid,
      processGroup,
      startTime,
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return undefined
    throw error
  }
}

function processTable(token, requiredPids) {
  let names
  try {
    names = readdirSync(procRoot)
  } catch (error) {
    return { error: `The POSIX process table could not be read: ${errorMessage(error)}` }
  }
  const records = new Map()
  const marked = []
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue
    const pid = Number(name)
    let record
    let marker
    let markerInspected = false
    try {
      record = processStat(pid)
    } catch {
      try {
        marker = readOwnershipMarker(pid, token)
        markerInspected = true
      } catch (markerError) {
        if (markerError?.code !== 'EACCES')
          return {
            error: `The POSIX process ownership could not be inspected: ${errorMessage(markerError)}`,
          }
        markerInspected = true
      }
      if (marker !== true && !requiredPids.has(pid)) continue
      try {
        record = processStat(pid)
      } catch (retryError) {
        return {
          error: `The POSIX process table could not be inspected: ${errorMessage(retryError)}`,
        }
      }
    }
    if (record === undefined) continue
    records.set(record.pid, record)
    if (!markerInspected) {
      try {
        marker = readOwnershipMarker(record.pid, token)
      } catch (error) {
        if (error?.code !== 'EACCES')
          return {
            error: `The POSIX process ownership could not be inspected: ${errorMessage(error)}`,
          }
      }
    }
    if (marker === true) marked.push(record)
  }
  return { records, marked }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    return undefined
  }
}

function processGroupPresent(pid) {
  const normalizedPid = numericPid(pid)
  if (normalizedPid === undefined) return undefined
  try {
    process.kill(-normalizedPid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    return undefined
  }
}

function readOwnershipMarker(pid, token) {
  try {
    const environment = readFileSync(procFile(pid, 'environ'), 'utf8')
    return environment.split('\0').includes(`${processTreeToken}=${token}`)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return undefined
    throw error
  }
}

function descendants(records, roots) {
  const childrenByParent = new Map()
  for (const record of records.values()) {
    const children = childrenByParent.get(record.ppid) ?? []
    children.push(record)
    childrenByParent.set(record.ppid, children)
  }
  const result = new Map()
  const pending = [...roots]
  while (pending.length > 0) {
    const root = pending.shift()
    if (root === undefined || result.has(root.pid)) continue
    result.set(root.pid, root)
    for (const child of childrenByParent.get(root.pid) ?? []) pending.push(child)
  }
  return result
}

function currentIdentity(pid, expectedStartTime) {
  const identity = processStat(pid)
  if (identity === undefined) {
    const present = processExists(pid)
    if (present === undefined) return { inaccessible: true }
    return present ? { inaccessible: true } : { gone: true }
  }
  if (expectedStartTime !== undefined && identity.startTime !== expectedStartTime)
    return { reused: true, identity }
  return { identity }
}

function sortDeepestFirst(entries) {
  return [...entries].sort((left, right) => {
    if (left.depth !== right.depth) return right.depth - left.depth
    return right.pid - left.pid
  })
}

class PosixProcessTreeTracker {
  constructor(child, token) {
    this.child = child
    this.token = token
    this.entries = new Map()
    this.rootPid = numericPid(child.pid)
    this.rootObserved = false
    this.rootStartTime = undefined
    this.released = false
    this.failure = undefined
    this.observeRoot()
    this.refresh()
    this.monitor = setInterval(() => this.refresh(), pollMs)
    this.monitor.unref()
  }

  observeRoot() {
    if (this.rootPid === undefined) {
      this.failure = 'The POSIX process has no valid owner PID'
      return
    }
    let root
    let marker
    try {
      root = processStat(this.rootPid)
      marker = readOwnershipMarker(this.rootPid, this.token)
    } catch (error) {
      this.failure = `The POSIX process ownership marker could not be read: ${errorMessage(error)}`
      return
    }
    if (root === undefined) {
      this.failure = 'The POSIX process exited before ownership was observed'
      return
    }
    if (marker !== true) {
      this.failure = 'The POSIX process did not retain its ownership marker'
      return
    }
    this.rootObserved = true
    this.rootStartTime = root.startTime
    this.entries.set(root.pid, { ...root, depth: 0 })
  }

  refresh() {
    if (this.released || this.failure !== undefined) return
    if (this.rootPid === undefined) {
      this.failure = 'The POSIX process has no valid owner PID'
      return
    }
    const requiredPids = new Set([this.rootPid, ...this.entries.keys()])
    const table = processTable(this.token, requiredPids)
    if (table.error !== undefined) {
      this.failure = table.error
      return
    }
    const root = table.records.get(this.rootPid)
    if (!this.rootObserved) {
      if (root === undefined) {
        this.failure = 'The POSIX process exited before ownership was observed'
        return
      }
      let marker
      try {
        marker = readOwnershipMarker(this.rootPid, this.token)
      } catch (error) {
        this.failure = `The POSIX process ownership marker could not be read: ${errorMessage(error)}`
        return
      }
      if (marker !== true) {
        this.failure = 'The POSIX process did not retain its ownership marker'
        return
      }
      this.rootObserved = true
      this.rootStartTime = root.startTime
    } else if (root !== undefined && root.startTime !== this.rootStartTime) {
      this.failure = 'The POSIX owner PID was reused before cleanup completed'
      return
    }

    const roots = [...table.marked]
    if (root !== undefined && root.startTime === this.rootStartTime) roots.push(root)
    for (const entry of this.entries.values()) {
      const record = table.records.get(entry.pid)
      if (record !== undefined && record.startTime === entry.startTime) roots.push(record)
    }
    const discovered = descendants(table.records, roots)
    for (const record of discovered.values()) {
      const existing = this.entries.get(record.pid)
      if (existing !== undefined && existing.startTime !== record.startTime) {
        this.failure = `The POSIX process identity for ${record.pid} changed during tracking`
        return
      }
      if (existing === undefined) {
        this.entries.set(record.pid, {
          ...record,
          depth: this.depthFor(record, discovered),
        })
      } else {
        existing.ppid = record.ppid
        existing.processGroup = record.processGroup
        existing.depth = this.depthFor(record, discovered)
      }
    }
  }

  depthFor(record, discovered) {
    let depth = 0
    let parent = record.ppid
    const seen = new Set([record.pid])
    while (parent !== 0 && !seen.has(parent)) {
      const parentRecord = discovered.get(parent)
      if (parentRecord === undefined) break
      seen.add(parent)
      depth += 1
      parent = parentRecord.ppid
    }
    return depth
  }

  status() {
    this.refresh()
    if (this.failure !== undefined) return unsupported(this.failure)
    const active = []
    for (const entry of this.entries.values()) {
      const current = currentIdentity(entry.pid, entry.startTime)
      if (current.inaccessible)
        return unsupported(`The POSIX process ${entry.pid} could not be inspected`)
      if (current.reused || current.gone) this.entries.delete(entry.pid)
      else if (current.identity !== undefined) active.push(entry)
    }
    const root = currentIdentity(this.rootPid, this.rootStartTime)
    if (root.inaccessible)
      return unsupported(`The POSIX owner process ${this.rootPid} could not be inspected`)
    const rootActive = root.identity !== undefined
    if (root.reused) this.failure = 'The POSIX owner PID was reused before cleanup completed'
    if (this.failure !== undefined) return unsupported(this.failure)
    return {
      supported: true,
      gone: !rootActive && active.length === 0,
      present: rootActive || active.length > 0,
      pids: active.map(({ pid }) => pid),
      roots: rootActive ? [this.rootPid] : [],
      version: rootActive || active.length > 0 ? 0 : 1,
      mechanism: 'posix-descendant-tracker',
      ownership: 'pid-start-time-and-descendant-lineage',
      observed: this.rootObserved,
      escaped: !rootActive && active.some(({ ppid }) => ppid !== this.rootPid),
    }
  }

  signal(signal) {
    const status = this.status()
    if (!status.supported) return { method: 'unavailable', sent: false, reason: status.reason }
    if (status.gone) return { method: 'already-exited', sent: false }
    let sent = false
    let groupSent = false
    const root = this.entries.get(this.rootPid)
    if (root !== undefined && root.processGroup === this.rootPid) {
      try {
        process.kill(-this.rootPid, signal)
        groupSent = true
        sent = true
      } catch (error) {
        if (error?.code !== 'ESRCH' && error?.code !== 'EPERM')
          return { method: 'failed', sent, error: errorMessage(error) }
      }
    }
    for (const entry of sortDeepestFirst(this.entries.values())) {
      const current = currentIdentity(entry.pid, entry.startTime)
      if (current.identity === undefined) continue
      try {
        process.kill(entry.pid, signal)
        sent = true
      } catch (error) {
        if (error?.code !== 'ESRCH') return { method: 'failed', sent, error: errorMessage(error) }
      }
    }
    return {
      method: groupSent ? 'process-group' : sent ? 'owned-processes' : 'already-exited',
      sent,
    }
  }

  release() {
    this.released = true
    clearInterval(this.monitor)
  }
}

class PosixProcessGroupTracker {
  constructor(child) {
    this.rootPid = numericPid(child.pid)
  }

  status() {
    if (this.rootPid === undefined)
      return {
        ...unsupported('The POSIX process has no valid owner PID'),
        mechanism: 'posix-process-group',
      }
    const present = processGroupPresent(this.rootPid)
    if (present === undefined)
      return {
        ...unsupported('The POSIX process group could not be inspected'),
        mechanism: 'posix-process-group',
      }
    return {
      supported: true,
      gone: !present,
      present,
      pids: [],
      roots: present ? [this.rootPid] : [],
      version: present ? 0 : 1,
      mechanism: 'posix-process-group',
      ownership: 'kernel-process-group',
      observed: true,
      escaped: false,
    }
  }

  signal(signal) {
    const status = this.status()
    if (!status.supported) return { method: 'unavailable', sent: false, reason: status.reason }
    if (status.gone) return { method: 'already-exited', sent: false }
    try {
      process.kill(-this.rootPid, signal)
      return { method: 'process-group', sent: true }
    } catch (error) {
      if (error?.code === 'ESRCH') return { method: 'already-exited', sent: false }
      return { method: 'failed', sent: false, error: errorMessage(error) }
    }
  }

  release() {}
}

export function processTreeEnvironment(environment = process.env) {
  if (process.platform !== 'linux') return { environment, token: undefined }
  const token = randomUUID()
  return {
    environment: { ...environment, [processTreeToken]: token },
    token,
  }
}

export function trackProcessTree(child, token) {
  if (process.platform === 'win32') return undefined
  if (child === null || typeof child !== 'object')
    throw new TypeError('A child process is required')
  const tracker =
    process.platform === 'linux'
      ? token === undefined
        ? undefined
        : new PosixProcessTreeTracker(child, token)
      : new PosixProcessGroupTracker(child)
  if (tracker === undefined) return undefined
  processTreeTrackers.set(child, tracker)
  return tracker
}

export function releaseProcessTree(child) {
  const tracker = processTreeTrackers.get(child)
  if (tracker?.status().gone) tracker.release()
  if (process.platform === 'win32') releaseWindowsJob(child)
}

export function processTreeStatus(child) {
  if (process.platform === 'win32') return windowsJobStatus(child, childHasExited(child))
  const tracker = processTreeTrackers.get(child)
  if (tracker === undefined)
    return unsupported('The POSIX process was not started by a lifecycle tracker')
  return tracker.status()
}

export async function waitForTreeGone(child, timeoutMs) {
  const boundedTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0
  const deadline = Date.now() + boundedTimeout
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
  const tracker = processTreeTrackers.get(child)
  if (tracker === undefined)
    return {
      method: 'unavailable',
      sent: false,
      reason: 'The POSIX process was not started by a lifecycle tracker',
    }
  return tracker.signal(signal)
}
