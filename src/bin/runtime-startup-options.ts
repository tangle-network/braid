import type { CliOptions } from './args.js'
import {
  createProductionCredentialContext,
  type ProductionCredentialContext,
} from './production-credential-context.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

export interface RuntimeStartupOptions {
  readonly startupOptions: ProductionStartupLoadOptions
  readonly credentialContext?: ProductionCredentialContext
}

export function createRuntimeStartupOptions(
  options: CliOptions,
  workspace: string,
): RuntimeStartupOptions {
  const discoveryTimeoutMs = optionalMilliseconds('BRAID_DISCOVERY_TIMEOUT_MS')
  const modelValidationTimeoutMs = optionalMilliseconds('BRAID_MODEL_VALIDATION_TIMEOUT_MS')
  const base: ProductionStartupLoadOptions = {
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
    ...(process.env.BRAID_TANGLE_AUTH === undefined
      ? process.env.TANGLE_INTELLIGENCE_API_KEY === undefined
        ? {}
        : { tangleAuth: process.env.TANGLE_INTELLIGENCE_API_KEY }
      : { tangleAuth: process.env.BRAID_TANGLE_AUTH }),
    ...(discoveryTimeoutMs === undefined ? {} : { discoveryTimeoutMs }),
    ...(modelValidationTimeoutMs === undefined ? {} : { modelValidationTimeoutMs }),
  }
  const credentialContext = createProductionCredentialContext({
    workspace,
    ...(base.configPath === undefined ? {} : { configPath: base.configPath }),
    ...(base.databaseKeyFile === undefined ? {} : { databaseKeyFile: base.databaseKeyFile }),
  })
  return {
    startupOptions:
      credentialContext === undefined
        ? base
        : {
            ...base,
            databaseKeyFile: credentialContext.databaseKeyFile,
            credentialStore: credentialContext.store,
            credentialContext,
          },
    ...(credentialContext === undefined ? {} : { credentialContext }),
  }
}

function optionalMilliseconds(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim().length === 0) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
