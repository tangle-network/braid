import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import { installPackedBraid } from './packed-binary.mjs'

const run = promisify(execFile)
const repository = new URL('../', import.meta.url).pathname
const verificationRoot = process.env.BRAID_RELEASE_ARTIFACT_ROOT
  ? process.env.BRAID_RELEASE_ARTIFACT_ROOT
  : join(repository, 'artifacts', 'verification')
const outputRoot = join(verificationRoot, 'w0')
const rawRoot = join(outputRoot, 'raw')
const packed = await installPackedBraid(repository)
const binary = packed.binary
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

async function capture(columns, rows) {
  const emulator = new XtermTerminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  const environment = { ...process.env, TERM: 'xterm-256color' }
  delete environment.NO_COLOR
  delete environment.FORCE_COLOR
  const session = pty.spawn(process.execPath, [binary, '--fixture', 'deterministic'], {
    name: 'xterm-256color',
    cols: columns,
    rows,
    cwd: repository,
    env: environment,
  })
  const startedAt = performance.now()
  const events = []
  let screen = ''
  let captureOutput = true
  const elapsed = () => Number(((performance.now() - startedAt) / 1_000).toFixed(6))
  const refreshScreen = () => {
    const buffer = emulator.buffer.active
    screen = Array.from(
      { length: rows },
      (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
    ).join('\n')
  }
  const exited = new Promise((resolve) => session.onExit(resolve))
  session.onData((data) => {
    if (captureOutput) events.push([elapsed(), 'o', data])
    emulator.write(data, refreshScreen)
  })
  const input = (data) => {
    events.push([elapsed(), 'i', data])
    session.write(data)
  }
  const normalizedScreen = () => screen.replace(/\s+/gu, ' ').trim()

  await waitFor(() => screen.includes('Braid starter'), `${columns}x${rows} conversation shell`)
  input('\u0010')
  await waitFor(() => screen.includes('Commands') && screen.includes('/help'), 'command overlay')
  input('q')
  await waitFor(() => screen.includes('/quit') && !screen.includes('/help'), 'command search')
  input('\u001b')
  await waitFor(() => !screen.includes('Commands'), 'overlay close')
  input("Show Braid's first working turn")
  input('\r')
  await waitFor(
    () =>
      normalizedScreen().includes("Fixture response through pi: Show Braid's first working turn"),
    `${columns}x${rows} response`,
  )

  const finalScreen = `${screen.replace(/[ \t]+$/gmu, '').replace(/\n+$/u, '')}\n`
  captureOutput = false
  session.write('\u0003')
  await waitFor(() => screen.toLowerCase().includes('ctrl+c again to quit'), 'armed capture exit')
  session.write('\u0003')
  const timeout = setTimeout(() => session.kill(), 5_000)
  const exit = await exited.finally(() => clearTimeout(timeout))
  emulator.dispose()
  if (exit.exitCode !== 0) throw new Error(`Capture terminal exited ${exit.exitCode}`)

  const cast = [
    JSON.stringify({
      version: 2,
      width: columns,
      height: rows,
      timestamp: Math.floor(Date.now() / 1_000),
      duration: events.at(-1)?.[0] ?? 0,
      idle_time_limit: 1,
      command: 'braid --fixture deterministic',
      title: `Braid W0 ${columns}x${rows}`,
      env: { SHELL: '/bin/bash', TERM: 'xterm-256color' },
      stdin: true,
    }),
    ...events.map((event) => JSON.stringify(event)),
    '',
  ].join('\n')
  return { cast, finalScreen }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

try {
  await mkdir(rawRoot, { recursive: true })
  const artifacts = []
  for (const [columns, rows] of sizes) {
    const name = `${columns}x${rows}`
    const result = await capture(columns, rows)
    const castPath = join(rawRoot, `${name}.cast`)
    const textPath = join(outputRoot, `${name}.txt`)
    const temporaryGif = join(rawRoot, `${name}-final.gif`)
    const pngPath = join(outputRoot, `${name}.png`)
    await writeFile(castPath, result.cast)
    await writeFile(textPath, result.finalScreen)
    await run('agg', [
      '--quiet',
      '--theme',
      'github-dark',
      '--font-size',
      '16',
      '--select',
      '100%',
      '--no-loop',
      castPath,
      temporaryGif,
    ])
    await run('convert', [`${temporaryGif}[0]`, pngPath])
    await rm(temporaryGif, { force: true })
    artifacts.push({
      path: `${name}.png`,
      sha256: await sha256(pngPath),
      columns,
      rows,
      mode: 'truecolor',
    })
    artifacts.push({ path: `${name}.txt`, sha256: await sha256(textPath), columns, rows })
  }

  const flowCast = join(rawRoot, '80x24.cast')
  const flowGif = join(outputRoot, '80x24-flow.gif')
  await run('agg', [
    '--quiet',
    '--theme',
    'github-dark',
    '--font-size',
    '16',
    '--speed',
    '2',
    '--idle-time-limit',
    '1',
    '--last-frame-duration',
    '2',
    flowCast,
    flowGif,
  ])
  artifacts.push({
    path: '80x24-flow.gif',
    sha256: await sha256(flowGif),
    columns: 80,
    rows: 24,
  })

  const manifestPath = join(outputRoot, 'capture-manifest.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        command: 'pnpm run capture:w0',
        fixture: 'deterministic',
        terminal: 'node-pty/xterm-256color',
        node: process.version,
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(`Wrote ${artifacts.length} capture artifacts to ${dirname(manifestPath)}\n`)
} finally {
  await packed.cleanup()
}
