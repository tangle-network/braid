import { resolve } from 'node:path'
import type { ProfileConnectionDispatchOptions } from '../adapters/tui/profile-connection-dispatch.js'
import type { BraidApplication } from '../app/application.js'
import type { ConnectionRegistry } from '../app/connections.js'
import type { StartupPreview } from '../startup/preview-runtime.js'
import type { CliOptions } from './args.js'
import { openFixtureApplication } from './fixture-application.js'
import {
  activateProductionConnection,
  openProductionApplication,
} from './production-application.js'
import { loadProductionProfileCatalog, loadProductionSetup } from './production-setup.js'
import {
  createReauthenticationSetup,
  openSetupApplication,
} from './production-setup-application.js'
import type { ProductionStartupSetup } from './production-setup-types.js'
import {
  loadProductionStartup,
  ProductionStartupError,
  type ProductionStartupLoadOptions,
} from './production-startup.js'
import { createRuntimeStartupOptions } from './runtime-startup-options.js'
import { defaultStatePath } from './state-path.js'
export async function runBraid(options: CliOptions): Promise<number> {
  const workspace = resolve(options.workspace)
  const previewRuntime =
    options.mode === 'tui' && !options.plain && process.stdin.isTTY && process.stdout.isTTY
      ? import('../startup/preview-runtime.js')
      : undefined
  const opened = await openApplication(options, workspace)
  const active = {
    current: {
      app: opened.app,
      close: opened.close,
      ...(opened.connections === undefined ? {} : { connections: opened.connections }),
      ...(opened.nativeInteractive === undefined
        ? {}
        : { nativeInteractive: opened.nativeInteractive }),
    },
  }
  let startupPreview: StartupPreview | undefined
  try {
    if (previewRuntime !== undefined) {
      const { createStartupPreview } = await previewRuntime
      startupPreview = createStartupPreview({
        state: opened.app.state(),
        workspace,
        inline: options.inline,
        colors: !options.noColor && process.env.NO_COLOR === undefined,
        highContrast: options.highContrast,
        reducedMotion: options.reducedMotion,
        suppressMetadata:
          options.noColor || options.reducedMotion || process.env.NO_COLOR !== undefined,
      })
    }
    const { runInterface } = await import('./interface-runner.js')
    return await runInterface({
      options,
      workspace,
      active,
      ...(opened.setup === undefined ? {} : { setup: opened.setup }),
      ...(opened.startupOptions === undefined ? {} : { startupOptions: opened.startupOptions }),
      ...(opened.profileConnectionOptions === undefined
        ? {}
        : { profileConnectionOptions: opened.profileConnectionOptions }),
      ...(startupPreview === undefined ? {} : { startupPreview }),
      openConfiguredApplication,
    })
  } finally {
    startupPreview?.close()
    await active.current.close()
  }
}
async function openApplication(
  options: CliOptions,
  workspace: string,
): Promise<{
  readonly app: BraidApplication
  readonly close: () => Promise<void>
  readonly connections?: ConnectionRegistry
  readonly nativeInteractive?: import('../ports/native-interactive-execution.js').NativeInteractiveExecutionControl
  readonly setup?: ProductionStartupSetup
  readonly startupOptions?: ProductionStartupLoadOptions
  readonly profileConnectionOptions?: ProfileConnectionDispatchOptions
}> {
  if (options.fixture) return openFixtureApplication(options)
  const { startupOptions, credentialContext } = createRuntimeStartupOptions(options, workspace)
  try {
    const production = await loadProductionStartup(startupOptions)
    if (options.reauthenticate) {
      const setup = createReauthenticationSetup(production, startupOptions)
      return openSetupApplication(setup, startupOptions, credentialContext)
    }
    const configured = await openConfiguredApplication(startupOptions, production)
    const restoredConnectionId = configured.app.state().selectedConnectionId ?? undefined
    const restoredConnectionAvailable =
      restoredConnectionId !== undefined &&
      production.connections.some((connection) => connection.id === restoredConnectionId)
    const connectionId =
      startupOptions.connectionId ??
      (restoredConnectionAvailable ? restoredConnectionId : production.connectionId)
    let profiles: Awaited<ReturnType<typeof loadProductionProfileCatalog>>
    try {
      profiles = await loadProductionProfileCatalog(startupOptions, production, connectionId)
      await activateProductionConnection(configured.app, connectionId, production.connections)
    } catch (activationError) {
      await configured.close().catch(() => undefined)
      throw activationError
    }
    return {
      ...configured,
      startupOptions,
      profileConnectionOptions: {
        profiles,
        connections: production.connections,
        ...(production.connectionOptions === undefined
          ? {}
          : { productionConnection: production.connectionOptions }),
      },
    }
  } catch (error) {
    if (
      options.reauthenticate === true ||
      !(error instanceof ProductionStartupError) ||
      error.code !== 'PRODUCTION_CONFIGURATION_NOT_FOUND'
    ) {
      credentialContext?.dispose()
      throw error
    }
    try {
      const setup = await loadProductionSetup(startupOptions)
      return openSetupApplication(setup, startupOptions, credentialContext)
    } catch (setupError) {
      credentialContext?.dispose()
      throw setupError
    }
  }
}
async function openConfiguredApplication(
  startupOptions: ProductionStartupLoadOptions,
  production?: import('../app/production-composition.js').ProductionCompositionConfig,
): ReturnType<typeof openProductionApplication> {
  const configured = production ?? (await loadProductionStartup(startupOptions))
  const effectiveStartupOptions =
    startupOptions.databaseKeyFile === undefined && configured.databaseKeyFile !== undefined
      ? { ...startupOptions, databaseKeyFile: configured.databaseKeyFile }
      : startupOptions
  return openProductionApplication({
    workspace: effectiveStartupOptions.workspace,
    statePath: defaultStatePath(
      effectiveStartupOptions.workspace,
      effectiveStartupOptions.configPath,
    ),
    startupOptions: effectiveStartupOptions,
    production: configured,
  })
}
