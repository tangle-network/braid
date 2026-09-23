#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { ProcessTerminal, TUI } from '@earendil-works/pi-tui'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import { createBraidApplication } from '../app/composition.js'
import { runW11EvaluationCommand, type W11EvaluationCliOptions } from '../evaluation/cli.js'
import { sanitizeDiagnosticText } from '../analysis/diagnostics.js'
import { EnvironmentStateKeyPort } from '../analysis/service.js'
import { BRAID_VERSION } from '../version.js'
import { runRpc } from '../views/headless/rpc.js'
import { BraidTerminalApp } from '../views/tui/terminal-app.js'
import { createBraidTheme } from '../views/tui/theme.js'
import { type CliOptions, HELP, parseArgs } from './args.js'

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
    process.stderr.write(
      `${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}\n\n${HELP}`,
    )
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

  if (options.mode === 'eval') {
    const required = (value: string | undefined, name: string): string => {
      if (!value) throw new Error(`eval requires ${name}`)
      return value
    }
    return runW11EvaluationCommand({
      traceFile: required(options.traceFile, '--trace-file'),
      sourceMetadata: required(options.sourceMetadata, '--source-metadata'),
      repository: options.repository ?? '.braid/analysis-state.enc',
      model: required(options.model, '--model'),
      baseUrl: options.baseUrl ?? 'https://router.tangle.tools/v1',
      operationId: options.operationId ?? `operation-${randomUUID()}`,
      evaluationInputs: required(options.evaluationInputs, '--evaluation-inputs'),
      workspace: options.workspace,
    } satisfies W11EvaluationCliOptions)
  }

  const app = createBraidApplication({
    ...(options.fixture ? { fixture: options.fixture, chunkDelayMs: 12 } : {}),
    ...(options.fixture && process.env.BRAID_STATE_KEY
      ? {
          analysisStatePath: resolve(options.workspace, '.braid', 'analysis-state.enc'),
          analysisKey: new EnvironmentStateKeyPort(),
        }
      : {}),
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
  return (
    signalExitCode ?? (view.commandFailed || app.state().runs.at(-1)?.status === 'failed' ? 1 : 0)
  )
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    process.stderr.write(
      `${sanitizeDiagnosticText(error instanceof Error ? error.message : String(error))}\n`,
    )
    process.exitCode = 1
  })
