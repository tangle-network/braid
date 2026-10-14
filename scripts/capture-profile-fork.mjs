import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import {
  captureProvenance,
  createArtifactFor,
  writeCastGif,
  writeRaster,
} from './capture-visual-support.mjs'
import { installPackedBraid } from './packed-binary.mjs'

const repository = new URL('../', import.meta.url).pathname
const outputRoot = join(repository, 'artifacts', 'verification', 'profile-fork')
const rawRoot = join(outputRoot, 'raw')
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]
const sourceProfile = 'Release engineer'
const destinationProfile = 'Review engineer'
const XtermTerminal = xterm.Terminal

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label, diagnostic, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      const detail = diagnostic?.()
      throw new Error(`Timed out waiting for ${label}${detail ? `\n${detail}` : ''}`)
    }
    await sleep(20)
  }
}

function normalized(value) {
  return value.replace(/\s+/gu, ' ').trim()
}

function screenFrom(emulator, rows) {
  const buffer = emulator.buffer.active
  return Array.from(
    { length: rows },
    (_, index) => buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? '',
  ).join('\n')
}

function castFor(terminal, events, title) {
  const lastEventAt = events.at(-1)?.[0] ?? 0
  const settled = [...events, [Number((lastEventAt + 0.01).toFixed(6)), 'o', '\u001b[0m']]
  const header = {
    version: 2,
    width: terminal.columns,
    height: terminal.rows,
    timestamp: Math.floor(Date.now() / 1_000),
    duration: settled.at(-1)[0],
    idle_time_limit: 1,
    command: 'packed braid --fixture deterministic --ui-fixture profile-handoff',
    title,
    env: { TERM: 'xterm-256color' },
    stdin: true,
  }
  return [JSON.stringify(header), ...settled.map((event) => JSON.stringify(event)), ''].join('\n')
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function spawnTerminal(binary, columns, rows, workspace) {
  const emulator = new XtermTerminal({
    cols: columns,
    rows,
    disableStdin: true,
    allowProposedApi: true,
  })
  const environment = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    NODE_NO_WARNINGS: '1',
    BRAID_FIXTURE_CHUNK_DELAY_MS: '0',
  }
  delete environment.NO_COLOR
  delete environment.FORCE_COLOR
  const session = pty.spawn(
    process.execPath,
    [
      binary,
      '--fixture',
      'deterministic',
      '--ui-fixture',
      'profile-handoff',
      '--workspace',
      workspace,
    ],
    { name: 'xterm-256color', cols: columns, rows, cwd: workspace, env: environment },
  )
  const startedAt = performance.now()
  const events = []
  let output = ''
  let screen = ''
  let pendingWrites = 0
  let lastOutputAt = performance.now()
  let exited = false
  const exit = new Promise((resolve) =>
    session.onExit((result) => {
      exited = true
      resolve(result)
    }),
  )
  session.onData((data) => {
    output += data
    events.push([Number(((performance.now() - startedAt) / 1_000).toFixed(6)), 'o', data])
    lastOutputAt = performance.now()
    pendingWrites += 1
    emulator.write(data, () => {
      screen = screenFrom(emulator, rows)
      pendingWrites -= 1
    })
  })
  const input = (data) => {
    events.push([Number(((performance.now() - startedAt) / 1_000).toFixed(6)), 'i', data])
    session.write(data)
  }
  const stable = (label) =>
    waitFor(
      () => pendingWrites === 0 && performance.now() - lastOutputAt >= 75,
      `${columns}x${rows} ${label}`,
      () => screen,
    )
  const close = async () => {
    if (exited) return
    for (let layer = 0; layer < 3; layer += 1) {
      input('\u001b')
      await sleep(250)
      await stable(`escape layer ${layer + 1}`)
    }
    input('\u0003')
    await waitFor(
      () => normalized(output).toLowerCase().includes('ctrl+c again to quit'),
      'safe exit',
      () => screen,
    )
    input('\u0003')
    const result = await Promise.race([
      exit,
      sleep(5_000).then(() => {
        throw new Error('Packed profile fork capture did not exit')
      }),
    ])
    if (result.exitCode !== 0)
      throw new Error(`Packed profile fork capture exited ${result.exitCode}`)
  }
  const dispose = async () => {
    if (!exited) session.kill()
    emulator.dispose()
  }
  return {
    columns,
    rows,
    events,
    input,
    screen: () => screen,
    output: () => output,
    stable,
    close,
    dispose,
  }
}

function waitForScreen(terminal, predicate, label, timeoutMs) {
  return waitFor(
    () => predicate(normalized(terminal.screen())),
    label,
    () => terminal.screen(),
    timeoutMs,
  )
}

async function submit(terminal, text, label) {
  await terminal.stable(`before ${label}`)
  terminal.input(text)
  await terminal.stable(`${label} draft`)
  terminal.input('\r')
}

/** Select the destination-capable connection and record one source turn. */
async function prepareSource(terminal) {
  await waitFor(
    () => terminal.output().includes('type / for commands'),
    'full interface',
    () => terminal.screen(),
    15_000,
  )
  await submit(terminal, '/connection select connection-local-cli-bridge', 'connection select')
  // Sending stays unavailable until the selected connection reaches the composer.
  await waitForScreen(terminal, (screen) => screen.includes('new message'), 'connection selected')
  await terminal.stable('connection selected')
  await submit(terminal, 'Summarize the release risk', 'source turn')
  await waitForScreen(
    terminal,
    (screen) => screen.includes(`${sourceProfile} answered`),
    'source turn answer',
  )
}

