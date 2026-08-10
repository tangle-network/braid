import { resolve } from 'node:path'
import { createUnavailableTraceAnalysisAnalyst } from '../adapters/analysis/trace-analysis-adapter.js'
import type { ProfileConnectionDispatchOptions } from '../adapters/tui/profile-connection-dispatch.js'
import type { BraidApplication } from '../app/application.js'
import { createBraidApplication } from '../app/composition.js'
import type { ConnectionRegistry } from '../app/connections.js'
import { createMemoryJournal } from '../app/journal.js'
import { SystemClock } from '../ports/clock.js'
import type { StartupPreview } from '../startup/preview-runtime.js'
import { PRODUCT_DEMO_CONNECTION, PRODUCT_DEMO_PROFILE } from '../testing/product-demo-fixture.js'
import type { CliOptions } from './args.js'
import {
  activateProductionConnection,
  openProductionApplication,
} from './production-application.js'
import { loadProductionSetup, type ProductionStartupSetup } from './production-setup.js'
import {
  loadProductionStartup,
  ProductionStartupError,
  type ProductionStartupLoadOptions,
} from './production-startup.js'
import { createRuntimeStartupOptions } from './runtime-startup-options.js'
import { defaultStatePath } from './state-path.js'

export async function runBraid(options: CliOptions): Promise<number> {
  const workspace = resolve(options.workspace)
  const previewRuntime = usesInteractiveTerminal(options)
    ? import('../startup/preview-runtime.js')
    : undefined
  const opened = await openApplication(options, workspace)
  const active = {
    current: {
      app: opened.app,
      close: opened.close,
      ...(opened.connections === undefined ? {} : { connections: opened.connections }),
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

function usesInteractiveTerminal(options: CliOptions): boolean {
  return options.mode === 'tui' && !options.plain && process.stdin.isTTY && process.stdout.isTTY
}

/** Fixtures use memory; every other run owns encrypted SQLite and must close it. */
async function openApplication(
  options: CliOptions,
  workspace: string,
): Promise<{
  readonly app: BraidApplication
  readonly close: () => Promise<void>
  readonly connections?: ConnectionRegistry
  readonly setup?: ProductionStartupSetup
  readonly startupOptions?: ProductionStartupLoadOptions
  readonly profileConnectionOptions?: ProfileConnectionDispatchOptions
}> {
  if (options.fixture) {
    const productDemo = options.uiFixture === 'product-demo'
    const configured = Number(process.env.BRAID_FIXTURE_CHUNK_DELAY_MS ?? 12)
    const app = createBraidApplication({
      fixture: options.fixture,
      ...(productDemo ? { profile: PRODUCT_DEMO_PROFILE } : {}),
      chunkDelayMs: Number.isFinite(configured) && configured >= 0 ? configured : 12,
    })
    return {
      app,
      close: () => app.close(),
      ...(productDemo
        ? { profileConnectionOptions: { connections: [PRODUCT_DEMO_CONNECTION] } }
        : {}),
    }
  }
  const { startupOptions, credentialContext } = createRuntimeStartupOptions(options, workspace)
  try {
    const production = await loadProductionStartup(startupOptions)
    const configured = await openConfiguredApplication(startupOptions, production)
    const restoredConnectionId = configured.app.state().selectedConnectionId ?? undefined
    const restoredConnectionAvailable =
      restoredConnectionId !== undefined &&
      production.connections.some((connection) => connection.id === restoredConnectionId)
    const connectionId =
      startupOptions.connectionId ??
      (restoredConnectionAvailable ? restoredConnectionId : production.connectionId)
    try {
      await activateProductionConnection(configured.app, connectionId, production.connections)
    } catch (activationError) {
      await configured.close().catch(() => undefined)
      throw activationError
    }
    return {
      ...configured,
      startupOptions,
      profileConnectionOptions: {
        connections: production.connections,
        ...(production.connectionOptions === undefined
          ? {}
          : { productionConnection: production.connectionOptions }),
      },
    }
  } catch (error) {
    if (
      !(error instanceof ProductionStartupError) ||
      error.code !== 'PRODUCTION_CONFIGURATION_NOT_FOUND'
    ) {
      credentialContext?.dispose()
      throw error
    }
    try {
      const setup = await loadProductionSetup(startupOptions)
      const journal = createMemoryJournal(new SystemClock())
      const app = createBraidApplication({
        journal,
        effectStorage: journal,
        intelligence: { analyst: createUnavailableTraceAnalysisAnalyst() },
      })
      const releaseContext = credentialContext?.acquire()
      return {
        app,
        close: async () => {
          try {
            await app.close()
          } finally {
            releaseContext?.()
          }
        },
        setup,
        startupOptions,
        profileConnectionOptions: {
          profiles: setup.profiles,
          connections: setup.connections,
          productionConnection: {
            ...(startupOptions.fetch === undefined ? {} : { fetch: startupOptions.fetch }),
            ...(startupOptions.credentialStore === undefined
              ? {}
              : { credentials: startupOptions.credentialStore }),
            ...(startupOptions.credentialRefResolver === undefined
              ? {}
              : { credentialRefResolver: startupOptions.credentialRefResolver }),
          },
        },
      }
    } catch (setupError) {
      credentialContext?.dispose()
      throw setupError
    }
  }
}

async function openConfiguredApplication(
  startupOptions: ProductionStartupLoadOptions,
  production?: import('../app/production-composition.js').ProductionCompositionConfig,
): Promise<{
  readonly app: BraidApplication
  readonly connections: ConnectionRegistry
  readonly close: () => Promise<void>
}> {
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
