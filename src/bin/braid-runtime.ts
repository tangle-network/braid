import { resolve } from 'node:path'
import { createUnavailableTraceAnalysisAnalyst } from '../adapters/analysis/trace-analysis-adapter.js'
import type { ProfileConnectionDispatchOptions } from '../adapters/tui/profile-connection-dispatch.js'
import type { BraidApplication } from '../app/application.js'
import { createBraidApplication } from '../app/composition.js'
import { createMemoryJournal } from '../app/journal.js'
import { SystemClock } from '../ports/clock.js'
import type { CliOptions } from './args.js'
import { openProductionApplication } from './production-application.js'
import { createProductionCredentialContext } from './production-credential-context.js'
import { loadProductionSetup, type ProductionStartupSetup } from './production-setup.js'
import {
  loadProductionStartup,
  ProductionStartupError,
  type ProductionStartupLoadOptions,
} from './production-startup.js'
import { defaultStatePath } from './state-path.js'

export async function runBraid(options: CliOptions): Promise<number> {
  const workspace = resolve(options.workspace)
  const [opened, { runInterface }] = await Promise.all([
    openApplication(options, workspace),
    import('./interface-runner.js'),
  ])
  const active = { current: { app: opened.app, close: opened.close } }
  try {
    return await runInterface({
      options,
      workspace,
      active,
      ...(opened.setup === undefined ? {} : { setup: opened.setup }),
      ...(opened.startupOptions === undefined ? {} : { startupOptions: opened.startupOptions }),
      ...(opened.profileConnectionOptions === undefined
        ? {}
        : { profileConnectionOptions: opened.profileConnectionOptions }),
      openConfiguredApplication,
    })
  } finally {
    await active.current.close()
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
): Promise<{
  readonly app: BraidApplication
  readonly close: () => Promise<void>
  readonly setup?: ProductionStartupSetup
  readonly startupOptions?: ProductionStartupLoadOptions
  readonly profileConnectionOptions?: ProfileConnectionDispatchOptions
}> {
  if (options.fixture) {
    const configured = Number(process.env.BRAID_FIXTURE_CHUNK_DELAY_MS ?? 12)
    const app = createBraidApplication({
      fixture: options.fixture,
      chunkDelayMs: Number.isFinite(configured) && configured >= 0 ? configured : 12,
    })
    return { app, close: () => app.close() }
  }
  const discoveryTimeoutMs = optionalMilliseconds('BRAID_DISCOVERY_TIMEOUT_MS')
  const modelValidationTimeoutMs = optionalMilliseconds('BRAID_MODEL_VALIDATION_TIMEOUT_MS')
  const baseStartupOptions: ProductionStartupLoadOptions = {
    workspace,
    ...(options.config === undefined ? {} : { configPath: options.config }),
    ...(options.profile === undefined ? {} : { profileReference: options.profile }),
    ...(options.connection === undefined ? {} : { connectionId: options.connection }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.databaseKeyFile === undefined ? {} : { databaseKeyFile: options.databaseKeyFile }),
    ...(options.effort === undefined ? {} : { effort: options.effort }),
    ...(process.env.BRAID_CLI_BRIDGE_ENDPOINT === undefined
      ? {}
      : { cliBridgeEndpoint: process.env.BRAID_CLI_BRIDGE_ENDPOINT }),
    ...(process.env.BRAID_CLI_BRIDGE_AUTH === undefined
      ? {}
      : { bridgeAuth: process.env.BRAID_CLI_BRIDGE_AUTH }),
    ...(discoveryTimeoutMs === undefined ? {} : { discoveryTimeoutMs }),
    ...(modelValidationTimeoutMs === undefined ? {} : { modelValidationTimeoutMs }),
  }
  const credentialContext = createProductionCredentialContext({
    workspace,
    ...(baseStartupOptions.configPath === undefined
      ? {}
      : { configPath: baseStartupOptions.configPath }),
    ...(baseStartupOptions.databaseKeyFile === undefined
      ? {}
      : { databaseKeyFile: baseStartupOptions.databaseKeyFile }),
  })
  const startupOptions: ProductionStartupLoadOptions =
    credentialContext === undefined
      ? baseStartupOptions
      : {
          ...baseStartupOptions,
          databaseKeyFile: credentialContext.databaseKeyFile,
          credentialStore: credentialContext.store,
          credentialContext,
        }
  try {
    const production = await loadProductionStartup(startupOptions)
    const configured = await openConfiguredApplication(startupOptions, production)
    return {
      ...configured,
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
): Promise<{ readonly app: BraidApplication; readonly close: () => Promise<void> }> {
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

function optionalMilliseconds(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
