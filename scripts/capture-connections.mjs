import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const outputRoot = join(repository, 'artifacts', 'verification', 'connections')
const rawRoot = join(outputRoot, 'raw')
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]
const captureSecret = `connection-capture-${randomUUID()}`
const captureProfileName = 'Connection workflow proof'
const registeredConnectionName = 'Daytona capture'
const registeredEndpoint = 'https://daytona.invalid'
const registeredAccount = 'capture-team'
const registeredRegion = 'us'
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

function conversationShellReady(screen) {
  return screen.includes(captureProfileName) && screen.includes('new message')
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
    command: 'packed braid connection workflow',
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

async function createProductionFixture(root) {
  const workspace = join(root, 'workspace')
  const configDirectory = join(workspace, '.braid')
  const keyPath = join(root, 'database.key')
  const configPath = join(configDirectory, 'config.json')
  const now = '2026-08-09T00:00:00.000Z'
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  await writeFile(keyPath, Buffer.alloc(32, 29), { mode: 0o600 })
  await chmod(keyPath, 0o600)
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        format: 'braid-startup-config',
        schemaVersion: 2,
        profile: {
          name: captureProfileName,
          description: 'Packed terminal connection workflow proof',
          harness: 'pi',
          model: { default: 'openai/gpt-5' },
        },
        connectionId: 'connection-capture-local',
        databaseKeyFile: keyPath,
        connections: [
          {
            id: 'connection-capture-local',
            kind: 'cli-bridge',
            name: 'Local CLI Bridge',
            endpoint: 'http://127.0.0.1:3344',
            providerOptions: { transport: 'local' },
            createdAt: now,
            updatedAt: now,
            lastHealth: { status: 'unknown' },
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return { workspace, configPath, keyPath }
}

async function spawnTerminal(binary, columns, rows, root) {
  const fixture = await createProductionFixture(root)
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
    BRAID_STATE_PATH: join(root, 'state.sqlite'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CONFIG_HOME: join(root, 'config'),
  }
  delete environment.NO_COLOR
  delete environment.FORCE_COLOR
  const session = pty.spawn(
    process.execPath,
    [
      binary,
      '--workspace',
      fixture.workspace,
      '--config',
      fixture.configPath,
      '--database-key-file',
      fixture.keyPath,
    ],
    {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd: fixture.workspace,
      env: environment,
    },
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
  const sensitiveInput = (data) => session.write(data)
  const stable = (label) =>
    waitFor(
      () => pendingWrites === 0 && performance.now() - lastOutputAt >= 75,
      `${columns}x${rows} ${label}`,
      () => screen,
    )
  const close = async () => {
    if (exited) return
    for (let index = 0; index < 8; index += 1) {
      const before = normalized(screen)
      if (conversationShellReady(before)) break
      input('\u001b')
      await waitFor(
        () => conversationShellReady(normalized(screen)) || normalized(screen) !== before,
        'overlay close',
        () => screen,
        1_000,
      )
    }
    if (!conversationShellReady(normalized(screen)))
      throw new Error(
        `Packed connection capture could not return to the conversation shell\n${screen}`,
      )
    input('\u0003')
    await waitFor(
      () => normalized(screen).toLowerCase().includes('ctrl+c again to quit'),
      'safe exit',
      () => screen,
    )
    input('\u0003')
    const result = await Promise.race([
      exit,
      sleep(5_000).then(() => {
        throw new Error('Packed connection capture did not exit')
      }),
    ])
    if (result.exitCode !== 0)
      throw new Error(`Packed connection capture exited ${result.exitCode}`)
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
    sensitiveInput,
    screen: () => screen,
    output: () => output,
    stable,
    close,
    dispose,
  }
}

function waitForScreen(terminal, predicate, label) {
  return waitFor(
    () => predicate(normalized(terminal.screen())),
    label,
    () => terminal.screen(),
  )
}

async function reachConnectionReview(terminal, kind = 'tangle-inference') {
  await waitForScreen(terminal, conversationShellReady, 'Braid conversation shell')
  terminal.input('/connection create\r')
  await waitForScreen(
    terminal,
    (screen) => screen.includes('connection metadata'),
    'connection kind editor',
  )
  terminal.input(kind === 'agent-provider' ? '\u001b[A' : '\u001b[B')
  terminal.input('\r')
  await waitForScreen(
    terminal,
    (screen) =>
      screen.includes(
        kind === 'agent-provider' ? 'Registered provider metadata' : 'Tangle inference metadata',
      ),
    'connection fields',
  )
  if (kind === 'agent-provider') {
    terminal.input('daytona')
    terminal.input('\r')
    terminal.input('\u001b[F')
    terminal.input('\u0015')
    terminal.input(registeredConnectionName)
    terminal.input('\r')
    terminal.input(registeredEndpoint)
    terminal.input('\r')
    terminal.input(registeredAccount)
    terminal.input('\r')
    terminal.input(registeredRegion)
    terminal.input('\r')
  } else {
    for (let index = 0; index < 4; index += 1) terminal.input('\r')
  }
  await waitForScreen(terminal, (screen) => screen.includes('review connection'), 'review')
  if (kind === 'agent-provider') {
    await waitForScreen(
      terminal,
      (screen) => screen.includes('daytona') && screen.includes(registeredConnectionName),
      'reviewed registered provider identity',
    )
  }
  await terminal.stable('reviewed metadata frame')
}

async function reachCredentialPrompt(terminal, kind = 'tangle-inference') {
  await reachConnectionReview(terminal, kind)
  terminal.input('\r')
  const name = kind === 'agent-provider' ? registeredConnectionName : 'Tangle Inference'
  await waitForScreen(
    terminal,
    (screen) => screen.includes(`credential · ${name}`),
    'credential prompt',
  )
  terminal.sensitiveInput(captureSecret)
  await waitForScreen(terminal, (screen) => screen.includes('••••'), 'masked credential')
  await terminal.stable('masked credential frame')
}

async function captureFrame(binary, columns, rows, kind = 'tangle-inference') {
  const root = await mkdtemp(join(tmpdir(), `braid-connection-${columns}x${rows}-`))
  const terminal = await spawnTerminal(binary, columns, rows, root)
  try {
    if (kind === 'agent-provider') await reachConnectionReview(terminal, kind)
    else await reachCredentialPrompt(terminal, kind)
    const screen = `${terminal
      .screen()
      .replace(/[ \t]+$/gmu, '')
      .replace(/\n+$/u, '')}\n`
    const events = [...terminal.events]
    if (
      terminal.output().includes(captureSecret) ||
      JSON.stringify(events).includes(captureSecret)
    ) {
      throw new Error('Credential value entered a terminal artifact')
    }
    await terminal.close()
    return {
      terminal,
      screen,
      cast: castFor(terminal, events, `Braid ${kind} connections ${columns}x${rows}`),
    }
  } finally {
    await terminal.dispose()
    await rm(root, { force: true, recursive: true })
  }
}

async function captureKeyboardFlow(binary, kind = 'tangle-inference') {
  const root = await mkdtemp(join(tmpdir(), 'braid-connection-keyboard-'))
  const terminal = await spawnTerminal(binary, 80, 24, root)
  try {
    await reachCredentialPrompt(terminal, kind)
    await sleep(350)
    terminal.input('\r')
    await waitForScreen(
      terminal,
      (screen) => screen.includes('connections') && screen.includes('^D remove'),
      'created connection picker',
    )
    const createdConfig = JSON.parse(
      await readFile(join(root, 'workspace', '.braid', 'config.json'), 'utf8'),
    )
    if (kind === 'agent-provider') {
      const created = createdConfig.connections.find((connection) => connection.kind === kind)
      if (
        created?.name !== registeredConnectionName ||
        created.endpoint !== registeredEndpoint ||
        created.providerOptions?.provider !== 'daytona' ||
        created.providerOptions?.account !== registeredAccount ||
        created.providerOptions?.region !== registeredRegion
      )
        throw new Error('Registered connection metadata did not persist through keyboard creation')
    }
    if (JSON.stringify(createdConfig).includes(captureSecret))
      throw new Error('Credential value entered persisted connection metadata')
    terminal.input(kind === 'agent-provider' ? 'Daytona' : 'Tangle')
    await waitForScreen(
      terminal,
      (screen) =>
        screen.includes(kind === 'agent-provider' ? registeredConnectionName : 'Tangle Inference'),
      'created connection filter',
    )
    terminal.input('\u0004')
    await waitForScreen(
      terminal,
      (screen) => screen.includes('remove connection'),
      'removal confirmation',
    )
    await sleep(500)
    terminal.input('\r')
    await waitForScreen(
      terminal,
      (screen) => !screen.includes('remove connection'),
      'connection removal',
    )
    await terminal.stable('removed connection picker')
    const config = JSON.parse(
      await readFile(join(root, 'workspace', '.braid', 'config.json'), 'utf8'),
    )
    if (
      config.connections.length !== 1 ||
      config.connections[0]?.id !== 'connection-capture-local'
    ) {
      throw new Error('Keyboard flow did not persist connection removal')
    }
    if (
      terminal.output().includes(captureSecret) ||
      JSON.stringify(terminal.events).includes(captureSecret)
    ) {
      throw new Error('Credential value entered the keyboard recording')
    }
    const events = [...terminal.events]
    await terminal.close()
    return castFor(terminal, events, `Braid ${kind} create and remove connection keyboard flow`)
  } finally {
    await terminal.dispose()
    await rm(root, { force: true, recursive: true })
  }
}

const packed = await installPackedBraid(repository)
const artifactFor = createArtifactFor(outputRoot, sha256)
try {
  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(rawRoot, { recursive: true })
  const artifacts = []
  for (const kind of ['tangle-inference', 'agent-provider']) {
    const prefix = kind === 'agent-provider' ? 'registered-' : ''
    for (const [columns, rows] of sizes) {
      const frame = await captureFrame(packed.binary, columns, rows, kind)
      const name = `${prefix}${columns}x${rows}`
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
    const keyboardCast = join(rawRoot, `${prefix}connection-keyboard.cast`)
    const keyboardGif = join(outputRoot, `80x24-${prefix}connection-keyboard.gif`)
    await writeFile(keyboardCast, await captureKeyboardFlow(packed.binary, kind))
    await writeCastGif(keyboardCast, keyboardGif)
    artifacts.push(await artifactFor(keyboardCast, 'keyboard-asciicast', 80, 24))
    artifacts.push(await artifactFor(keyboardGif, 'keyboard-flow', 80, 24))
  }
  const manifestPath = join(outputRoot, 'capture-manifest.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        command: 'pnpm capture:connections',
        binary: 'clean npm install from generated tarball',
        binarySha256: await sha256(packed.binary),
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        terminal: 'node-pty/xterm-256color',
        provenance: await captureProvenance(),
        scope:
          'Connection metadata and credential UI only; no provider execution or cloud allocation',
        flow: [
          'open create',
          'choose Tangle inference or a registered Daytona provider',
          'review metadata',
          'enter masked credential',
          'create and verify persisted provider, endpoint, account and region metadata',
          'remove with confirmation',
        ],
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `Wrote ${artifacts.length} packed connection UI artifacts to ${relative(repository, outputRoot)}\n`,
  )
} finally {
  await packed.cleanup()
}
