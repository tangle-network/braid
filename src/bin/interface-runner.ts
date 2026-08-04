import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { assertNoSymlinkPath, writePrivateFile } from '../adapters/persistence/safe-file.js'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import type { ProfileConnectionDispatchOptions } from '../adapters/tui/profile-connection-dispatch.js'
import type { BraidApplication } from '../app/application.js'
import type { ProductionCompositionConfig } from '../app/production-composition.js'
import {
  BraidTerminalApp,
  createApplicationUiController,
  createBraidTheme,
  ProcessTerminal,
  TUI,
} from '../startup/terminal-runtime.js'
import { runRpc } from '../views/headless/rpc.js'
import {
  type CommandName,
  commandIntent,
  isMutatingCommand,
} from '../views/shared/command-registry.js'
import type { BraidIntent, BraidUiController } from '../views/shared/intents.js'
import type { CliOptions } from './args.js'
import { runPlain } from './plain.js'
import { productionConfigForSelection } from './production-application.js'
import {
  describeProductionSelection,
  type ProductionStartupSetup,
  transitionProductionSelection,
} from './production-setup.js'
import type { ProductionApplicationSlot } from './production-setup-transition.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

interface InterfaceRunnerInput {
  readonly options: CliOptions
  readonly workspace: string
  readonly active: ProductionApplicationSlot
  readonly setup?: ProductionStartupSetup
  readonly startupOptions?: ProductionStartupLoadOptions
  readonly profileConnectionOptions?: ProfileConnectionDispatchOptions
  readonly openConfiguredApplication: (
    options: ProductionStartupLoadOptions,
    production: ProductionCompositionConfig,
  ) => Promise<{ readonly app: BraidApplication; readonly close: () => Promise<void> }>
}

type TerminalConfiguration = NonNullable<
  ConstructorParameters<typeof BraidTerminalApp>[0]['configuration']
>

async function recordState(
  path: string,
  controller: BraidUiController,
  capturePhase: 'final' | 'atomic-signal-frame' = 'final',
): Promise<void> {
  const target = resolve(path)
  const directory = dirname(target)
  const payload = `${JSON.stringify({ schemaVersion: 2, capturePhase, state: controller.state(), view: controller.view(), events: controller.events() }, null, 2)}\n`
  assertNoSymlinkPath(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkPath(directory)
  writePrivateFile(target, payload)
}

export async function runInterface(input: InterfaceRunnerInput): Promise<number> {
  const { options, workspace, active, setup, startupOptions } = input
  const controller = createApplicationUiController(
    active.current.app,
    {
      color:
        options.plain || options.noColor || process.env.NO_COLOR !== undefined
          ? 'none'
          : 'truecolor',
      highContrast: options.highContrast,
      reducedMotion: options.reducedMotion,
    },
    options.uiFixture,
    input.profileConnectionOptions,
  )

  let verification = setup?.verification
  const configuration: TerminalConfiguration | undefined =
    setup === undefined || startupOptions === undefined
      ? undefined
      : {
          profiles: setup.profiles,
          connections: setup.connections,
          ...(setup.initialProfileId === undefined
            ? {}
            : { initialProfileId: setup.initialProfileId }),
          diagnostics: setup.diagnostics,
          openOnStart: true,
          confirmation: (selection) =>
            describeProductionSelection(selection, workspace, verification),
          onCommit: async (selection) => {
            verification = await transitionProductionSelection({
              setup,
              startupOptions,
              selection,
              workspace,
              controller,
              active,
              openApplication: (selection, selectedOptions) =>
                input.openConfiguredApplication(
                  selectedOptions,
                  productionConfigForSelection(selection, selectedOptions),
                ),
            })
          },
        }

  let operation = 0
  const nextOperationId = options.fixture
    ? () => `op-terminal-${String(++operation).padStart(6, '0')}`
    : () => `op-${randomUUID()}`
  const startupIntents = (): BraidIntent[] => {
    const commands: Array<[CommandName, string | undefined]> = [['open', options.conversation]]
    // Production profile, connection, runner, and model values are resolved before the
    // application is constructed; replaying them as UI commands would select a second path.
    if (options.fixture) {
      commands.push(
        ['profile', options.profile],
        ['connection', options.connection],
        ['runner', options.runner],
        ['model', options.model],
        ['effort', options.effort],
      )
    }
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
    ...(configuration === undefined ? {} : { configuration }),
    startupMessages,
  })
  let signalExitCode: number | undefined
  let signalSnapshot: Promise<void> | undefined
  let frameSnapshot: Promise<void> | undefined
  let signalCleanup: Promise<void> | undefined
  const shutdownMode =
    process.env.BRAID_SHUTDOWN_MODE === 'detach' ? ('detach' as const) : ('cancel' as const)
  const configuredDeadline = Number(process.env.BRAID_SHUTDOWN_DEADLINE_MS ?? 5_000)
  const shutdownDeadlineMs = Number.isInteger(configuredDeadline)
    ? Math.min(30_000, Math.max(250, configuredDeadline))
    : 5_000
  const stopFromSignal = (exitCode: number) => {
    signalExitCode ??= exitCode
    if (process.env.BRAID_CAPTURE_STATE_BEFORE_CANCEL === '1' && options.recordState) {
      signalSnapshot ??= recordState(`${options.recordState}.signal`, controller)
    }
    signalCleanup ??= (async () => {
      const cleanup = controller
        .dispatch({ type: 'shutdown', operationId: nextOperationId(), mode: shutdownMode })
        .then(async (result) => {
          if (result.kind === 'accepted' && result.completion) await result.completion
        })
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          cleanup,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              active.current.app.markCleanupUncertain(`Shutdown exceeded ${shutdownDeadlineMs} ms`)
              resolve()
            }, shutdownDeadlineMs)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
        view.stop()
      }
    })()
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
    await active.current.app.waitForIdle()
  } finally {
    await signalCleanup
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
