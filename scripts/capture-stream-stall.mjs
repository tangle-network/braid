import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { createApplicationUiController } from '../dist/adapters/tui/application-ui-controller.js'
import { BraidApplication } from '../dist/app/application.js'
import { DETERMINISTIC_PROFILE } from '../dist/app/composition.js'
import { FixedClock } from '../dist/ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES } from '../dist/ports/execution.js'
import { SequenceIds } from '../dist/ports/ids.js'
import { BraidTerminalApp } from '../dist/views/tui/terminal-app.js'
import { createBraidTheme } from '../dist/views/tui/theme.js'
import { VirtualTerminal } from '../.test-dist-stream-stall/test/support/virtual-terminal.js'
import { captureProvenance, writeCastGif } from './capture-visual-support.mjs'

const repository = new URL('../', import.meta.url).pathname
const outputRoot = process.env.BRAID_CAPTURE_OUT ?? join(repository, 'artifacts', 'verification', 'stream-stall')
const rawRoot = join(outputRoot, 'raw')
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]
const CAPABILITIES = {
  ...DEFAULT_RUN_CAPABILITIES,
  streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
  sessions: { continue: true, messages: true },
  controls: { cancel: true, steer: false, queue: true, status: true, recreate: true },
  events: { stableIdentity: true, sequence: true, cursor: true },
}

class RecordingTerminal extends VirtualTerminal {
  events = []
  startedAt = performance.now()
  record(kind, value) {
    this.events.push([Number(((performance.now() - this.startedAt) / 1_000).toFixed(6)), kind, value])
  }
  write(value) {
    this.record('o', value)
    super.write(value)
  }
  sendInput(value) {
    this.record('i', value)
    super.sendInput(value)
  }
  moveBy(lines) {
    this.record('o', lines > 0 ? `\u001b[${lines}B` : `\u001b[${-lines}A`)
    super.moveBy(lines)
  }
  hideCursor() {
    this.record('o', '\u001b[?25l')
    super.hideCursor()
  }
  showCursor() {
    this.record('o', '\u001b[?25h')
    super.showCursor()
  }
  clearLine() {
    this.record('o', '\u001b[K')
    super.clearLine()
  }
  clearFromCursor() {
    this.record('o', '\u001b[J')
    super.clearFromCursor()
  }
  clearScreen() {
    this.record('o', '\u001b[2J\u001b[H')
    super.clearScreen()
  }
}

