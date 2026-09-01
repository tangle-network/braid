import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { createStateDefinitions, isRunningWorkStripRow } from './capture-visual-definitions.mjs'
import {
  captureProvenance,
  createArtifactFor,
  writeCastGif,
  writeFlowGif,
  writeRaster,
} from './capture-visual-support.mjs'
import { installPackedBraid } from './packed-binary.mjs'

const run = promisify(execFile)
const repository = new URL('../', import.meta.url).pathname
const verificationRoot = process.env.BRAID_RELEASE_ARTIFACT_ROOT
  ? process.env.BRAID_RELEASE_ARTIFACT_ROOT
  : join(repository, 'artifacts', 'verification')
const packed = await installPackedBraid(repository, {
  tarballPath: process.env.BRAID_RELEASE_TARBALL,
})
const binary = packed.binary
const outputRoot = join(verificationRoot, 'w6')
const rawRoot = join(outputRoot, 'raw')
const stateRoot = join(outputRoot, 'states')
const XtermTerminal = xterm.Terminal
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

function shellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function screenFrom(emulator, rows) {
  const buffer = emulator.buffer.active
  return Array.from(
    { length: rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
  ).join('\n')
}

function normalized(screen) {
  return screen.replace(/\s+/gu, ' ').trim()
}

const STATE_DEFINITIONS = createStateDefinitions(normalized)

async function spawnTerminal(
  name,
  columns,
  rows,
  extraEnvironment = {},
  uiFixture,
  cliArgs = [],
  { fixture = true } = {},
) {
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
  const args = [binary]
  if (fixture) args.push('--fixture', 'deterministic')
  args.push('--record-state', recordPath)
  if (uiFixture) args.push('--ui-fixture', uiFixture)
  args.push(...cliArgs)
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
  let pendingWrites = 0
  let lastOutputAt = performance.now()
  const refresh = () => {
    screen = screenFrom(emulator, rows)
  }
  const exitPromise = new Promise((resolve) =>
    session.onExit((event) => {
      exited = true
      resolve(event)
    }),
  )
  const waitForExit = async (label) => {
    let timeout
    try {
      return await Promise.race([
        exitPromise,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${name} did not exit ${label}`)), 5_000)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  session.onData((data) => {
    output += data
    events.push([Number(((performance.now() - startedAt) / 1_000).toFixed(6)), 'o', data])
    lastOutputAt = performance.now()
    pendingWrites += 1
    emulator.write(data, () => {
      refresh()
      pendingWrites -= 1
    })
  })
  const input = (data) => {
    events.push([Number(((performance.now() - startedAt) / 1_000).toFixed(6)), 'i', data])
    session.write(data)
  }
  const resize = (nextColumns, nextRows) => {
    emulator.resize(nextColumns, nextRows)
    session.resize(nextColumns, nextRows)
  }
  const snapshot = () => ({
    screen: `${screen.replace(/[ \t]+$/gmu, '').replace(/\n+$/u, '')}\n`,
    output,
    eventCount: events.length,
  })
  const closeNormally = async () => {
    if (exited) return
    if (name === 'state-failure-or-reconnect') {
      await closeWithSignal()
      return
    }
    // A captured state may contain nested screens (for example the profile
    // selector inside the profile editor). Escape each possible layer before
    // exercising the shell's normal two-step Ctrl+C exit.
    for (let layer = 0; layer < 4; layer += 1) {
      input('\u001b')
      // A bare Escape is decoded after a short ambiguity window. Keep each
      // layer separate so a busy process cannot combine them into one sequence.
      await sleep(250)
      await waitForStable(`${name} escape layer ${layer + 1}`)
    }
    input('\u0003')
    try {
      await waitFor(
        () => output.toLowerCase().includes('ctrl+c again to quit'),
        `${name} safe exit prompt`,
        2_000,
      )
    } catch {
      await closeWithSignal()
      return
    }
    input('\u0003')
    const event = await waitForExit('normally')
    if (event.exitCode !== 0) throw new Error(`${name} exited ${event.exitCode}`)
    if (!output.toLowerCase().includes('ctrl+c again to quit'))
      throw new Error(`${name} did not render the safe exit prompt`)
  }
  const closeWithSignal = async () => {
    if (exited) return
    process.kill(session.pid, 'SIGINT')
    const event = await waitForExit('after SIGINT')
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
  const waitForStable = (label = 'settled terminal frame') =>
    waitFor(() => pendingWrites === 0 && performance.now() - lastOutputAt >= 75, `${name} ${label}`)
  const fullInterfaceMarker = uiFixture === 'interaction' ? '↑↓ move' : 'type / for commands'
  const waitForInterface = () =>
    waitFor(
      () => output.includes('\u001b[?1049h') && output.includes(fullInterfaceMarker),
      `${name} full interface handoff`,
      15_000,
    )
  const captureState = async () => {
    await waitForStable()
    const point = snapshot()
    await rm(`${recordPath}.frame`, { force: true })
    process.kill(session.pid, 'SIGUSR2')
    return { point, record: await readRecord('.frame') }
  }
  const dispose = async () => {
    if (!exited) {
      session.kill()
      await Promise.race([exitPromise, sleep(1_000)])
    }
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
    resize,
    output: () => output,
    screen: () => screen,
    snapshot,
    waitFor: (predicate, label, timeoutMs) => waitFor(predicate, `${name} ${label}`, timeoutMs),
    waitForInterface,
    waitForStable,
    closeNormally,
    closeWithSignal,
    readRecord,
    captureState,
    dispose,
  }
}

function castFor(result, events, title, command = 'packed braid --fixture deterministic') {
  const lastEventAt = events.at(-1)?.[0] ?? 0
  // agg samples a percentage position before applying an output event that lands
  // exactly at the cast duration. A later no-op makes every split final write
  // visible in the selected raster without changing the terminal frame.
  const settledEvents = [...events, [Number((lastEventAt + 0.01).toFixed(6)), 'o', '\u001b[0m']]
  const header = {
    version: 2,
    width: result.columns,
    height: result.rows,
    timestamp: Math.floor(Date.now() / 1_000),
    duration: settledEvents.at(-1)[0],
    idle_time_limit: 1,
    command,
    title,
    env: { TERM: 'xterm-256color' },
    stdin: true,
  }
  return [JSON.stringify(header), ...settledEvents.map((event) => JSON.stringify(event)), ''].join(
    '\n',
  )
}

async function plainFrame() {
  const environment = { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' }
  const fifoRoot = await mkdtemp(join(tmpdir(), 'braid-plain-capture-'))
  const stdoutPath = join(fifoRoot, 'stdout')
  const stderrPath = join(fifoRoot, 'stderr')
  await run('mkfifo', [stdoutPath, stderrPath])
  const output = { value: '' }
  const error = { value: '' }
  const readFifo = (path, sink) =>
    new Promise((resolve, reject) => {
      const stream = createReadStream(path, { encoding: 'utf8' })
      stream.on('data', (chunk) => {
        sink.value += chunk
      })
      stream.on('error', reject)
      stream.on('end', resolve)
    })
  const session = spawn(
    '/bin/sh',
    [
      '-c',
      `{ printf '%s\\n' 'W6 plain proof'; sleep 4; } | exec ${shellArgument(binary)} --plain --fixture deterministic --no-color > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`,
    ],
    {
      cwd: repository,
      env: { ...environment, BRAID_JOURNAL_PATH: join(rawRoot, `plain-${randomUUID()}.journal`) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let wrapperStderr = ''
  session.stdout.resume()
  session.stderr.setEncoding('utf8')
  session.stderr.on('data', (chunk) => {
    wrapperStderr += chunk
  })
  const exited = new Promise((resolve, reject) => {
    session.on('error', reject)
    session.on('close', (code) => resolve({ exitCode: code }))
  })
  const timeout = setTimeout(() => session.kill(), 10_000)
  const [exit] = await Promise.all([
    exited,
    readFifo(stdoutPath, output),
    readFifo(stderrPath, error),
  ])
  clearTimeout(timeout)
  await rm(fifoRoot, { force: true, recursive: true })
  if (exit.exitCode !== 0) throw new Error(`plain capture exited ${exit.exitCode}`)
  const stdout = output.value
  const stderr = `${wrapperStderr}${error.value}`
  const normalizedOutput = stdout.replace(/\r\n/gu, '\n').replace(/\r/gu, '')
  if ([0x1b, 0x9b].some((code) => normalizedOutput.includes(String.fromCharCode(code))))
    throw new Error('plain output contains terminal controls')
  if (stderr) throw new Error(`plain capture wrote stderr: ${stderr}`)
  return normalizedOutput
}

async function baselineCapture(columns, rows) {
  const terminal = await spawnTerminal(`baseline-${columns}x${rows}`, columns, rows)
  try {
    await terminal.waitForInterface()
    await terminal.waitFor(() => terminal.screen().includes('Braid starter'), 'profile context')
    terminal.input('W6 visual proof')
    terminal.input('\r')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes('Fixture response through pi: W6 visual proof'),
      'response',
    )
    await terminal.waitFor(
      () =>
        normalized(terminal.screen()).includes('Braid starter') &&
        !normalized(terminal.screen()).includes('working'),
      'final state',
    )
    await terminal.waitForStable('baseline final frame')
    const point = terminal.snapshot()
    await terminal.closeNormally()
    return {
      columns,
      rows,
      finalScreen: point.screen,
      cast: castFor(terminal, terminal.events, `Braid W6 ${columns}x${rows}`),
      frameCast: castFor(
        terminal,
        terminal.events.slice(0, point.eventCount),
        `Braid W6 ${columns}x${rows}`,
      ),
    }
  } finally {
    await terminal.dispose()
  }
}

async function transcriptKeyboardCapture() {
  const terminal = await spawnTerminal('transcript-keyboard', 80, 24)
  const prompts = Array.from(
    { length: 8 },
    (_, index) => `keyboard-flow-${String(index + 1).padStart(2, '0')}`,
  )
  try {
    await terminal.waitForInterface()
    await terminal.waitFor(() => terminal.screen().includes('Braid starter'), 'profile context')
    for (const prompt of prompts) {
      terminal.input(prompt)
      terminal.input('\r')
      await terminal.waitFor(
        () => normalized(terminal.screen()).includes(`Fixture response through pi: ${prompt}`),
        `${prompt} response`,
      )
      await terminal.waitForStable(`${prompt} final frame`)
    }
    terminal.input('\u001b[5~')
    await terminal.waitForStable('Page Up frame')
    terminal.input('\u001b[1;3H')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes(prompts[0]),
      'Alt+Home first turn',
      15_000,
    )
    await terminal.waitForStable('Alt+Home frame')
    terminal.input('\u001b[6~')
    await terminal.waitForStable('Page Down frame')
    terminal.input('\u001b[1;3F')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes(prompts.at(-1)),
      'Alt+End final turn',
      15_000,
    )
    await terminal.waitForStable('Alt+End frame')
    const events = [...terminal.events]
    await terminal.closeNormally()
    return {
      cast: castFor(terminal, events, 'Braid transcript keyboard navigation'),
      steps: ['8 completed turns', 'Page Up', 'Alt+Home', 'Page Down', 'Alt+End'],
    }
  } finally {
    await terminal.dispose()
  }
}

const artifactFor = createArtifactFor(outputRoot, sha256)

try {
  await mkdir(rawRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  const artifacts = []
  const plain = await plainFrame()
  for (const [columns, rows] of sizes) {
    const result = await baselineCapture(columns, rows)
    const name = `${columns}x${rows}`
    const castPath = join(rawRoot, `${name}.cast`)
    const frameCastPath = join(rawRoot, `${name}-frame.cast`)
    const textPath = join(outputRoot, `${name}.txt`)
    const plainPath = join(outputRoot, `${name}-plain.txt`)
    const gifPath = join(rawRoot, `${name}.gif`)
    const pngPath = join(outputRoot, `${name}.png`)
    await writeFile(castPath, result.cast)
    await writeFile(frameCastPath, result.frameCast)
    await writeFile(textPath, result.finalScreen)
    await writeFile(plainPath, plain)
    await writeRaster(frameCastPath, pngPath, gifPath)
    artifacts.push(await artifactFor(textPath, 'terminal-frame', columns, rows))
    artifacts.push(await artifactFor(plainPath, 'plain-frame', columns, rows))
    artifacts.push(await artifactFor(pngPath, 'png', columns, rows))
  }

  const stateManifests = []
  for (const definition of STATE_DEFINITIONS) {
    const terminal = await spawnTerminal(
      `state-${definition.name}`,
      definition.columns,
      definition.rows,
      definition.environment,
      definition.uiFixture,
    )
    try {
      await terminal.waitForInterface()
      const result = await definition.run(terminal)
      const provenance = await captureProvenance()
      if (definition.name === 'active-streaming') {
        if (result.record.view?.status !== 'running')
          throw new Error('active-streaming frame and semantic state disagree')
        if (!normalized(result.point.screen).includes('working'))
          throw new Error('active-streaming frame does not show active work')
      }
      if (definition.name === 'multi-run') {
        const workStrip = result.record.view?.workStrip ?? []
        const renderedRows = result.point.screen.split('\n').filter(isRunningWorkStripRow)
        if (workStrip.length !== 2 || renderedRows.length !== 2) {
          throw new Error(
            `multi-run capture did not expose two Work Strip rows (view=${workStrip.length}, rendered=${renderedRows.length})`,
          )
        }
        if (
          typeof result.switchedFrom !== 'string' ||
          typeof result.targetRunId !== 'string' ||
          result.record.view?.focusedRunId !== result.targetRunId
        ) {
          throw new Error(
            `multi-run capture did not switch the focused run through Activity (before=${String(result.switchedFrom)}, target=${String(result.targetRunId)}, after=${String(result.record.view?.focusedRunId)}, rows=${JSON.stringify(workStrip.map((item) => ({ runId: item.runId, focused: item.focused })))})`,
          )
        }
      }
      if (definition.name === 'supervision') {
        if (result.record.view?.activity?.filter((item) => item.kind === 'worker').length !== 3) {
          throw new Error('supervision capture did not contain three projected workers')
        }
        if (!normalized(result.point.screen).includes('a/r')) {
          throw new Error('supervision capture did not expose the worker attach control')
        }
      }
      if (
        result.record.capturePhase !== 'atomic-signal-frame' ||
        result.record.state?.revision !== result.record.view?.revision
      )
        throw new Error('frame and semantic state were not captured at one revision')
      if (definition.name === 'interaction') {
        if (result.record.view?.interactions?.length !== 1)
          throw new Error('interaction capture did not contain an interaction fixture')
      }
      if (
        definition.name === 'automation' &&
        !normalized(result.point.screen).includes('automation rules')
      )
        throw new Error('automation capture did not contain the rule manager')
      if (definition.name === 'fork-preview' && result.record.view?.forkPreview?.allowed !== true)
        throw new Error('fork capture did not contain an allowed fork preview')
      if (
        definition.name === 'analysis' &&
        !normalized(result.point.screen).includes('/ask · frozen question')
      )
        throw new Error('analysis capture did not contain a saved analysis result')
      if (
        definition.name === 'comparison' &&
        !normalized(result.point.screen).includes('/compare · frozen runs')
      )
        throw new Error('comparison capture did not contain a saved comparison result')
      if (
        definition.name === 'profile' &&
        !normalized(result.point.screen).includes('trusted · read-only')
      )
        throw new Error('profile capture did not contain the active profile editor')
      if (definition.name.startsWith('cancellation-unavailable-')) {
        const cancellation = result.record.view?.capabilities?.['run.cancel']
        if (cancellation?.available !== false) {
          throw new Error('cancellation-unavailable capture advertised cancellation')
        }
        if (
          !normalized(result.point.screen).includes('/cancel') ||
          !normalized(result.point.screen).includes('unavailable')
        ) {
          throw new Error('cancellation-unavailable capture did not show the unavailable action')
        }
      }
      const stateRootName = definition.name.replaceAll('/', '-')
      const semanticPath = join(stateRoot, `${stateRootName}.json`)
      const plainPath = join(stateRoot, `${stateRootName}.txt`)
      const ansiPath = join(stateRoot, `${stateRootName}.ansi`)
      const castPath = join(rawRoot, `${stateRootName}.cast`)
      const frameCastPath = join(rawRoot, `${stateRootName}-frame.cast`)
      const gifPath = join(rawRoot, `${stateRootName}.gif`)
      const pngPath = join(stateRoot, `${stateRootName}.png`)
      const semantic = {
        schemaVersion: 2,
        state: definition.name,
        source: {
          binary: 'packed real binary from clean npm install',
          binarySha256: await sha256(binary),
          tarball: packed.tarballName,
          tarballSha256: packed.tarballSha256,
        },
        dimensions: { columns: definition.columns, rows: definition.rows },
        terminal: 'node-pty/xterm-256color',
        provenance,
        capturePhase: 'atomic-signal-frame',
        captureRevision: result.record.view.revision,
        frame: result.point.screen,
        packedState: result.record,
      }
      const cast = castFor(terminal, terminal.events, `Braid W6 state ${definition.name}`)
      const frameCast = castFor(
        terminal,
        terminal.events.slice(0, result.point.eventCount),
        `Braid W6 state ${definition.name}`,
      )
      await writeFile(semanticPath, `${JSON.stringify(semantic, null, 2)}\n`)
      await writeFile(plainPath, result.point.screen)
      await writeFile(ansiPath, result.point.output)
      await writeFile(castPath, cast)
      await writeFile(frameCastPath, frameCast)
      await writeRaster(frameCastPath, pngPath, gifPath)
      const stateArtifacts = [
        await artifactFor(
          semanticPath,
          'semantic-state',
          definition.columns,
          definition.rows,
          definition.name,
        ),
        await artifactFor(
          plainPath,
          'plain-frame',
          definition.columns,
          definition.rows,
          definition.name,
        ),
        await artifactFor(
          castPath,
          'asciicast',
          definition.columns,
          definition.rows,
          definition.name,
        ),
        await artifactFor(ansiPath, 'ansi', definition.columns, definition.rows, definition.name),
        await artifactFor(pngPath, 'png', definition.columns, definition.rows, definition.name),
      ]
      artifacts.push(...stateArtifacts)
      stateManifests.push({
        name: definition.name,
        columns: definition.columns,
        rows: definition.rows,
        artifacts: Object.fromEntries(
          stateArtifacts.map((artifact) => [artifact.kind, artifact.path]),
        ),
      })
    } finally {
      await terminal.dispose()
    }
  }

  const flowGif = join(outputRoot, '80x24-flow.gif')
  await writeFlowGif(join(stateRoot, 'empty.png'), join(outputRoot, '80x24.png'), flowGif)
  artifacts.push(await artifactFor(flowGif, 'flow', 80, 24))

  const automationGif = join(outputRoot, '80x24-automation.gif')
  await writeCastGif(join(rawRoot, 'automation-frame.cast'), automationGif)
  artifacts.push(await artifactFor(automationGif, 'automation-flow', 80, 24, 'automation'))

  const multiRunGif = join(outputRoot, '80x24-multirun.gif')
  await writeCastGif(join(rawRoot, 'multi-run.cast'), multiRunGif)
  const multiRunArtifact = await artifactFor(multiRunGif, 'multi-run-flow', 80, 24, 'multi-run')
  artifacts.push(multiRunArtifact)

  const keyboardFlow = await transcriptKeyboardCapture()
  const keyboardCast = join(rawRoot, 'transcript-keyboard.cast')
  const keyboardGif = join(outputRoot, '80x24-transcript-keyboard.gif')
  await writeFile(keyboardCast, keyboardFlow.cast)
  await writeCastGif(keyboardCast, keyboardGif)
  const keyboardArtifacts = [
    await artifactFor(keyboardCast, 'keyboard-asciicast', 80, 24),
    await artifactFor(keyboardGif, 'keyboard-flow', 80, 24),
  ]
  artifacts.push(...keyboardArtifacts)

  const manifestPath = join(outputRoot, 'capture-manifest.json')
  const provenance = await captureProvenance()
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 3,
        generatedAt: new Date().toISOString(),
        command: 'pnpm capture:visual',
        binary: 'clean npm install from generated tarball',
        binarySha256: await sha256(binary),
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        stateFixture: 'deterministic',
        liveDemoCommand: 'pnpm capture:demo:live',
        terminal: 'node-pty/xterm-256color',
        node: process.version,
        provenance,
        keyboardFlow: {
          steps: keyboardFlow.steps,
          artifacts: keyboardArtifacts.map((artifact) => artifact.path),
        },
        multiRunFlow: {
          steps: [
            'start run A',
            'create conversation B while A remains active',
            'start run B',
            'open Activity',
            'switch focus to run A',
          ],
          artifacts: [multiRunArtifact.path],
        },
        states: stateManifests,
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `Wrote ${artifacts.length} W6 visual artifacts and ${stateManifests.length} required states to ${outputRoot}\n`,
  )
} finally {
  await packed.cleanup()
}
