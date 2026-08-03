import { randomUUID, createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import * as pty from 'node-pty'
import xterm from '@xterm/headless'

const XtermTerminal = xterm.Terminal

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}

export function normalized(screen) {
  return screen.replace(/\s+/gu, ' ').trim()
}

function screenFrom(emulator, rows) {
  const buffer = emulator.buffer.active
  return Array.from(
    { length: rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
  ).join('\n')
}

export async function spawnTerminal({
  name,
  columns,
  rows,
  repository,
  binary,
  rawRoot,
  extraEnvironment = {},
  uiFixture,
}) {
  const emulator = new XtermTerminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  const environment = { ...process.env, TERM: 'xterm-256color', ...extraEnvironment }
  delete environment.NO_COLOR
  delete environment.FORCE_COLOR
  const recordPath = join(rawRoot, `${name}-${randomUUID()}.json`)
  const args = [binary, '--fixture', 'deterministic', '--record-state', recordPath]
  if (uiFixture) args.push('--ui-fixture', uiFixture)
  const session = pty.spawn(process.execPath, args, {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: repository,
    env: { ...environment, BRAID_JOURNAL_PATH: `${recordPath}.journal` },
  })
  const startedAt = performance.now()
  const events = []
  let output = ''
  let screen = ''
  let exited = false
  const refresh = () => {
    screen = screenFrom(emulator, rows)
  }
  const exitPromise = new Promise((resolve) =>
    session.onExit((event) => {
      exited = true
      resolve(event)
    }),
  )
  session.onData((data) => {
    output += data
    events.push([Number(((performance.now() - startedAt) / 1_000).toFixed(6)), 'o', data])
    emulator.write(data, refresh)
  })
  const input = (data) => {
    events.push([Number(((performance.now() - startedAt) / 1_000).toFixed(6)), 'i', data])
    session.write(data)
  }
  const snapshot = () => ({
    screen: `${screen.replace(/[ \t]+$/gmu, '').replace(/\n+$/u, '')}\n`,
    output,
    eventCount: events.length,
  })
  const closeNormally = async () => {
    if (exited) return
    input('\u001b')
    await sleep(30)
    input('\u0003')
    await waitFor(
      () =>
        normalized(screen).includes('press ctrl+c again to quit') ||
        normalized(screen).includes('ctrl+c again to quit') ||
        normalized(screen).includes('ctrl+c cancel/quit'),
      `${name} safe exit`,
    )
    input('\u0003')
    const event = await Promise.race([
      exitPromise,
      sleep(5_000).then(() => {
        session.kill()
        throw new Error(`${name} did not exit`)
      }),
    ])
    if (event.exitCode !== 0) throw new Error(`${name} exited ${event.exitCode}`)
  }
  const closeWithSignal = async () => {
    if (exited) return
    process.kill(session.pid, 'SIGINT')
    const event = await Promise.race([
      exitPromise,
      sleep(5_000).then(() => {
        session.kill()
        throw new Error(`${name} did not exit after SIGINT`)
      }),
    ])
    if (event.exitCode !== 130) throw new Error(`${name} SIGINT exited ${event.exitCode}`)
  }
  const readRecord = async (suffix = '') => {
    const path = `${recordPath}${suffix}`
    const deadline = Date.now() + 5_000
    while (true) {
      try {
        const data = await readFile(path, 'utf8')
        if (data.length > 0) return JSON.parse(data)
      } catch {
        // The packed process may still be flushing its final state file.
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name} semantic state`)
      await sleep(20)
    }
  }
  const captureState = async () => {
    const point = snapshot()
    process.kill(session.pid, 'SIGUSR2')
    return { point, record: await readRecord('.frame') }
  }
  const dispose = async () => {
    emulator.dispose()
    await rm(recordPath, { force: true })
    await rm(`${recordPath}.signal`, { force: true })
    await rm(`${recordPath}.frame`, { force: true })
    await rm(`${recordPath}.journal`, { force: true })
  }
  return {
    columns,
    rows,
    events,
    input,
    output: () => output,
    screen: () => screen,
    snapshot,
    waitFor: (predicate, label) => waitFor(predicate, `${name} ${label}`),
    closeNormally,
    closeWithSignal,
    readRecord,
    captureState,
    dispose,
  }
}

export function castFor(result, events, title) {
  const header = {
    version: 2,
    width: result.columns,
    height: result.rows,
    timestamp: Math.floor(Date.now() / 1_000),
    duration: events.at(-1)?.[0] ?? 0,
    idle_time_limit: 1,
    command: 'packed braid --fixture deterministic',
    title,
    env: { TERM: 'xterm-256color' },
    stdin: true,
  }
  return [JSON.stringify(header), ...events.map((event) => JSON.stringify(event)), ''].join('\n')
}

export function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
