import { randomUUID } from 'node:crypto'
import { AlternateScreenTerminal } from '../adapters/tui/alternate-screen-terminal.js'
import type { ProfileConnectionDispatchOptions } from '../adapters/tui/profile-connection-dispatch.js'
import { ConnectionRegistry } from '../app/connections.js'
import type { ProductionCompositionConfig } from '../app/production-composition.js'
import type { StartupPreview } from '../startup/preview-runtime.js'
import {
  BraidTerminalApp,
  createApplicationUiController,
  createBraidTheme,
  ProcessTerminal,
  TuiMainScreen,
} from '../startup/terminal-runtime.js'
import { runRpc } from '../views/headless/rpc.js'
import {
  type CommandName,
  commandIntent,
  isMutatingCommand,
} from '../views/shared/command-registry.js'
import type { BraidIntent } from '../views/shared/intents.js'
import type { CliOptions } from './args.js'
import { createInterfaceSignalLifecycle } from './interface-signal-lifecycle.js'
import { recordInterfaceState } from './interface-state-recorder.js'
import { createNativeInteractiveUiActions } from './native-interactive-actions.js'
import { runPlain } from './plain.js'
import {
  activateProductionConnection,
  productionConfigForSelection,
} from './production-application.js'
import { ProductionConnectionActions } from './production-connection-actions.js'
import { productionConfigPath } from './production-key-path.js'
import {
  describeProductionSelection,
  type ProductionStartupSetup,
  productionConnectionNeedsCredential,
  transitionProductionSelection,
} from './production-setup.js'
import { productionConnectionsForSelection } from './production-setup-persistence.js'
import type { ProductionApplicationSlot } from './production-setup-transition.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

interface InterfaceRunnerInput {
  readonly options: CliOptions
  readonly workspace: string
  readonly active: ProductionApplicationSlot
  readonly setup?: ProductionStartupSetup
  readonly startupOptions?: ProductionStartupLoadOptions
  readonly profileConnectionOptions?: ProfileConnectionDispatchOptions
  readonly startupPreview?: StartupPreview
  readonly openConfiguredApplication: (
    options: ProductionStartupLoadOptions,
    production: ProductionCompositionConfig,
  ) => Promise<import('./production-setup-transition.js').ProductionApplicationHandle>
}

type TerminalConfiguration = NonNullable<
  ConstructorParameters<typeof BraidTerminalApp>[0]['configuration']
>

export async function runInterface(input: InterfaceRunnerInput): Promise<number> {
  const { options, workspace, active, setup, startupOptions } = input
  const fallbackCatalog = new ConnectionRegistry(
    setup?.connections ?? input.profileConnectionOptions?.connections ?? [],
  )
  const currentCatalog = (): ConnectionRegistry => active.current.connections ?? fallbackCatalog
  const productionConnections =
    startupOptions === undefined
      ? undefined
      : new ProductionConnectionActions({
          currentApp: () => active.current.app,
          currentCatalog,
          configPath:
            setup?.configPath ?? productionConfigPath(workspace, startupOptions.configPath),
          startupOptions,
          ...(input.profileConnectionOptions?.productionConnection === undefined
            ? {}
            : {
                productionConnection: input.profileConnectionOptions.productionConnection,
              }),
        })
  const profileConnectionOptions: ProfileConnectionDispatchOptions = {
    ...(input.profileConnectionOptions ?? {}),
    ...(productionConnections === undefined
      ? {}
      : {
          connectionCatalog: () => currentCatalog().list(),
          connectionActionsFor: () => productionConnections,
        }),
  }
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
    profileConnectionOptions,
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
          ...(setup.workspaceRequest === undefined
            ? {}
            : { workspaceRequest: setup.workspaceRequest }),
          diagnostics: setup.diagnostics,
          openOnStart: true,
          requiresCredential: (connection) =>
            productionConnectionNeedsCredential(startupOptions, connection),
          confirmation: (selection) =>
            describeProductionSelection(selection, workspace, verification),
          onCommit: async (selection, credential) => {
            verification = await transitionProductionSelection({
              setup,
              startupOptions,
              selection,
              workspace,
              ...(credential === undefined ? {} : { credential }),
              controller,
              active,
              activate: (next, preparedSelection) =>
                activateProductionConnection(
                  next.app,
                  preparedSelection.connection.id,
                  productionConnectionsForSelection(preparedSelection, setup.connections),
                ),
              openApplication: (selection, selectedOptions) =>
                input.openConfiguredApplication(
                  selectedOptions,
                  productionConfigForSelection(selection, selectedOptions, setup.connections),
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
    if (options.recordState) await recordInterfaceState(options.recordState, controller)
    return exitCode
  }

  if (options.plain) {
    const exitCode = await runPlain(controller, workspace, process.stdin, process.stdout, {
      initialIntents: startupIntents(),
    })
    if (options.recordState) await recordInterfaceState(options.recordState, controller)
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

  const tui =
    input.startupPreview?.tui ??
    new TuiMainScreen(options.inline ? new ProcessTerminal() : new AlternateScreenTerminal())
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
  const nativeLifecycle: {
    view?: BraidTerminalApp
    signals?: ReturnType<typeof createInterfaceSignalLifecycle>
  } = {}
  const nativeInteractive = createNativeInteractiveUiActions({
    current: () => active.current,
    terminal: tui.terminal,
    signals: () => {
      if (nativeLifecycle.signals === undefined)
        throw new Error('Terminal signal ownership is not initialized')
      return nativeLifecycle.signals
    },
    suspend: () => nativeLifecycle.view?.suspend(),
    resume: () => nativeLifecycle.view?.resume(),
    nextOperationId,
    holderId: `braid-terminal-${randomUUID()}`,
  })
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
    ...(productionConnections === undefined ? {} : { connectionLifecycle: productionConnections }),
    startupMessages,
    tuiStarted: input.startupPreview !== undefined,
    ...(input.startupPreview?.outputPolicyCleanup === undefined
      ? {}
      : { preinstalledOutputPolicyCleanup: input.startupPreview.outputPolicyCleanup }),
    nativeInteractive,
  })
  nativeLifecycle.view = view
  const signals = createInterfaceSignalLifecycle({
    controller,
    view,
    application: active.current.app,
    nextOperationId,
    ...(options.recordState === undefined ? {} : { recordState: options.recordState }),
    ...(input.startupPreview === undefined ? {} : { startupPreview: input.startupPreview }),
  })
  nativeLifecycle.signals = signals
  try {
    if (!signals.interrupted()) {
      const startupInput = input.startupPreview?.adopt().input ?? []
      await view.start(startupInput)
      await active.current.app.waitForIdle()
    }
  } finally {
    await signals.settle()
    signals.dispose()
    view.stop()
  }
  if (options.recordState) await recordInterfaceState(options.recordState, controller)
  return signals.exitCode()
}
