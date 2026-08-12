import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'

const XtermTerminal = xterm.Terminal
const REFERENCE_DIMENSIONS = Object.freeze([
  Object.freeze([40, 12]),
  Object.freeze([80, 24]),
  Object.freeze([120, 40]),
  Object.freeze([200, 60]),
])
const FRAME_TIMEOUT_MS = 2_000
const activeSessions = new Set()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitFor(predicate, label, timeoutMs = FRAME_TIMEOUT_MS, signal) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (signal?.aborted) throw new Error(`Interrupted while waiting for ${label}`)
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(2)
  }
}

function visibleText(terminal) {
  const lines = []
  const buffer = terminal.buffer.active
  for (let index = 0; index < terminal.rows; index += 1) {
    const line = buffer.getLine(buffer.viewportY + index)
    lines.push(line?.translateToString(true) ?? '')
  }
  return lines
}

function hasVisibleFrame(terminal) {
  return visibleText(terminal).some((line) => line.includes('Braid starter'))
}

function hasStartupError(output) {
  return /(?:PRODUCTION_|STORAGE_|CREDENTIAL_STORE_UNAVAILABLE|startup error|encrypted storage)/iu.test(
    output,
  )
}

function invalidCellCount(terminal) {
  const buffer = terminal.buffer.active
  let invalid = 0
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) {
      invalid += terminal.cols
      continue
    }
    for (let column = 0; column < terminal.cols; column += 1) {
      try {
        const cell = line.getCell(column)
        if (!cell || typeof cell.getChars !== 'function') invalid += 1
      } catch {
        invalid += 1
      }
    }
  }
  return invalid
}

function readLinuxCpuSeconds(pid) {
  return readFile(`/proc/${pid}/stat`, 'utf8').then((value) => {
    const closingParenthesis = value.lastIndexOf(')')
    if (closingParenthesis < 0) throw new Error(`Could not parse /proc/${pid}/stat`)
    const fields = value
      .slice(closingParenthesis + 2)
      .trim()
      .split(/\s+/u)
    const userTicks = Number(fields[11])
    const systemTicks = Number(fields[12])
    if (!Number.isFinite(userTicks) || !Number.isFinite(systemTicks)) {
      throw new Error(`Could not read CPU ticks for process ${pid}`)
    }
    return (userTicks + systemTicks) / 100
  })
}

