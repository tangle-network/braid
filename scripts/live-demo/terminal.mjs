import { readFile, rm } from 'node:fs/promises'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'

const XtermTerminal = xterm.Terminal
const PTY_TERM_GRACE_MS = 1_000
const PTY_KILL_GRACE_MS = 5_000
const PRESENTATION_START_SECONDS = 0.01
const INITIAL_SCREEN_HOLD_SECONDS = 1

export function normalizeTerminal(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

export function terminalPageProgress(screen) {
  const matches = [...screen.matchAll(/\bpage (\d+)\/(\d+)\b/gu)]
  const match = matches.at(-1)
  if (match === undefined) return undefined
  const current = Number.parseInt(match[1], 10)
  const total = Number.parseInt(match[2], 10)
  if (current < 1 || total < 1 || current > total) return undefined
  return { current, total }
}

export function visibleModelCallNumbers(screen) {
  return [
    ...new Set(
      [...screen.matchAll(/\bmodel call #(\d+)\b/gu)].map((match) => Number.parseInt(match[1], 10)),
    ),
  ].sort((left, right) => left - right)
}

export function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function screenFrom(emulator, rows) {
  const buffer = emulator.buffer.active
  return Array.from(
    { length: rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
  ).join('\n')
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await pause(50)
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ''}`,
  )
}

function waitForExit(exitPromise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs)
    void exitPromise.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

function killTerminalTree(session, signal) {
  if (process.platform === 'win32') {
    session.kill(signal)
    return
  }
  try {
    process.kill(-session.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
    session.kill(signal)
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function createCapturedTerminal(options) {
  const emulator = new XtermTerminal({
    cols: options.columns,
    rows: options.rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  const environment = {
    ...process.env,
    ...options.environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  }
  delete environment.NO_COLOR
  delete environment.FORCE_COLOR
  const session = pty.spawn(process.execPath, [options.binary, ...options.args], {
    name: 'xterm-256color',
    cols: options.columns,
    rows: options.rows,
    cwd: options.cwd,
    env: environment,
  })
  const startedAt = performance.now()
  const events = []
  let output = ''
  let screen = ''
  let exited = false
  let pendingWrites = 0
  let lastOutputAt = performance.now()
  const exitPromise = new Promise((resolve) => {
    session.onExit((event) => {
      exited = true
      resolve(event)
    })
  })
  session.onData((data) => {
    output += data
    events.push([Number(((performance.now() - startedAt) / 1000).toFixed(6)), 'o', data])
    lastOutputAt = performance.now()
    pendingWrites += 1
    emulator.write(data, () => {
      screen = screenFrom(emulator, options.rows)
      pendingWrites -= 1
    })
  })
  const input = (data) => {
    events.push([Number(((performance.now() - startedAt) / 1000).toFixed(6)), 'i', data])
    session.write(data)
  }
  const waitForStable = (label = 'stable terminal') =>
    waitFor(() => pendingWrites === 0 && performance.now() - lastOutputAt >= 100, label, 10_000)
  const captureState = async (timeoutMs = 10_000) => {
    await waitForStable()
    await rm(`${options.recordPath}.frame`, { force: true })
    process.kill(session.pid, 'SIGUSR2')
    await waitFor(
      async () => {
        try {
          await readJson(`${options.recordPath}.frame`)
          return true
        } catch {
          return false
        }
      },
      'atomic semantic frame',
      timeoutMs,
    )
    return readJson(`${options.recordPath}.frame`)
  }
  const closeNormally = async () => {
    if (exited) return
    input('\u001b')
    await pause(100)
    input('\u001b')
    await pause(100)
    input('\u0003')
    await pause(100)
    input('\u0003')
    const result = await Promise.race([
      exitPromise,
      pause(15_000).then(() => {
        throw new Error('Braid did not exit after its safe quit sequence')
      }),
    ])
    if (result.exitCode !== 0) throw new Error(`Braid exited ${result.exitCode}`)
    if (!output.toLocaleLowerCase().includes('ctrl+c again to quit')) {
      throw new Error('Braid did not render its safe quit prompt')
    }
  }
  return {
    columns: options.columns,
    rows: options.rows,
    events,
    input,
    output: () => output,
    screen: () => screen,
    snapshot: () => ({
      screen: `${screen.replace(/[ \t]+$/gmu, '').replace(/\n+$/u, '')}\n`,
      eventCount: events.length,
    }),
    waitForScreen: async (predicate, label, timeoutMs = 30_000) => {
      try {
        await waitFor(() => predicate(normalizeTerminal(screen)), label, timeoutMs)
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nTerminal frame:\n${screen}`,
        )
      }
    },
    waitForStable,
    captureState,
    closeNormally,
    dispose: async () => {
      try {
        if (!exited) {
          killTerminalTree(session, 'SIGTERM')
          const terminated = await waitForExit(exitPromise, PTY_TERM_GRACE_MS)
          if (!terminated && !exited) {
            killTerminalTree(session, 'SIGKILL')
            const killed = await waitForExit(exitPromise, PTY_KILL_GRACE_MS)
            if (!killed || !exited) {
              throw new Error('Live demo PTY did not report child exit after SIGKILL')
            }
          }
          if (!exited) throw new Error('Live demo PTY did not report child exit')
        }
      } finally {
        emulator.dispose()
      }
    },
  }
}

export async function typeText(terminal, value, delayMs = 12) {
  for (const character of value) {
    terminal.input(character)
    await pause(delayMs)
  }
}

export function presentationTimeline(events, initialHoldSeconds = INITIAL_SCREEN_HOLD_SECONDS) {
  if (events.length === 0) return []
  const firstInputIndex = events.findIndex((event) => event[1] === 'i')
  const firstTimestamp = events[0][0]
  if (firstInputIndex <= 0) {
    return events.map(([timestamp, direction, data]) => [
      Number((timestamp - firstTimestamp + PRESENTATION_START_SECONDS).toFixed(6)),
      direction,
      data,
    ])
  }
  const firstInputTimestamp = events[firstInputIndex][0]
  return events.map(([timestamp, direction, data], index) => [
    index < firstInputIndex
      ? PRESENTATION_START_SECONDS
      : Number(
          (
            timestamp -
            firstInputTimestamp +
            PRESENTATION_START_SECONDS +
            initialHoldSeconds
          ).toFixed(6),
        ),
    direction,
    data,
  ])
}

export function castFor(terminal, title, command, eventCount = terminal.events.length) {
  const captured = presentationTimeline(terminal.events.slice(0, eventCount))
  const lastEventAt = captured.at(-1)?.[0] ?? 0
  const events = [...captured, [Number((lastEventAt + 0.01).toFixed(6)), 'o', '\u001b[0m']]
  const header = {
    version: 2,
    width: terminal.columns,
    height: terminal.rows,
    timestamp: Math.floor(Date.now() / 1000),
    duration: events.at(-1)[0],
    idle_time_limit: 1,
    command,
    title,
    env: { TERM: 'xterm-256color' },
    stdin: true,
  }
  return [JSON.stringify(header), ...events.map((event) => JSON.stringify(event)), ''].join('\n')
}
