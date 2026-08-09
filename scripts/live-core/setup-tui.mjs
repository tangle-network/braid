import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as pty from 'node-pty'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(getOutput, text, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (!getOutput().includes(text)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}; output:\n${getOutput()}`)
    await sleep(25)
  }
}

async function waitForFile(path, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for ${label}: ${error instanceof Error ? error.message : String(error)}`,
        )
      await sleep(25)
    }
  }
}

async function waitForSelection(getOutput, start, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const current = getOutput().slice(start)
    if (current.includes('selection applied')) return
    const applying = current.indexOf('applying selection')
    const retry = applying < 0 ? -1 : current.indexOf('→ Apply and start', applying)
    if (retry >= 0) {
      throw new Error(`Selection activation failed; output:\n${current.slice(applying)}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for selection activation; output:\n${getOutput()}`)
    }
    await sleep(25)
  }
}

export async function configureWithPublicTui(binary, workspace, keyFile, endpoint, runner, model) {
  const output = { value: '' }
  const session = pty.spawn(
    process.execPath,
    [
      binary,
      '--workspace',
      workspace,
      '--no-color',
      '--database-key-file',
      keyFile,
      '--runner',
      runner,
      '--model',
      model,
    ],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 36,
      cwd: workspace,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_CLI_BRIDGE_ENDPOINT: endpoint,
        BRAID_MODEL_VALIDATION_TIMEOUT_MS: '120000',
        BRAID_STATE_PATH: `${keyFile}.state.sqlite`,
        XDG_DATA_HOME: `${keyFile}.data`,
        XDG_CONFIG_HOME: `${keyFile}.config`,
      },
    },
  )
  let exited = false
  const exit = new Promise((resolve) =>
    session.onExit((value) => {
      exited = true
      resolve(value)
    }),
  )
  session.onData((chunk) => {
    output.value += chunk
  })
  try {
    await waitFor(() => output.value, 'braid setup', 'setup heading')
    await sleep(50)
    session.write('\r')
    await waitFor(() => output.value, 'choose a connection', 'connection selector')
    await sleep(50)
    session.write('\r')
    await waitFor(() => output.value, 'review and start', 'confirmation')
    for (const field of [
      'runner:',
      'model:',
      'effort:',
      'workdir:',
      'verification:',
      'unsupported:',
    ]) {
      assert.ok(output.value.includes(field), `setup confirmation omitted ${field}`)
    }
    await sleep(50)
    const activationOutputStart = output.value.length
    session.write('\r')
    await waitForSelection(() => output.value, activationOutputStart)
    await waitFor(() => output.value, '→ Close', 'selection close action')
    const config = await waitForFile(`${workspace}/.braid/config.json`, 'persisted setup config')
    await sleep(50)
    session.write('\r')
    await sleep(250)
    session.write('\u0003')
    await waitFor(() => output.value, 'ctrl+c again to quit', 'safe exit prompt', 15_000)
    session.write('\u0003')
    const result = await Promise.race([
      exit,
      sleep(15_000).then(() => {
        session.kill()
        throw new Error('TUI did not exit')
      }),
    ])
    assert.equal(result.exitCode, 0, `TUI exited ${result.exitCode}`)
    return { output: output.value, config }
  } finally {
    if (!exited) session.kill()
  }
}
