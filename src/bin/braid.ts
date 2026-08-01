#!/usr/bin/env node

import { constants } from 'node:fs'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProcessTerminal, TUI } from '@earendil-works/pi-tui'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import { createBraidApplication } from '../app/composition.js'
import { runRpc } from '../views/headless/rpc.js'
import { BraidTerminalApp } from '../views/tui/terminal-app.js'
import { createBraidTheme } from '../views/tui/theme.js'
import { BRAID_VERSION } from '../version.js'
import { HELP, parseArgs, type CliOptions } from './args.js'

async function recordState(
  path: string,
  app: ReturnType<typeof createBraidApplication>,
): Promise<void> {
  const target = resolve(path)
  const temporary = `${target}.${randomUUID()}.tmp`
  await mkdir(dirname(target), { recursive: true })
  let file: FileHandle | undefined = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(
      `${JSON.stringify({ schemaVersion: 1, state: app.state(), events: app.events() }, null, 2)}\n`,
    )
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, target)
  } finally {
    await file?.close().catch(() => {})
    await rm(temporary, { force: true })
  }
}

async function main(): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2), process.cwd())
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.version) {
    process.stdout.write(`${BRAID_VERSION}\n`)
    return 0
  }

  const app = createBraidApplication({
    ...(options.fixture ? { fixture: options.fixture, chunkDelayMs: 12 } : {}),
  })

  if (options.mode === 'rpc') {
    const exitCode = await runRpc(app, process.stdin, process.stdout)
    if (options.recordState) await recordState(options.recordState, app)
    return exitCode
  }

  app.initialize(resolve(options.workspace))
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('Interactive mode requires a terminal; use `braid rpc` for JSONL.\n')
    return 2
  }

  const terminal = options.inline ? new ProcessTerminal() : new AlternateScreenTerminal()
  const tui = new TUI(terminal)
  const colors = !options.noColor && process.env.NO_COLOR === undefined
  let operation = 0
  const nextOperationId = options.fixture
    ? () => `op-terminal-${String(++operation).padStart(6, '0')}`
    : () => `op-${randomUUID()}`
  const view = new BraidTerminalApp({
    app,
    tui,
    theme: createBraidTheme(colors),
    workspace: resolve(options.workspace),
    nextOperationId,
  })
  let signalExitCode: number | undefined
  const stopFromSignal = (exitCode: number) => {
    signalExitCode ??= exitCode
    app.cancelActive()
    view.stop()
  }
  const onInterrupt = () => stopFromSignal(130)
  const onTerminate = () => stopFromSignal(143)
  const onHangup = () => stopFromSignal(129)
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  process.once('SIGHUP', onHangup)
  try {
    await view.start()
    await app.waitForIdle()
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    process.off('SIGHUP', onHangup)
    view.stop()
  }
  if (options.recordState) await recordState(options.recordState, app)
  return signalExitCode ?? 0
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  })
