#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProcessTerminal, TUI } from '@earendil-works/pi-tui'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import { createBraidApplication } from '../app/composition.js'
import { redactErrorMessage, redactProviderValue } from '../connection/redaction.js'
import { withFileLock } from '../persistence/file-lock.js'
import { readFileIdentity, replaceFileAtomically } from '../profile/profile-files.js'
import { ProfileSourceRegistry } from '../profile/profile-sources.js'
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
  const safe = redactProviderValue({ state: app.state(), events: app.events() })
  if (safe === null || typeof safe !== 'object' || Array.isArray(safe)) {
    throw new Error('Recorded state could not be represented as an object')
  }
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({ schemaVersion: 1, ...safe }, null, 2)}\n`,
  )
  await withFileLock(target, async () => {
    const current = await readFileIdentity(target)
    await replaceFileAtomically({
      path: target,
      bytes,
      mode: 0o600,
      expected: current?.identity,
    })
  })
}

async function main(): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2), process.cwd())
  } catch (error) {
    process.stderr.write(`${redactErrorMessage(error)}\n\n${HELP}`)
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

  const selectedProfileDocument =
    options.profile === undefined
      ? undefined
      : await new ProfileSourceRegistry().resolve(options.profile)
  const app = createBraidApplication({
    ...(options.fixture ? { fixture: options.fixture, chunkDelayMs: 12 } : {}),
    admissionStorageDirectory: join(resolve(options.workspace), '.braid'),
    ...(selectedProfileDocument === undefined
      ? {}
      : { profileDocument: selectedProfileDocument, profile: selectedProfileDocument.profile }),
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
    process.stderr.write(`${redactErrorMessage(error)}\n`)
    process.exitCode = 1
  })
