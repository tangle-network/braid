import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { visibleWidth } from '@earendil-works/pi-tui'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import {
  captureProvenance,
  createArtifactFor,
  writeCastGif,
  writeRaster,
} from './capture-visual-support.mjs'
import { nativeInstallEnvironment } from './native-install-environment.mjs'
import { installPackedBraid } from './packed-binary.mjs'
import { npmInvocation } from './release/platform.mjs'

const run = promisify(execFile)
const repository = new URL('../', import.meta.url).pathname
const outputRoot = join(repository, 'artifacts', 'verification', 'workspace-request')
const rawRoot = join(outputRoot, 'raw')
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]
const XtermTerminal = xterm.Terminal

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label, diagnostic, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}${diagnostic ? `\n${diagnostic()}` : ''}`)
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
    command: 'packed braid workspace request setup',
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

async function startBridge() {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const body =
      path === '/health'
        ? { status: 'ok', backends: [{ name: 'pi', state: 'ready' }] }
        : path === '/v1/models'
          ? { data: [{ id: 'pi/openai/gpt-5', backend: 'pi' }] }
          : { error: 'not found' }
    response.statusCode = path === '/health' || path === '/v1/models' ? 200 : 404
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve))
    throw new Error('Workspace capture bridge did not receive a TCP address')
  }
  return { server, endpoint: `http://127.0.0.1:${address.port}` }
}

async function createFixture(root) {
  const workspace = join(root, 'workspace')
  const profileDirectory = join(workspace, '.braid')
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 })
  await writeFile(
    join(profileDirectory, 'profile.json'),
    `${JSON.stringify({
      name: 'Workspace request capture',
      description: 'Packed setup flow proof',
      harness: 'pi',
      model: { default: 'openai/gpt-5' },
    })}\n`,
    { mode: 0o600 },
  )
  return workspace
}

