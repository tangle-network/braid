import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { releaseTargetDefinitions } from './live-bridge/bridge.mjs'
import { assertPublicCapture } from './live-demo/public-safety.mjs'
import { liveDemoProfileForRoute, LIVE_DEMO_PROFILE } from './live-demo/workspace.mjs'

const COLUMNS = 160
const ROWS = 30
const CONNECTION_ID = 'connection-product-demo-cli-bridge'
const HUMAN_PROMPT =
  'Please inspect this workspace and tell me which command runs the test suite. Do not edit files.'
const execFileAsync = promisify(execFile)

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function rebaseEvents(events) {
  const offset = events[0]?.[0] ?? 0
  return events.map(([timestamp, direction, data]) => [
    Number((timestamp - offset + 0.01).toFixed(6)),
    direction,
    data,
  ])
}

async function typeText(terminal, value, delayMs = 20) {
  for (const character of value) {
    terminal.input(character)
    await pause(delayMs)
  }
}

async function localPiModelCredential(profile) {
  const executable = process.env.BRAID_PI_BIN ?? 'pi'
  const provider = profile.model.provider
  const model = profile.model.default
  for (const credentialKind of ['print-bearer-token', 'print-api-key']) {
    const args = ['auth', credentialKind]
    if (provider !== undefined) args.push('--provider', provider)
    args.push('--model', model)
    try {
      const result = await execFileAsync(executable, args, {
        encoding: 'utf8',
        env: process.env,
      })
      const token = result.stdout.trim()
      if (token.length === 0 || /\r|\n/u.test(token)) continue
      return token
    } catch {}
  }
  throw new Error(`The real product demo requires a usable local Pi ${model} credential`)
}

function demoEndpoint() {
  return (
    process.env.BRAID_PRODUCT_DEMO_ENDPOINT ??
    process.env.BRAID_LIVE_DEMO_ENDPOINT ??
    process.env.BRAID_CLI_BRIDGE_ENDPOINT ??
    'http://127.0.0.1:3345'
  )
}

function localEndpoint(value) {
  const endpoint = new URL(value)
  assert.equal(endpoint.protocol, 'http:', 'The product demo requires a local HTTP CLI Bridge')
  assert.ok(
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(endpoint.hostname),
    'The product demo refuses a non-loopback CLI Bridge',
  )
  assert.equal(endpoint.username, '', 'The product demo endpoint must not contain credentials')
  assert.equal(endpoint.password, '', 'The product demo endpoint must not contain credentials')
  assert.equal(endpoint.search, '', 'The product demo endpoint must not contain query data')
  assert.equal(endpoint.hash, '', 'The product demo endpoint must not contain a fragment')
  return endpoint.origin
}

function bridgeAuthorization() {
  const value =
    process.env.BRAID_CLI_BRIDGE_AUTH ??
    process.env.BRAID_CLI_BRIDGE_BEARER ??
    process.env.CLI_BRIDGE_BEARER
  if (value === undefined || value.trim().length === 0) return undefined
  return /^(?:Bearer|Basic)\s+/iu.test(value) ? value : `Bearer ${value}`
}