function castFor(terminal, title) {
  const events = terminal.events
  const last = events.at(-1)?.[0] ?? 0
  const settled = [...events, [Number((last + 0.05).toFixed(6)), 'o', '\u001b[0m']]
  const header = {
    version: 2,
    width: terminal.columns,
    height: terminal.rows,
    timestamp: Math.floor(Date.now() / 1_000),
    duration: settled.at(-1)[0],
    idle_time_limit: 1,
    command: 'Braid TUI with a deterministic provider whose stream goes silent',
    title,
    env: { TERM: 'xterm-256color' },
    stdin: true,
  }
  return [JSON.stringify(header), ...settled.map((event) => JSON.stringify(event)), ''].join('\n')
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function held() {
  let release
  const promise = new Promise((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const NEVER = new Promise(() => undefined)

function envelope(runId, sequence, event) {
  return {
    runId,
    eventId: `${runId}:event-${sequence}`,
    sequence,
    cursor: `cursor-${sequence}`,
    receivedAt: '2026-10-15T00:00:00.000Z',
    event,
  }
}

const finalEvent = (text) => ({
  type: 'final',
  status: 'completed',
  reason: 'complete',
  text,
  task: { id: 'task-stall', intent: 'capture' },
  timestamp: '2026-10-15T00:00:00.000Z',
})

async function scenario(columns, rows, outcome) {
  const statusGate = held()
  const replayGate = held()
  const execution = {
    streamIdleMs: 300,
    statusTimeoutMs: 2_000,
    capabilities: () => CAPABILITIES,
    admit: () => ({ capabilities: CAPABILITIES, providerSessionId: 'session-capture' }),
    async *streamTurn(input) {
      yield envelope(input.runId, 1, { type: 'text_delta', text: 'Reading the repository. ' })
      yield envelope(input.runId, 2, { type: 'text_delta', text: 'Running the long test suite. ' })
      await NEVER
    },
    async status(input) {
      await statusGate.promise
      if (outcome === 'unknown') {
        throw Object.assign(new Error('sandbox stopped'), { code: 'SANDBOX_STOPPED' })
      }
      return { runId: input.runId, sessionId: 'session-capture', status: 'streaming' }
    },
    reconnect: (input) => ({
      async *[Symbol.asyncIterator]() {
        await replayGate.promise
        yield envelope(input.runId, 3, { type: 'text_delta', text: 'Tests passed. ' })
        yield envelope(input.runId, 4, finalEvent('Reading the repository. Running the long test suite. Tests passed. '))
      },
    }),
  }
  const app = new BraidApplication({
    profile: DETERMINISTIC_PROFILE,
    execution,
    clock: new FixedClock(),
    ids: new SequenceIds(),
  })
  app.initialize('/workspace')
  const terminal = new RecordingTerminal(columns, rows)
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `op-capture-keyboard-${++operation}`,
  })
  const done = view.start()
  const frames = {}
  const status = () => app.state().runs[0]?.status
  const snap = async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    await terminal.waitForRender()
    frames[name] = { status: status(), screen: terminal.getViewport().join('\n') }
  }
  try {
    await terminal.waitForRender()
    // Keyboard: type the request and submit it with Enter.
    for (const character of 'run the tests') terminal.sendInput(character)
    await terminal.waitForRender()
    terminal.sendInput('\r')
    await waitFor(() => status() === 'streaming' && app.state().runs[0]?.lastProviderSequence >= 2, 'streaming')
    await snap('streaming')
    await waitFor(() => status() === 'reconnecting', 'reconnecting after silence')
    await snap('reconnecting')
    statusGate.release()
    if (outcome === 'unknown') {
      await waitFor(() => status() === 'unknown', 'unknown')
      await snap('unknown')
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100))
      await snap('replaying')
      replayGate.release()
      await waitFor(() => status() === 'completed', 'completed')
      await snap('completed')
    }
    return { frames, cast: castFor(terminal, `Silent provider stream, ${outcome}`) }
  } finally {
    statusGate.release()
    replayGate.release()
    view.stop()
    await done
    await app.close().catch(() => undefined)
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(rawRoot, { recursive: true })
const artifacts = []
for (const [columns, rows] of sizes) {
  const name = `${columns}x${rows}`
  for (const outcome of ['reconnect', 'unknown']) {
    const result = await scenario(columns, rows, outcome)
    for (const [state, frame] of Object.entries(result.frames)) {
      const textPath = join(outputRoot, `${name}-${state}.txt`)
      await writeFile(textPath, `${frame.screen}\n`)
      artifacts.push({ path: relative(outputRoot, textPath), sha256: await sha256(textPath), columns, rows, status: frame.status })
    }
    const castPath = join(rawRoot, `${name}-${outcome}.cast`)
    await writeFile(castPath, result.cast)
    if (columns === 80) {
      const gifPath = join(outputRoot, `80x24-${outcome}-keyboard.gif`)
      // agg is optional here; the asciinema cast in raw/ is the recording either way.
      if (await writeCastGif(castPath, gifPath).then(() => true, () => false))
        artifacts.push({ path: relative(outputRoot, gifPath), sha256: await sha256(gifPath), columns, rows })
    }
  }
}
await writeFile(
  join(outputRoot, 'capture-manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: 'pnpm capture:stream-stall',
      execution: 'local deterministic provider whose stream goes silent; not provider integration proof',
      keyboard: 'type "run the tests", Enter; the provider then goes silent for the idle bound',
      provenance: await captureProvenance(),
      artifacts,
    },
    null,
    2,
  )}\n`,
)
console.log(`Captured stream stall states at ${sizes.length} terminal sizes in ${outputRoot}`)