async function spawnTerminal(binary, columns, rows, root, endpoint) {
  const workspace = await createFixture(root)
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
    BRAID_CLI_BRIDGE_ENDPOINT: endpoint,
    BRAID_DISCOVERY_TIMEOUT_MS: '1000',
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CONFIG_HOME: join(root, 'config'),
  }
  delete environment.NO_COLOR
  delete environment.FORCE_COLOR
  const session = pty.spawn(
    process.execPath,
    [binary, '--workspace', workspace, '--profile', '.braid/profile.json'],
    {
      name: 'xterm-256color',
      cols: columns,
      rows,
      cwd: workspace,
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
  const stable = (label) =>
    waitFor(
      () => pendingWrites === 0 && performance.now() - lastOutputAt >= 75,
      `${columns}x${rows} ${label}`,
      () => screen,
    )
  const waitForScreen = (predicate, label) =>
    waitFor(
      () => predicate(normalized(screen)),
      label,
      () => screen,
    )
  const close = async () => {
    if (exited) return
    for (let index = 0; index < 6; index += 1) {
      const visible = normalized(screen)
      if (
        !visible.includes('braid setup') &&
        !visible.includes('workspace · cloud sandbox') &&
        !visible.includes('credential ·')
      )
        break
      input('\u001b')
      await sleep(150)
      await stable(`close layer ${index + 1}`)
    }
    input('\u0003')
    await waitFor(
      () => normalized(screen).toLowerCase().includes('ctrl+c again to quit'),
      'safe exit prompt',
      () => screen,
    )
    input('\u0003')
    const result = await Promise.race([
      exit,
      sleep(5_000).then(() => {
        throw new Error('Workspace request capture did not exit')
      }),
    ])
    if (result.exitCode !== 0)
      throw new Error(`Workspace request capture exited ${result.exitCode}`)
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
    output: () => output,
    screen: () => screen,
    stable,
    waitForScreen,
    close,
    dispose,
  }
}

async function reachWorkspace(terminal) {
  try {
    await terminal.waitForScreen(
      (screen) => screen.includes('choose an AgentProfile'),
      'profile selection',
    )
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${terminal.output()}`,
    )
  }
  terminal.input('\r')
  await terminal.waitForScreen(
    (screen) => screen.includes('choose a connection'),
    'connection selection',
  )
  terminal.input('\u001b[B')
  terminal.input('\u001b[B')
  terminal.input('\r')
  await terminal.waitForScreen(
    (screen) => screen.includes('workspace · cloud sandbox'),
    'workspace form',
  )
}

async function fillWorkspace(terminal) {
  terminal.input('https://github.com/tangle-network/braid')
  terminal.input('\t')
  terminal.input('main')
  terminal.input('\t')
  terminal.input('src')
  await terminal.stable('filled workspace form')
}

function cleanFrame(screen) {
  return `${screen.replace(/[ \t]+$/gmu, '').replace(/\n+$/u, '')}\n`
}

async function captureFrame(binary, columns, rows, endpoint) {
  const root = await mkdtemp(join(tmpdir(), `braid-workspace-request-${columns}x${rows}-`))
  const terminal = await spawnTerminal(binary, columns, rows, root, endpoint)
  try {
    await reachWorkspace(terminal)
    await fillWorkspace(terminal)
    const screen = cleanFrame(terminal.screen())
    const events = [...terminal.events]
    await terminal.close()
    return {
      terminal,
      screen,
      events,
      cast: castFor(terminal, events, `Braid workspace request ${columns}x${rows}`),
    }
  } finally {
    await terminal.dispose()
    await rm(root, { force: true, recursive: true })
  }
}

async function captureKeyboardFlow(binary, endpoint) {
  const root = await mkdtemp(join(tmpdir(), 'braid-workspace-request-keyboard-'))
  const terminal = await spawnTerminal(binary, 80, 24, root, endpoint)
  try {
    await reachWorkspace(terminal)
    terminal.input('\t')
    terminal.input('main')
    terminal.input('\t')
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) => screen.includes('gitRef requires repoUrl'),
      'bounded invalid git ref message',
    )
    const invalidFrame = terminal.screen().split('\n')
    if (invalidFrame.some((line) => visibleWidth(line) > 80))
      throw new Error('Workspace validation error exceeded the terminal width')
    terminal.input('\u001b[9;2u')
    await sleep(100)
    terminal.input('https://github.com/tangle-network/braid')
    terminal.input('\t')
    terminal.input('\t')
    terminal.input('src')
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) =>
        screen.includes('review and start') && screen.includes('github.com/tangle-network/braid'),
      'workspace review',
    )
    terminal.input('\u001b[B')
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) => screen.includes('github.com/tangle-network/braid') && screen.includes('main'),
      'workspace edits after review back',
    )
    terminal.input('\u001b[9;2u')
    await terminal.waitForScreen(
      (screen) => screen.includes('choose a connection'),
      'connection back',
    )
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) =>
        screen.includes('workspace · cloud sandbox') &&
        screen.includes('github.com/tangle-network/braid'),
      'workspace edits after connection back',
    )
    await terminal.stable('keyboard walkthrough')
    const events = [...terminal.events]
    await terminal.close()
    return {
      events,
      steps: [
        'open cloud workspace step',
        'submit git ref without repository',
        'shift-tab to repository and enter URL',
        'submit and review effective values',
        'back to workspace with edits intact',
        'shift-tab to connection and return with edits intact',
      ],
      cast: castFor(terminal, events, 'Braid workspace request keyboard flow'),
    }
  } finally {
    await terminal.dispose()
    await rm(root, { force: true, recursive: true })
  }
}

const packed = await installPackedBraid(repository)
const sdkTarball = process.env.BRAID_AGENT_INTERFACE_TARBALL
if (sdkTarball !== undefined) {
  const npm = npmInvocation([
    'install',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--legacy-peer-deps',
    sdkTarball,
  ])
  await run(npm.file, npm.args, {
    cwd: packed.installRoot,
    env: nativeInstallEnvironment(),
  })
  const nestedSdk = join(
    packed.installRoot,
    'node_modules',
    '@tangle-network',
    'braid',
    'node_modules',
    '@tangle-network',
    'agent-interface',
  )
  await rm(nestedSdk, { force: true, recursive: true })
  await mkdir(dirname(nestedSdk), { recursive: true })
  await symlink(
    join(packed.installRoot, 'node_modules', '@tangle-network', 'agent-interface'),
    nestedSdk,
  )
}
const bridge = await startBridge()
const artifactFor = createArtifactFor(outputRoot, sha256)
try {
  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(rawRoot, { recursive: true })
  const artifacts = []
  for (const [columns, rows] of sizes) {
    const frame = await captureFrame(packed.binary, columns, rows, bridge.endpoint)
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
  const keyboard = await captureKeyboardFlow(packed.binary, bridge.endpoint)
  const keyboardCast = join(rawRoot, 'workspace-request-keyboard.cast')
  const keyboardGif = join(outputRoot, '80x24-workspace-request-keyboard.gif')
  await writeFile(keyboardCast, keyboard.cast)
  await writeCastGif(keyboardCast, keyboardGif)
  artifacts.push(await artifactFor(keyboardCast, 'keyboard-asciicast', 80, 24))
  artifacts.push(await artifactFor(keyboardGif, 'keyboard-flow', 80, 24))
  const manifestPath = join(outputRoot, 'capture-manifest.json')
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        command: 'pnpm capture:workspace',
        binary: 'clean npm install from generated tarball',
        binarySha256: await sha256(packed.binary),
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        terminal: 'node-pty/xterm-256color',
        provenance: await captureProvenance(),
        flow: keyboard.steps,
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `Wrote ${artifacts.length} packed workspace request UI artifacts to ${relative(repository, outputRoot)}\n`,
  )
} finally {
  await new Promise((resolve) => bridge.server.close(resolve))
  await packed.cleanup()
}
