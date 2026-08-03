#!/usr/bin/env node

import { constants } from 'node:fs'
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProcessTerminal, TUI } from '@earendil-works/pi-tui'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import { homedir } from 'node:os'
import type { BraidApplication } from '../app/application.js'
import { createBraidApplication, createDurableBraidApplication } from '../app/composition.js'
import { createApplicationUiController } from '../adapters/tui/application-ui-controller.js'
import { redactProviderError } from '../domain/redaction.js'
import type { BraidIntent, BraidUiController } from '../views/shared/intents.js'
import {
  commandIntent,
  isMutatingCommand,
  type CommandName,
} from '../views/shared/command-registry.js'
import { runPlain } from './plain.js'
import { runRpc } from '../views/headless/rpc.js'
import { BraidTerminalApp } from '../views/tui/terminal-app.js'
import { createBraidTheme } from '../views/tui/theme.js'
import { BRAID_VERSION } from '../version.js'
import { HELP, parseArgs, type CliOptions } from './args.js'

async function recordState(
  path: string,
  controller: BraidUiController,
  capturePhase: 'final' | 'atomic-signal-frame' = 'final',
): Promise<void> {
  const target = resolve(path)
  const temporary = `${target}.${randomUUID()}.tmp`
  const payload = `${JSON.stringify({ schemaVersion: 2, capturePhase, state: controller.state(), view: controller.view(), events: controller.events() }, null, 2)}\n`
  await mkdir(dirname(target), { recursive: true })
  let file: FileHandle | undefined = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await file.writeFile(payload)
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
    process.stderr.write(`${redactProviderError(error)}\n\n${HELP}`)
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

  const workspace = resolve(options.workspace)
  const { app, close } = await openApplication(options, workspace)
  try {
    return await run(options, workspace, app)
  } finally {
    await close()
  }
}

/**
 * The fixture surface runs entirely in memory so a capture is reproducible.
 * Every other run opens the encrypted SQLite journal, which owns durability,
 * so the process must release it before exiting.
 */
async function openApplication(
  options: CliOptions,
  workspace: string,
): Promise<{ readonly app: BraidApplication; readonly close: () => Promise<void> }> {
  if (options.fixture) {
    const configured = Number(process.env.BRAID_FIXTURE_CHUNK_DELAY_MS ?? 12)
    const app = createBraidApplication({
      fixture: options.fixture,
      chunkDelayMs: Number.isFinite(configured) && configured >= 0 ? configured : 12,
    })
    return { app, close: () => app.close() }
  }
  const { app, storage } = await createDurableBraidApplication({
    path:
      process.env.BRAID_STATE_PATH ?? join(homedir(), '.local', 'state', 'braid', 'braid.sqlite'),
    workspaceRoot: workspace,
  })
  return {
    app,
    close: () =>
      app.close().catch(async (error: unknown) => {
        await storage.close().catch(() => undefined)
        throw error
      }),
  }
}

async function run(options: CliOptions, workspace: string, app: BraidApplication): Promise<number> {
  const controller = createApplicationUiController(
    app,
    {
      color:
        options.plain || options.noColor || process.env.NO_COLOR !== undefined
          ? 'none'
          : 'truecolor',
      highContrast: options.highContrast,
      reducedMotion: options.reducedMotion,
    },
    options.uiFixture,
  )

  let operation = 0
  const nextOperationId = options.fixture
    ? () => `op-terminal-${String(++operation).padStart(6, '0')}`
    : () => `op-${randomUUID()}`
  const startupIntents = (): BraidIntent[] => {
    const commands: Array<[CommandName, string | undefined]> = [
      ['open', options.conversation],
      ['profile', options.profile],
      ['connection', options.connection],
      ['runner', options.runner],
      ['model', options.model],
      ['effort', options.effort],
    ]
    return commands.flatMap(([command, value]) => {
      if (!value) return []
      return [
        commandIntent(command, [value], isMutatingCommand(command) ? nextOperationId() : undefined),
      ]
    })
  }

  if (options.mode === 'rpc') {
    const exitCode = await runRpc(controller, process.stdin, process.stdout)
    if (options.recordState) await recordState(options.recordState, controller)
    return exitCode
  }

  if (options.plain) {
    const exitCode = await runPlain(controller, workspace, process.stdin, process.stdout, {
      initialIntents: startupIntents(),
    })
    if (options.recordState) await recordState(options.recordState, controller)
    return exitCode
  }

  const initialized = await controller.initialize(workspace)
  if (initialized.kind !== 'accepted') {
    process.stderr.write(
      `${initialized.kind === 'unavailable' ? initialized.reason : initialized.message}\n`,
    )
    return 2
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('Interactive mode requires a terminal; use `braid rpc` for JSONL.\n')
    return 2
  }

  const terminal = options.inline ? new ProcessTerminal() : new AlternateScreenTerminal()
  const tui = new TUI(terminal)
  const colors = !options.noColor && process.env.NO_COLOR === undefined
  const startupMessages: Array<{ readonly title: string; readonly reason: string }> = []
  for (const intent of startupIntents()) {
    const result = await controller.dispatch(intent)
    if (result.kind !== 'accepted') {
      startupMessages.push({
        title: intent.type === 'run-command' ? `/${intent.command}` : 'startup option',
        reason: result.kind === 'unavailable' ? result.reason : result.message,
      })
    }
  }
  const view = new BraidTerminalApp({
    controller,
    tui,
    theme: createBraidTheme({
      colors,
      highContrast: options.highContrast,
      reducedMotion: options.reducedMotion,
    }),
    workspace,
    nextOperationId,
    startupMessages,
  })
  let signalExitCode: number | undefined
  let signalSnapshot: Promise<void> | undefined
  let frameSnapshot: Promise<void> | undefined
  const stopFromSignal = (exitCode: number) => {
    signalExitCode ??= exitCode
    if (process.env.BRAID_CAPTURE_STATE_BEFORE_CANCEL === '1' && options.recordState) {
      signalSnapshot ??= recordState(`${options.recordState}.signal`, controller)
    }
    void controller.dispatch({ type: 'shutdown', operationId: nextOperationId() }).then(
      () => view.stop(),
      () => view.stop(),
    )
  }
  const onFrameSnapshot = () => {
    if (options.recordState)
      frameSnapshot ??= recordState(
        `${options.recordState}.frame`,
        controller,
        'atomic-signal-frame',
      )
  }
  const onInterrupt = () => stopFromSignal(130)
  const onTerminate = () => stopFromSignal(143)
  const onHangup = () => stopFromSignal(129)
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  process.once('SIGHUP', onHangup)
  process.once('SIGUSR2', onFrameSnapshot)
  try {
    await view.start()
    await app.waitForIdle()
  } finally {
    await signalSnapshot
    await frameSnapshot
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    process.off('SIGHUP', onHangup)
    process.off('SIGUSR2', onFrameSnapshot)
    view.stop()
  }
  if (options.recordState) await recordState(options.recordState, controller)
  return signalExitCode ?? 0
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    process.stderr.write(`${redactProviderError(error)}\n`)
    process.exitCode = 1
  })
