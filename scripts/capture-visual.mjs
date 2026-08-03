import { randomUUID, createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import * as pty from 'node-pty'
import xterm from '@xterm/headless'
import { installPackedBraid } from './packed-binary.mjs'

const run = promisify(execFile)
const repository = new URL('../', import.meta.url).pathname
const packed = await installPackedBraid(repository)
const binary = packed.binary
const outputRoot = join(repository, 'artifacts', 'verification', 'w6')
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

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000
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

async function spawnTerminal(name, columns, rows, extraEnvironment = {}, uiFixture) {
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

function castFor(result, events, title) {
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
      `{ printf '%s\\n' 'W6 plain proof'; } | exec ${shellArgument(binary)} --plain --fixture deterministic --no-color > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`,
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
  const timeout = setTimeout(() => session.kill(), 5_000)
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
    await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
    terminal.input('W6 visual proof')
    terminal.input('\r')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes('Fixture response through pi: W6 visual proof'),
      'response',
    )
    await terminal.waitFor(
      () =>
        normalized(terminal.screen()).includes('completed') ||
        normalized(terminal.screen()).includes('ready for a message'),
      'final state',
    )
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

const STATE_DEFINITIONS = [
  {
    name: 'empty',
    columns: 80,
    rows: 24,
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'active-streaming',
    columns: 80,
    rows: 24,
    environment: { BRAID_FIXTURE_CHUNK_DELAY_MS: '1000' },
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('W6 active streaming')
      terminal.input('\r')
      await terminal.waitFor(() => normalized(terminal.screen()).includes('streaming'), 'streaming')
      const { point, record } = await terminal.captureState()
      terminal.input('/cancel')
      terminal.input('\r')
      await terminal.waitFor(
        () =>
          normalized(terminal.screen()).includes('cancelled') ||
          normalized(terminal.screen()).includes('completed'),
        'cancellation',
      )
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'interaction',
    columns: 80,
    rows: 24,
    uiFixture: 'interaction',
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      await terminal.waitFor(
        () => normalized(terminal.screen()).includes('Allow the fixture tool'),
        'interaction fixture',
      )
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'fork-preview',
    columns: 80,
    rows: 24,
    uiFixture: 'fork',
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('/fork')
      await sleep(50)
      terminal.input('\r')
      await sleep(50)
      terminal.input('\r')
      await terminal.waitFor(
        () => normalized(terminal.screen()).includes('workspace-fork'),
        `fork fixture screen=${normalized(terminal.screen())}`,
      )
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'graph-or-analysis',
    columns: 80,
    rows: 24,
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('\u0007')
      await terminal.waitFor(
        () => normalized(terminal.screen()).includes('conversation graph'),
        'graph',
      )
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'narrow',
    columns: 40,
    rows: 12,
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'failure-or-reconnect',
    columns: 80,
    rows: 24,
    environment: { BRAID_FIXTURE_FAILURE: '1' },
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('W6 failure state')
      terminal.input('\r')
      await terminal.waitFor(() => normalized(terminal.screen()).includes('failed'), 'failure')
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
]

async function writeRaster(frameCastPath, pngPath, gifPath) {
  const fontFamily = 'DejaVu Sans Mono'
  await run('agg', [
    '--quiet',
    '--theme',
    'github-dark',
    '--font-size',
    '16',
    '--idle-time-limit',
    '1',
    '--last-frame-duration',
    '1',
    '--no-loop',
    '--font-family',
    fontFamily,
    frameCastPath,
    gifPath,
  ])
  await run('convert', [
    gifPath,
    '-coalesce',
    '-delete',
    '0--2',
    '-colorspace',
    'sRGB',
    '-depth',
    '8',
    pngPath,
  ])
  await rm(gifPath, { force: true })
}

async function toolVersion(command, args) {
  try {
    const result = await run(command, args)
    return (result.stdout || result.stderr || '').trim().split('\n')[0] || 'unknown'
  } catch (error) {
    return `unavailable: ${error.message}`
  }
}

async function captureProvenance() {
  return {
    renderer: {
      package: '@earendil-works/pi-tui@0.83.0',
      pty: 'node-pty@1.1.0',
      emulator: '@xterm/headless@5.5.0',
      node: process.version,
      terminal: 'xterm-256color',
    },
    raster: {
      agg: await toolVersion('agg', ['--version']),
      imagemagick: await toolVersion('convert', ['-version']),
      fontFamily: 'DejaVu Sans Mono',
      font: await toolVersion('fc-match', [
        '--format=%{family} | %{style} | %{file}',
        'DejaVu Sans Mono',
      ]),
      colorMode: 'sRGB 8-bit',
    },
  }
}

async function artifactFor(path, kind, columns, rows, state) {
  return {
    path: relative(outputRoot, path),
    sha256: await sha256(path),
    kind,
    ...(state ? { state } : {}),
    columns,
    rows,
  }
}

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
      const result = await definition.run(terminal)
      const provenance = await captureProvenance()
      if (definition.name === 'active-streaming') {
        if (result.record.view?.status !== 'running')
          throw new Error('active-streaming frame and semantic state disagree')
        if (!normalized(result.point.screen).includes('streaming'))
          throw new Error('active-streaming frame is not streaming')
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
      if (definition.name === 'fork-preview' && result.record.view?.forkPreview?.allowed !== true)
        throw new Error('fork capture did not contain an allowed fork preview')
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

  const flowPath = join(rawRoot, '80x24-frame.cast')
  const flowGif = join(outputRoot, '80x24-flow.gif')
  await run('agg', [
    '--quiet',
    '--theme',
    'github-dark',
    '--font-size',
    '16',
    '--font-family',
    'DejaVu Sans Mono',
    '--speed',
    '2',
    '--idle-time-limit',
    '1',
    '--last-frame-duration',
    '2',
    flowPath,
    flowGif,
  ])
  artifacts.push(await artifactFor(flowGif, 'flow', 80, 24))

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
        fixture: 'deterministic',
        terminal: 'node-pty/xterm-256color',
        node: process.version,
        provenance,
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