async function jsonRequest(url) {
  const authorization = bridgeAuthorization()
  const response = await fetch(url, {
    ...(authorization === undefined ? {} : { headers: { Authorization: authorization } }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`CLI Bridge request failed with HTTP ${response.status}`)
  return body
}

async function requirePiBridge(endpoint) {
  const [health, models] = await Promise.all([
    jsonRequest(`${endpoint}/health`),
    jsonRequest(`${endpoint}/v1/models`),
  ])
  const readyPi = health.backends?.find(
    (backend) => backend?.name === 'pi' && backend?.state === 'ready',
  )
  assert.equal(health.status, 'ok', 'CLI Bridge is not healthy')
  assert.ok(readyPi, 'CLI Bridge does not report a ready Pi backend')
  const [target] = releaseTargetDefinitions(
    [],
    { ok: true, body: models },
    { body: health },
  ).filter((candidate) => candidate.backend === LIVE_DEMO_PROFILE.harness)
  assert.ok(target, 'CLI Bridge does not advertise a ready Pi model')
  return { health, target }
}

async function createProductionDemoWorkspace(root, endpoint, profile) {
  const workspace = join(root, 'agent-sdk')
  const configDirectory = join(workspace, '.braid')
  const configPath = join(configDirectory, 'config.json')
  const keyPath = join(root, 'database.key')
  const now = new Date().toISOString()
  await mkdir(configDirectory, { recursive: true, mode: 0o700 })
  await writeFile(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 })
  await chmod(keyPath, 0o600)
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        format: 'braid-startup-config',
        schemaVersion: 2,
        profile,
        connectionId: CONNECTION_ID,
        databaseKeyFile: keyPath,
        connections: [
          {
            id: CONNECTION_ID,
            kind: 'cli-bridge',
            name: 'Local CLI Bridge',
            endpoint,
            providerOptions: { transport: 'local' },
            createdAt: now,
            updatedAt: now,
            lastHealth: { status: 'healthy', checkedAt: now },
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

async function waitForCompletedRun(terminal) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const screen = terminal.screen().replace(/\s+/gu, ' ').trim()
    if (screen.includes('failed') || screen.includes('outcome unknown')) {
      throw new Error(`The real product demo run did not complete: ${screen}`)
    }
    if (!screen.includes('working') && !screen.includes('Ctrl+C cancel')) {
      const captured = await terminal.captureState()
      const run = captured.record.state?.runs?.at(-1)
      if (run?.status === 'completed') return captured
    }
    await pause(250)
  }
  throw new Error('Timed out waiting for the real Pi product demo run')
}

export async function captureProductDemo({ spawnTerminal, normalized, castFor }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'braid-product-demo-'))
  const endpoint = localEndpoint(demoEndpoint())
  const { target } = await requirePiBridge(endpoint)
  const route = target.modelId
  const profile = liveDemoProfileForRoute(route)
  const modelCredential = await localPiModelCredential(profile)
  const setup = await createProductionDemoWorkspace(temporaryRoot, endpoint, profile)
  const terminal = await spawnTerminal(
    'product-demo',
    COLUMNS,
    ROWS,
    {
      BRAID_CLI_BRIDGE_ENDPOINT: endpoint,
      BRAID_MODEL_VALIDATION_TIMEOUT_MS: '120000',
      BRAID_STATE_PATH: join(temporaryRoot, 'state.sqlite'),
      BRAID_CLI_BRIDGE_MODEL_TOKEN: modelCredential,
      ...(profile.model.provider === 'openai-codex'
        ? { BRAID_CLI_BRIDGE_MODEL_BASE_URL: 'https://chatgpt.com/backend-api' }
        : {}),
      NODE_NO_WARNINGS: '1',
      XDG_CONFIG_HOME: join(temporaryRoot, 'config'),
      XDG_DATA_HOME: join(temporaryRoot, 'data'),
    },
    undefined,
    [
      '--workspace',
      setup.workspace,
      '--config',
      setup.configPath,
      '--database-key-file',
      setup.keyPath,
    ],
    { fixture: false },
  )
  try {
    await terminal.waitForInterface()
    await terminal.waitFor(
      () => {
        const screen = normalized(terminal.screen())
        return (
          screen.includes(profile.name) &&
          screen.includes(`pi / ${profile.model.default}`) &&
          screen.includes('CLI Bridge') &&
          screen.includes('high')
        )
      },
      'real Pi product configuration',
      120_000,
    )
    await pause(700)

    const demoStartIndex = terminal.events.length
    await typeText(terminal, '/profile', 24)
    terminal.input('\r')
    await terminal.waitFor(
      () => {
        const screen = normalized(terminal.screen())
        return (
          screen.includes(profile.name) &&
          screen.includes(`runner pi · model ${profile.model.default}`) &&
          screen.includes('thinking high')
        )
      },
      'AgentProfile panel',
      30_000,
    )
    await pause(700)
    terminal.input('\u001b')
    await terminal.waitFor(
      () => !normalized(terminal.screen()).includes(`runner pi · model ${profile.model.default}`),
      'AgentProfile panel close',
    )
    await pause(350)

    await typeText(terminal, HUMAN_PROMPT, 18)
    terminal.input('\r')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes('working'),
      'real Pi active run',
      30_000,
    )
    const completed = await waitForCompletedRun(terminal)
    await terminal.waitForStable('real product screenshot')
    const screenshot = completed.point
    const demo = terminal.snapshot()
    const frameCast = castFor(
      terminal,
      terminal.events.slice(0, screenshot.eventCount),
      'Braid product screenshot',
      `braid --runner pi --model ${route} --connection Local-CLI-Bridge`,
    )
    const demoCast = castFor(
      terminal,
      rebaseEvents(terminal.events.slice(demoStartIndex, demo.eventCount)),
      'Braid product demo',
      `braid --runner pi --model ${route} --connection Local-CLI-Bridge`,
    )
    const publicText = `${frameCast}\n${demoCast}\n${screenshot.screen}`
    assertPublicCapture(publicText)
    assert.doesNotMatch(publicText, /\b(?:fixture|deterministic|unknown|not reported)\b/iu)
    assert.match(screenshot.screen, new RegExp(HUMAN_PROMPT.slice(0, 24), 'u'))
    assert.match(screenshot.screen, new RegExp(profile.name, 'u'))
    assert.match(screenshot.screen, new RegExp(`pi / ${profile.model.default}`, 'u'))
    assert.match(screenshot.screen, /CLI Bridge/u)
    assert.match(screenshot.screen, /(?:in|out|\$|latency) \S+/u)
    await terminal.closeNormally()

    return {
      columns: COLUMNS,
      rows: ROWS,
      finalScreen: screenshot.screen,
      frameCast,
      demoCast,
      steps: [
        'Inspect the real Pi AgentProfile',
        'Send a human prompt through Local CLI Bridge',
        'Review observed model usage in the context rail',
      ],
    }
  } finally {
    await terminal.dispose()
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}