async function openProfileFork(terminal) {
  await submit(terminal, `/fork --profile "${destinationProfile}"`, 'profile fork command')
  await waitForScreen(
    terminal,
    (screen) => screen.includes('fork preview') && screen.includes('enter/y create'),
    'profile fork preview',
  )
  await terminal.stable('profile fork preview')
}

async function captureFrame(binary, columns, rows) {
  const workspace = await mkdtemp(join(tmpdir(), `braid-profile-fork-${columns}x${rows}-`))
  const terminal = await spawnTerminal(binary, columns, rows, workspace)
  try {
    await prepareSource(terminal)
    await openProfileFork(terminal)
    const screen = `${terminal
      .screen()
      .replace(/[ \t]+$/gmu, '')
      .replace(/\n+$/u, '')}\n`
    const flat = normalized(screen)
    if (!flat.includes(`${destinationProfile}: new session with`))
      throw new Error(`destination profile scope is missing\n${screen}`)
    if (columns >= 80 && !flat.includes(`profile: ${sourceProfile} → ${destinationProfile}`))
      throw new Error(`destination profile is missing from the preview\n${screen}`)
    const events = [...terminal.events]
    await terminal.close()
    return {
      screen,
      cast: castFor(terminal, events, `Braid profile fork preview ${columns}x${rows}`),
    }
  } finally {
    await terminal.dispose()
    await rm(workspace, { force: true, recursive: true })
  }
}

/** Decline with Escape, cancel with Left, accept with Enter, then run two turns on the new branch. */
async function captureKeyboardFlow(binary) {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-profile-fork-keyboard-'))
  const terminal = await spawnTerminal(binary, 80, 24, workspace)
  try {
    await prepareSource(terminal)
    for (const [key, label] of [
      ['\u001b', 'escape declines'],
      ['\u001b[D', 'left cancels'],
    ]) {
      await openProfileFork(terminal)
      await sleep(400)
      terminal.input(key)
      await waitForScreen(terminal, (screen) => !screen.includes('fork preview'), label)
      await terminal.stable(label)
      if (normalized(terminal.screen()).includes(`${destinationProfile} answered`))
        throw new Error(`${label} created a destination run`)
    }
    await openProfileFork(terminal)
    await sleep(400)
    terminal.input('\r')
    await waitForScreen(terminal, (screen) => !screen.includes('fork preview'), 'accepted fork')
    await terminal.stable('accepted fork')
    await submit(terminal, 'Check the copied context', 'first destination turn')
    await waitForScreen(
      terminal,
      (screen) => screen.includes(`${destinationProfile} answered with`),
      'destination profile answers with copied context',
    )
    await submit(terminal, 'Continue the review', 'second destination turn')
    await waitForScreen(
      terminal,
      (screen) => screen.includes(`${destinationProfile} answered: Continue the review`),
      'bound profile answers a later turn',
    )
    await terminal.stable('bound branch')
    await sleep(800)
    const events = [...terminal.events]
    await terminal.close()
    return castFor(terminal, events, 'Braid profile fork keyboard flow')
  } finally {
    await terminal.dispose()
    await rm(workspace, { force: true, recursive: true })
  }
}

const packed = await installPackedBraid(repository)
const artifactFor = createArtifactFor(outputRoot, sha256)
try {
  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(rawRoot, { recursive: true })
  const artifacts = []
  for (const [columns, rows] of sizes) {
    const frame = await captureFrame(packed.binary, columns, rows)
    const name = `${columns}x${rows}`
    const textPath = join(outputRoot, `${name}.txt`)
    const castPath = join(rawRoot, `${name}.cast`)
    const pngPath = join(outputRoot, `${name}.png`)
    const temporaryGif = join(rawRoot, `${name}.gif`)
    await writeFile(textPath, frame.screen)
    await writeFile(castPath, frame.cast)
    await writeRaster(castPath, pngPath, temporaryGif)
    artifacts.push(await artifactFor(textPath, 'terminal-frame', columns, rows))
    artifacts.push(await artifactFor(pngPath, 'png', columns, rows))
  }
  const keyboardCast = join(outputRoot, 'profile-fork-keyboard.cast')
  const keyboardGif = join(outputRoot, '80x24-profile-fork-keyboard.gif')
  await writeFile(keyboardCast, await captureKeyboardFlow(packed.binary))
  await writeCastGif(keyboardCast, keyboardGif)
  artifacts.push(await artifactFor(keyboardCast, 'keyboard-asciicast', 80, 24))
  artifacts.push(await artifactFor(keyboardGif, 'keyboard-flow', 80, 24))
  await rm(rawRoot, { force: true, recursive: true })
  const manifestPath = join(outputRoot, 'capture-manifest.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        command: 'pnpm capture:profile-fork',
        binary: 'clean npm install from generated tarball',
        binarySha256: await sha256(packed.binary),
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        terminal: 'node-pty/xterm-256color',
        provenance: await captureProvenance(),
        scope:
          'Profile-changing fork UI over the offline profile-handoff fixture; the fixture transfer is not provider evidence',
        flow: [
          'select the fixture connection and record one source turn',
          '/fork --profile "Review engineer" opens the preview with both profile names and the copied context',
          'Escape declines and Left cancels without creating a run',
          'Enter accepts the handoff',
          'the first destination turn reports the copied messages under Review engineer',
          'a later turn on the new branch still runs under Review engineer',
        ],
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `Wrote ${artifacts.length} packed profile fork artifacts to ${relative(repository, outputRoot)}\n`,
  )
} finally {
  await packed.cleanup()
}
