import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import * as pty from 'node-pty'

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}

const LIVE_BRIDGE_ENDPOINT = process.env.BRAID_LIVE_BRIDGE_ENDPOINT ?? 'http://127.0.0.1:3344'
const LIVE_GLM_MODEL = 'opencode/zai-coding-plan/glm-5.2'
const LIVE_GLM_PORTABLE_MODEL = 'zai-coding-plan/glm-5.2'

async function readLiveJson(path) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(`${LIVE_BRIDGE_ENDPOINT}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`GET ${path} returned HTTP ${response.status}: ${body}`)
    return JSON.parse(body)
  } finally {
    clearTimeout(timeout)
  }
}

async function assertLiveGlmBridge() {
  const health = await readLiveJson('/health')
  assert.equal(health.status, 'ok', `live Bridge health is not ok: ${JSON.stringify(health)}`)
  assert.ok(
    Array.isArray(health.backends) &&
      health.backends.some((backend) => backend?.name === 'opencode' && backend?.state === 'ready'),
    `live Bridge has no ready opencode backend: ${JSON.stringify(health)}`,
  )
  const models = await readLiveJson('/v1/models')
  assert.ok(
    Array.isArray(models.data) && models.data.some((model) => model?.id === LIVE_GLM_MODEL),
    `live Bridge does not advertise ${LIVE_GLM_MODEL}: ${JSON.stringify(models)}`,
  )
}

export async function runPackedFirstRun(binary, repository) {
  const workspace = await mkdtemp(join(tmpdir(), 'braid-packed-first-run-'))
  const keyDirectory = await mkdtemp(join(tmpdir(), 'braid-packed-key-'))
  const keyPath = join(keyDirectory, 'database.key')
  const statePath = join(workspace, 'braid.sqlite')
  await writeFile(keyPath, Buffer.alloc(32, 7), { mode: 0o600 })
  await chmod(keyPath, 0o600)
  await assertLiveGlmBridge()
  const environment = {
    ...process.env,
    TERM: 'xterm-256color',
    NO_COLOR: '1',
    NODE_NO_WARNINGS: '1',
    BRAID_STATE_PATH: statePath,
    BRAID_CLI_BRIDGE_ENDPOINT: LIVE_BRIDGE_ENDPOINT,
    BRAID_MODEL_VALIDATION_TIMEOUT_MS: '120000',
  }
  delete environment.FORCE_COLOR

  async function runTui(args, expectedResponse, expectSetup, prompt) {
    const session = pty.spawn(process.execPath, [binary, ...args], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: repository,
      env: environment,
    })
    let output = ''
    const exited = new Promise((resolve) => session.onExit(resolve))
    session.onData((chunk) => {
      output += chunk
    })
    let completed = false
    try {
      await waitFor(
        () => output.includes('braid setup') || output.includes('Braid starter'),
        'packed TUI startup surface',
      )
      if (expectSetup) {
        await waitFor(() => output.includes('braid setup'), 'packed first-run setup')
        session.write('\r')
        await waitFor(() => output.includes('choose a connection'), 'packed profile selection')
        session.write('\r')
        await waitFor(() => output.includes('review and start'), 'packed setup confirmation')
        for (const value of [
          'runner:',
          'model:',
          'effort:',
          'workdir:',
          'verification:',
          'unsupported:',
        ]) {
          if (!output.includes(value))
            throw new Error(`packed confirmation omitted ${value}\n${output}`)
        }
        session.write('\r')
        try {
          await waitFor(
            () => output.includes('selection applied'),
            'packed in-process activation',
            120_000,
          )
        } catch (error) {
          throw new Error(`packed setup did not activate\n${output}`, { cause: error })
        }
        session.write('\r')
        await sleep(250)
      }
      const responseOffset = output.length
      session.write(`${prompt}\r`)
      try {
        await waitFor(
          () => {
            const replyOffset = output.indexOf(expectedResponse, responseOffset)
            if (replyOffset < 0) return false
            const completedOutput = output.slice(replyOffset + expectedResponse.length)
            return completedOutput.includes('Ctrl+E') || completedOutput.includes('Ctrl+P')
          },
          'packed real response',
          120_000,
        )
      } catch (error) {
        throw new Error(`packed response missing ${expectedResponse}\n${output}`, { cause: error })
      }
      session.write('\u0003')
      await waitFor(() => output.toLowerCase().includes('ctrl+c again to quit'), 'packed safe exit')
      session.write('\u0003')
      const exit = await Promise.race([
        exited,
        sleep(10_000).then(() => {
          session.kill()
          throw new Error('packed TUI did not exit')
        }),
      ])
      if (exit.exitCode !== 0) throw new Error(`packed TUI exited ${exit.exitCode}\n${output}`)
      completed = true
      return output
    } finally {
      if (!completed) session.kill()
    }
  }

  try {
    const firstPrompt =
      'Join these pieces without spaces and reply only with the result: BRAID_ + LIVE_ + GLM_OK'
    const restartPrompt =
      'Join these pieces without spaces and reply only with the result: BRAID_ + LIVE_ + GLM_ + RESTART_OK'
    const firstOutput = await runTui(
      [
        '--workspace',
        workspace,
        '--no-color',
        '--runner',
        'opencode',
        '--model',
        LIVE_GLM_MODEL,
        '--database-key-file',
        keyPath,
      ],
      'BRAID_LIVE_GLM_OK',
      true,
      firstPrompt,
    )
    const configPath = join(workspace, '.braid', 'config.json')
    const saved = JSON.parse(await readFile(configPath, 'utf8'))
    const savedProfile = saved.profile
    const savedConnection = saved.connections?.[0]
    if (savedProfile?.harness !== 'opencode')
      throw new Error(`packed setup saved the wrong runner\n${firstOutput}`)
    if (savedProfile?.model?.default !== LIVE_GLM_PORTABLE_MODEL)
      throw new Error(`packed setup did not persist the discovered model\n${JSON.stringify(saved)}`)
    if (savedConnection?.endpoint !== LIVE_BRIDGE_ENDPOINT)
      throw new Error(
        `packed setup did not persist the selected bridge endpoint\n${JSON.stringify(saved)}`,
      )
    if (saved.databaseKeyFile !== keyPath)
      throw new Error(
        `packed setup did not persist the external database key path\n${JSON.stringify(saved)}`,
      )
    if (/secret|token|api[_-]?key/iu.test(JSON.stringify(saved)))
      throw new Error(`packed setup persisted credential material\n${JSON.stringify(saved)}`)
    const configDirectory = join(workspace, '.braid')
    saved.databaseKeyFile = relative(configDirectory, keyPath)
    await writeFile(configPath, `${JSON.stringify(saved)}\n`, { mode: 0o600 })
    await runTui(
      ['--workspace', workspace, '--no-color'],
      'BRAID_LIVE_GLM_RESTART_OK',
      false,
      restartPrompt,
    )
    return { model: LIVE_GLM_MODEL, workspace }
  } finally {
    await Promise.all([
      rm(workspace, { force: true, recursive: true }),
      rm(keyDirectory, { force: true, recursive: true }),
    ])
  }
}
