import { spawn } from 'node:child_process'

const monitorStartupTimeoutMs = 5_000
const monitorOutputLimit = 16_384
const managedTrackers = new WeakMap()

const windowsMonitorScript = [
  "$ErrorActionPreference = 'Stop'",
  "$startId = 'BraidProcessStart'",
  "$stopId = 'BraidProcessStop'",
  'Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $startId | Out-Null',
  'Register-WmiEvent -Class Win32_ProcessStopTrace -SourceIdentifier $stopId | Out-Null',
  'try {',
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  'while ($true) {',
  '$event = Wait-Event',
  '$record = $event.SourceEventArgs.NewEvent',
  "if ($event.SourceIdentifier -eq $startId) { [Console]::Out.WriteLine(('S,{0},{1},{2}' -f $record.ProcessID,$record.ParentProcessID,$record.TIME_CREATED)) } elseif ($event.SourceIdentifier -eq $stopId) { [Console]::Out.WriteLine(('X,{0},{1}' -f $record.ProcessID,$record.TIME_CREATED)) }",
  '[Console]::Out.Flush()',
  'Remove-Event -EventIdentifier $event.EventIdentifier',
  '}',
  '} finally {',
  'Unregister-Event -SourceIdentifier $startId -ErrorAction SilentlyContinue',
  'Unregister-Event -SourceIdentifier $stopId -ErrorAction SilentlyContinue',
  '}',
].join('; ')

function appendLimited(current, chunk) {
  const next = `${current}${chunk}`
  return next.length <= monitorOutputLimit ? next : next.slice(-monitorOutputLimit)
}

function parseWindowsEvent(line) {
  const start = /^S,(\d+),(\d+),(\d+)$/u.exec(line)
  if (start !== null)
    return {
      type: 'start',
      processId: Number(start[1]),
      parentProcessId: Number(start[2]),
      createdAt: start[3],
    }
  const stop = /^X,(\d+),(\d+)$/u.exec(line)
  if (stop !== null)
    return {
      type: 'stop',
      processId: Number(stop[1]),
      createdAt: stop[2],
    }
  return undefined
}

function isDescendant(node, root) {
  let current = node
  const visited = new Set()
  while (current !== undefined && !visited.has(current)) {
    if (current === root) return true
    visited.add(current)
    current = current.parent
  }
  return false
}

export class WindowsProcessTracker {
  constructor(monitor) {
    this.monitor = monitor
    this.nodes = []
    this.activeByPid = new Map()
    this.version = 0
  }

  attach(processId) {
    this.rootPid = processId
    this.root = [...this.nodes]
      .reverse()
      .find((node) => node.processId === processId && node.active)
    if (this.root !== undefined) this.#retainRootTree()
  }

  record(event) {
    if (event.type === 'start') {
      const parent = this.activeByPid.get(event.parentProcessId)
      if (this.root !== undefined && (parent === undefined || !isDescendant(parent, this.root)))
        return
      this.version += 1
      const previous = this.activeByPid.get(event.processId)
      if (previous !== undefined) previous.active = false
      const node = {
        processId: event.processId,
        parentProcessId: event.parentProcessId,
        createdAt: event.createdAt,
        parent,
        active: true,
      }
      this.nodes.push(node)
      this.activeByPid.set(event.processId, node)
      if (this.root === undefined && event.processId === this.rootPid) {
        this.root = node
        this.#retainRootTree()
      }
      return
    }
    const node = this.activeByPid.get(event.processId)
    if (node === undefined) return
    if (this.root !== undefined && !isDescendant(node, this.root)) return
    this.version += 1
    node.active = false
    this.activeByPid.delete(event.processId)
  }