async function readCpuSeconds(pid) {
  if (process.platform === 'linux') return readLinuxCpuSeconds(pid)
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      const child = spawn('ps', ['-o', 'time=', '-p', String(pid)], {
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
      child.once('error', reject)
      child.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ps could not read process CPU: ${stderr}`))
          return
        }
        const value = stdout.trim()
        const [dayPart, clockPart] = value.includes('-') ? value.split('-', 2) : [undefined, value]
        const clock = clockPart?.split(':').map(Number) ?? []
        if (
          clock.some((part) => !Number.isFinite(part)) ||
          (clock.length !== 2 && clock.length !== 3)
        ) {
          reject(new Error(`Could not parse ps CPU time: ${stdout}`))
          return
        }
        const days = dayPart === undefined ? 0 : Number(dayPart)
        const seconds = clock.at(-1) ?? 0
        const minutes = clock.at(-2) ?? 0
        const hours = clock.length === 3 ? (clock.at(-3) ?? 0) : 0
        if (!Number.isFinite(days)) {
          reject(new Error(`Could not parse ps CPU days: ${stdout}`))
          return
        }
        resolve(days * 86_400 + hours * 3_600 + minutes * 60 + seconds)
      })
    })
  }
  throw new Error(
    `PERF-08 requires a supported child-process CPU meter; ${process.platform} is unsupported`,
  )
}

export function assertProcessPrerequisites() {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) {
    throw new Error(`Performance proof is unsupported on ${process.platform}`)
  }
  if (process.platform === 'win32') {
    throw new Error('PERF-08 child-process CPU measurement is not implemented on win32')
  }
  assert(typeof pty.spawn === 'function', 'node-pty is required for packed process measurements')
  assert(typeof XtermTerminal === 'function', '@xterm/headless is required for frame measurements')
}

export async function openPackedTui(options) {
  const columns = options.columns ?? 80
  const rows = options.rows ?? 24
  const terminal = new XtermTerminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  const startedAt = performance.now()
  const startedAtEpochMs = performance.timeOrigin + startedAt
  const environment = {
    ...process.env,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    ...(options.environment ?? {}),
  }
  delete environment.FORCE_COLOR
  const args = [options.binary, ...(options.args ?? [])]
  const session = pty.spawn(process.execPath, args, {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: options.cwd,
    env: environment,
  })
  let output = ''
  let frameVersion = 0
  let firstVisibleFrameMs
  let exited = false
  let exitValue
  const exitPromise = new Promise((resolve) => {
    session.onExit((value) => {
      exited = true
      exitValue = value
      resolve(value)
    })
  })
  session.onData((chunk) => {
    output = `${output}${chunk}`.slice(-2_000_000)
    terminal.write(chunk, () => {
      frameVersion += 1
      const lines = visibleText(terminal)
      const ready = options.readyFramePredicate
        ? options.readyFramePredicate(lines, output)
        : hasVisibleFrame(terminal)
      if (firstVisibleFrameMs === undefined && ready) {
        firstVisibleFrameMs = performance.now() - startedAt
      }
    })
  })

  const handle = {
    get pid() {
      return session.pid
    },
    get output() {
      return output
    },
    get exited() {
      return exited
    },
    get exitValue() {
      return exitValue
    },
    get frameVersion() {
      return frameVersion
    },
    get firstVisibleFrameMs() {
      return firstVisibleFrameMs
    },
    get startedAtEpochMs() {
      return startedAtEpochMs
    },
    get terminal() {
      return terminal
    },
    get dimensions() {
      return { columns: terminal.cols, rows: terminal.rows }
    },
    send(value) {
      session.write(value)
    },
    resize(nextColumns, nextRows) {
      session.resize(nextColumns, nextRows)
    },
    async waitForInitialFrame(timeoutMs = 10_000) {
      await waitFor(
        () => firstVisibleFrameMs !== undefined,
        'packed TUI first visible frame',
        timeoutMs,
        options.signal,
      )
      assert(!hasStartupError(output), 'Packed TUI emitted a startup or storage error')
      return firstVisibleFrameMs
    },
    async waitForNextFrame(previousVersion, timeoutMs = FRAME_TIMEOUT_MS) {
      await waitFor(
        () => frameVersion > previousVersion && !exited,
        'updated terminal frame',
        timeoutMs,
        options.signal,
      )
      return frameVersion
    },
    snapshot() {
      return Object.freeze({
        lines: Object.freeze(visibleText(terminal)),
        invalidCells: invalidCellCount(terminal),
        frameVersion,
        dimensions: { columns: terminal.cols, rows: terminal.rows },
      })
    },
    async stop() {
      if (exited) return exitValue
      session.write('\u0003')
      await waitFor(
        () => output.toLowerCase().includes('ctrl+c again to quit'),
        'packed TUI safe-exit prompt',
        5_000,
      )
      session.write('\u0003')
      await Promise.race([
        exitPromise,
        sleep(5_000).then(() => {
          session.kill()
          throw new Error('Packed TUI process did not exit after safe shutdown')
        }),
      ])
      if (exitValue?.exitCode !== 0)
        throw new Error(`Packed TUI exited with ${exitValue?.exitCode}`)
      return exitValue
    },
    async kill() {
      if (!exited) session.kill()
      await Promise.race([exitPromise, sleep(1_000)])
    },
  }
  activeSessions.add(handle)
  exitPromise.finally(() => activeSessions.delete(handle)).catch(() => undefined)
  return handle
}

export async function cleanupProcessProbes() {
  await Promise.all([...activeSessions].map((session) => session.kill()))
}

export async function measureFirstVisibleFrame(options) {
  const session = await openPackedTui(options)
  try {
    const firstVisibleFrameMs = await session.waitForInitialFrame()
    if (options.shutdownReadyFramePredicate !== undefined) {
      await waitFor(
        () => options.shutdownReadyFramePredicate(session.snapshot().lines, session.output),
        'packed TUI interactive frame before shutdown',
        10_000,
        options.signal,
      )
    }
    const startup =
      options.startupTimingPath === undefined
        ? undefined
        : JSON.parse(await readFile(options.startupTimingPath, 'utf8'))
    await session.stop()
    return {
      value: firstVisibleFrameMs,
      frame: session.snapshot(),
      exited: session.exited,
      startedAtEpochMs: session.startedAtEpochMs,
      ...(startup === undefined ? {} : { startup }),
    }
  } finally {
    await session.kill()
  }
}

export async function measureIdleKeyFrames(options) {
  const session = await openPackedTui(options)
  const samples = []
  const edits = []
  const tokens = []
  const keyFramePredicate =
    options.keyFramePredicate ??
    ((snapshot, token) => snapshot.lines.filter((line) => line.includes(token)).length === 1)
  const emptyFramePredicate =
    options.emptyFramePredicate ??
    ((snapshot, token) => !snapshot.lines.some((line) => line.includes(token)))
  try {
    await session.waitForInitialFrame()
    for (let index = 0; index < options.count; index += 1) {
      const token = `perf-key-${String(index + 1).padStart(5, '0')}`
      tokens.push(token)
      const previousVersion = session.frameVersion
      const startedAt = performance.now()
      session.send(token)
      await waitFor(
        () =>
          session.frameVersion > previousVersion && keyFramePredicate(session.snapshot(), token),
        `composer frame containing ${token}`,
        FRAME_TIMEOUT_MS,
        options.signal,
      )
      const keyFrame = session.snapshot()
      samples.push(performance.now() - startedAt)
      const eraseVersion = session.frameVersion
      session.send('\u0015')
      await waitFor(
        () => session.frameVersion > eraseVersion && emptyFramePredicate(session.snapshot(), token),
        `empty composer frame after ${token}`,
        FRAME_TIMEOUT_MS,
        options.signal,
      )
      const eraseFrame = session.snapshot()
      edits.push({
        index: index + 1,
        token,
        keyFrameVersion: keyFrame.frameVersion,
        eraseFrameVersion: eraseFrame.frameVersion,
        keyFrame: keyFrame.lines,
        eraseFrame: eraseFrame.lines,
      })
    }
    const frame = session.snapshot()
    await session.stop()
    return { samples, frame, edits, tokens }
  } finally {
    await session.kill()
  }
}

export async function measureResizeStream(options) {
  const session = await openPackedTui(options)
  const samples = []
  let crashes = 0
  try {
    await session.waitForInitialFrame()
    session.send(`${'resize stream '.repeat(1_000)}\r`)
    for (let index = 0; index < options.count; index += 1) {
      const [columns, rows] = REFERENCE_DIMENSIONS[index % REFERENCE_DIMENSIONS.length]
      const previousVersion = session.frameVersion
      const startedAt = performance.now()
      session.resize(columns, rows)
      try {
        await session.waitForNextFrame(previousVersion)
      } catch (error) {
        if (session.exited) crashes += 1
        throw error
      }
      samples.push(performance.now() - startedAt)
      const remaining = 10 - (performance.now() - startedAt)
      if (remaining > 0) await sleep(remaining)
    }
    const frame = session.snapshot()
    await session.stop()
    return { samples, frame, crashes }
  } finally {
    await session.kill()
  }
}

export async function measureIdleCpu(options) {
  const session = await openPackedTui(options)
  try {
    await session.waitForInitialFrame(10_000)
    await sleep(options.settleMs ?? 2_000, undefined, { signal: options.signal })
    const startedAt = performance.now()
    const cpuStart = await readCpuSeconds(session.pid)
    await sleep(options.durationMs ?? 60_000, undefined, { signal: options.signal })
    const cpuEnd = await readCpuSeconds(session.pid)
    const elapsedSeconds = (performance.now() - startedAt) / 1_000
    const cpuSeconds = cpuEnd - cpuStart
    assert(
      elapsedSeconds >= (options.durationMs ?? 60_000) / 1_000 - 0.25,
      'PERF-08 did not run its full duration',
    )
    assert(cpuSeconds >= 0, 'PERF-08 child CPU time moved backwards')
    const frame = session.snapshot()
    await session.stop()
    return {
      value: (cpuSeconds / elapsedSeconds) * 100,
      elapsedSeconds,
      cpuSeconds,
      frame,
    }
  } finally {
    await session.kill()
  }
}

export { REFERENCE_DIMENSIONS }
