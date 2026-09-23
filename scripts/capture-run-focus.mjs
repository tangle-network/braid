import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { MemoryCredentialStore } from '../dist/adapters/credentials/memory.js'
import { createApplicationUiController } from '../dist/adapters/tui/application-ui-controller.js'
import { createDurableBraidApplication, DETERMINISTIC_PROFILE } from '../dist/app/composition.js'
import { SequenceIds } from '../dist/ports/ids.js'
import { BraidTerminalApp } from '../dist/views/tui/terminal-app.js'
import { createBraidTheme } from '../dist/views/tui/theme.js'
import { VirtualTerminal } from '../.test-dist-run-focus/test/support/virtual-terminal.js'
import { captureProvenance, writeCastGif, writeRaster } from './capture-visual-support.mjs'

const repository = new URL('../', import.meta.url).pathname
const outputRoot = join(repository, 'artifacts', 'verification', 'run-focus')
const rawRoot = join(outputRoot, 'raw')
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]

class RecordingTerminal extends VirtualTerminal {
  constructor(columns, rows) {
    super(columns, rows)
    this.events = []
    this.startedAt = performance.now()
  }

  record(kind, value) {
    this.events.push([
      Number(((performance.now() - this.startedAt) / 1_000).toFixed(6)),
      kind,
      value,
    ])
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

function castFor(terminal, events, title) {
  const last = events.at(-1)?.[0] ?? 0
  const settled = [...events, [Number((last + 0.05).toFixed(6)), 'o', '\u001b[0m']]
  const header = {
    version: 2,
    width: terminal.columns,
    height: terminal.rows,
    timestamp: Math.floor(Date.now() / 1_000),
    duration: settled.at(-1)[0],
    idle_time_limit: 1,
    command: 'Braid TUI with encrypted SQLite and local fixture execution',
    title,
    env: { TERM: 'xterm-256color' },
    stdin: true,
  }
  return [JSON.stringify(header), ...settled.map((event) => JSON.stringify(event)), ''].join('\n')
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function capture(columns, rows) {
  const root = await mkdtemp(join(tmpdir(), 'braid-run-focus-capture-'))
  const workspace = join(root, 'workspace')
  const keyPath = join(root, 'database.key')
  const credentialStore = new MemoryCredentialStore()
  const path = join(root, 'braid.sqlite')
  let durable
  let view
  let done
  try {
    await mkdir(workspace)
    await writeFile(keyPath, randomBytes(32), { mode: 0o600 })
    const databaseKeySource = { type: 'file', path: keyPath, workspaceRoot: workspace }
    durable = await createDurableBraidApplication({
      path,
      storageRoot: root,
      workspaceRoot: workspace,
      databaseKeySource,
      credentialStore,
      profile: DETERMINISTIC_PROFILE,
      ids: new SequenceIds(),
      execution: {
        async *streamTurn(input) {
          yield {
            type: 'final',
            status: 'completed',
            reason: 'completed',
            text: input.text === 'first' ? 'ALPHA COMPLETE' : 'BETA COMPLETE',
            metadata: { tokenUsage: { input: 1, output: 1 } },
            task: { id: input.runId, intent: input.text },
            timestamp: '2026-09-23T00:00:00.000Z',
          }
        },
      },
    })
    const app = durable.app
    app.initialize(workspace)
    await app.whenDurable()
    await app.conversations.lifecycle.create({
      operationId: 'op-capture-create-alpha',
      title: 'Alpha conversation',
    })
    const alpha = app.send({ operationId: 'op-capture-run-alpha', text: 'first' })
    await alpha.completion
    await app.conversations.drafts.set({
      operationId: 'op-capture-draft-alpha',
      text: 'Alpha draft',
    })
    await app.conversations.lifecycle.create({
      operationId: 'op-capture-create-beta',
      title: 'Beta conversation',
    })
    const beta = app.send({ operationId: 'op-capture-run-beta', text: 'second' })
    await beta.completion
    await app.conversations.drafts.set({ operationId: 'op-capture-draft-beta', text: 'Beta draft' })
    assert.equal(app.state().focusedRunId, beta.runId)
    await durable.storage.close()
    durable = await createDurableBraidApplication({
      path,
      storageRoot: root,
      workspaceRoot: workspace,
      databaseKeySource,
      credentialStore,
      profile: DETERMINISTIC_PROFILE,
    })
    const restored = durable.app
    const terminal = new RecordingTerminal(columns, rows)
    let operation = 0
    view = new BraidTerminalApp({
      controller: createApplicationUiController(restored),
      tui: new TuiMainScreen(terminal),
      theme: createBraidTheme(false),
      workspace,
      nextOperationId: () => `op-capture-keyboard-${++operation}`,
    })
    done = view.start()
    await terminal.waitForRender()
    assert.match(terminal.getViewport().join('\n'), /BETA COMPLETE/u)
    await new Promise((resolve) => setTimeout(resolve, 300))

    terminal.sendInput('\u001bOQ')
    await terminal.waitForRender()
    assert.match(terminal.getViewport().join('\n'), /activity/u)
    terminal.sendInput('\t')
    await terminal.waitForRender()
    terminal.sendInput('\u001b[B')
    terminal.sendInput('\r')
    await waitFor(() => restored.state().focusedRunId === alpha.runId, 'alpha run focus')
    await terminal.waitForRender()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      terminal.sendInput('\u001b')
      await terminal.waitForRender()
      if (terminal.getViewport().join('\n').includes('ALPHA COMPLETE')) break
    }
    const screen = terminal.getViewport().join('\n')
    assert.match(screen, /ALPHA COMPLETE/u)
    assert.doesNotMatch(screen, /BETA COMPLETE/u)
    assert.equal(
      restored.state().conversationId,
      restored.state().runs.find((run) => run.id === alpha.runId)?.conversationId,
    )
    assert.equal(
      restored.state().branchId,
      restored.state().runs.find((run) => run.id === alpha.runId)?.branchId,
    )
    await restored.whenDurable()
    return {
      terminal,
      screen,
      cast: castFor(terminal, terminal.events, 'Focus completed Alpha run from Beta conversation'),
    }
  } finally {
    view?.stop()
    await done
    await durable?.storage.close()
    await rm(root, { recursive: true, force: true })
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
  const frame = await capture(columns, rows)
  const textPath = join(outputRoot, `${name}.txt`)
  const castPath = join(rawRoot, `${name}.cast`)
  const pngPath = join(outputRoot, `${name}.png`)
  await writeFile(textPath, `${frame.screen}\n`)
  await writeFile(castPath, frame.cast)
  await writeRaster(castPath, pngPath, join(rawRoot, `${name}.gif`))
  artifacts.push({
    path: relative(outputRoot, textPath),
    sha256: await sha256(textPath),
    columns,
    rows,
  })
  artifacts.push({
    path: relative(outputRoot, pngPath),
    sha256: await sha256(pngPath),
    columns,
    rows,
  })
  if (columns === 80) {
    const gifPath = join(outputRoot, '80x24-keyboard.gif')
    await writeCastGif(castPath, gifPath)
    artifacts.push({
      path: relative(outputRoot, gifPath),
      sha256: await sha256(gifPath),
      columns,
      rows,
    })
  }
}
await writeFile(
  join(outputRoot, 'capture-manifest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      command: 'pnpm capture:run-focus',
      execution: 'local deterministic fixture; not provider integration proof',
      storage: 'encrypted SQLite, closed and reopened before keyboard navigation',
      keyboard: 'F2, Tab, Down, Enter, Escape to select completed Alpha from Beta',
      provenance: await captureProvenance(),
      artifacts,
    },
    null,
    2,
  )}\n`,
)
console.log(`Captured run focus at ${sizes.length} terminal sizes in ${outputRoot}`)