  status(rootExited) {
    if (!this.monitor.supported)
      return {
        supported: false,
        gone: false,
        reason: this.monitor.reason ?? 'Windows process event monitor stopped',
      }
    if (!Number.isInteger(this.rootPid) || this.rootPid <= 0)
      return { supported: false, gone: false, reason: 'The root process id is invalid' }
    if (this.root === undefined) {
      return {
        supported: true,
        gone: false,
        present: !rootExited,
        pids: rootExited ? [] : [this.rootPid],
        roots: rootExited ? [] : [this.rootPid],
        awaitingRootEvent: true,
        version: this.version,
      }
    }
    const liveNodes = this.nodes.filter(
      (node) => node.active && !(rootExited && node === this.root) && isDescendant(node, this.root),
    )
    const liveSet = new Set(liveNodes)
    const pids = [...new Set(liveNodes.map((node) => node.processId))].sort(
      (left, right) => left - right,
    )
    const roots = [
      ...new Set(
        liveNodes
          .filter((node) => node.parent === undefined || !liveSet.has(node.parent))
          .map((node) => node.processId),
      ),
    ].sort((left, right) => left - right)
    return {
      supported: true,
      gone: pids.length === 0,
      present: pids.length > 0,
      pids,
      roots,
      version: this.version,
    }
  }

  release() {
    this.monitor.unsubscribe(this)
  }

  #retainRootTree() {
    this.nodes = this.nodes.filter((node) => isDescendant(node, this.root))
    this.activeByPid = new Map(
      this.nodes.filter((node) => node.active).map((node) => [node.processId, node]),
    )
  }
}

class WindowsProcessMonitor {
  constructor(child) {
    this.child = child
    this.supported = true
    this.trackers = new Set()
  }

  subscribe() {
    const tracker = new WindowsProcessTracker(this)
    this.trackers.add(tracker)
    return tracker
  }

  unsubscribe(tracker) {
    this.trackers.delete(tracker)
  }

  record(event) {
    for (const tracker of this.trackers) tracker.record(event)
  }

  fail(reason) {
    this.supported = false
    this.reason = reason
  }
}

let windowsMonitorPromise

function startWindowsProcessMonitor() {
  return new Promise((resolve) => {
    const encoded = Buffer.from(windowsMonitorScript, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const monitor = new WindowsProcessMonitor(child)
    let stdoutBuffer = ''
    let stderr = ''
    let ready = false
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.unref()
      child.stdout.unref?.()
      child.stderr.unref?.()
      resolve(monitor)
    }
    const fail = (reason) => {
      monitor.fail(reason)
      if (!ready) finish()
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer = appendLimited(stdoutBuffer, chunk)
      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, '')
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line === 'READY') {
          ready = true
          finish()
        } else {
          const event = parseWindowsEvent(line)
          if (event !== undefined) monitor.record(event)
        }
        newline = stdoutBuffer.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, chunk)
    })
    child.once('error', (error) => {
      fail(`Windows process event monitor failed to start: ${error.message}`)
    })
    child.once('close', (code) => {
      fail(
        `Windows process event monitor exited${code === null ? '' : ` with code ${code}`}${
          stderr.trim() ? `: ${stderr.trim()}` : ''
        }`,
      )
    })
    const timer = setTimeout(() => {
      fail('Windows process event monitor did not become ready before its startup timeout')
      try {
        child.kill('SIGKILL')
      } catch {}
    }, monitorStartupTimeoutMs)
  })
}

async function windowsProcessMonitor() {
  windowsMonitorPromise ??= startWindowsProcessMonitor()
  return await windowsMonitorPromise
}

export async function prepareWindowsProcessTracking() {
  const monitor = await windowsProcessMonitor()
  return monitor.subscribe()
}

export function registerWindowsProcess(child, tracker) {
  if (tracker === undefined) return
  tracker.attach(child.pid)
  managedTrackers.set(child, tracker)
}

export function releaseWindowsProcess(child) {
  const tracker = managedTrackers.get(child)
  if (tracker === undefined) return
  tracker.release()
  managedTrackers.delete(child)
}

export function windowsProcessStatus(child, rootExited) {
  const tracker = managedTrackers.get(child)
  if (tracker === undefined)
    return {
      supported: false,
      gone: false,
      reason: 'The Windows process was not started with lifetime tracking',
    }
  return tracker.status(rootExited)
}
