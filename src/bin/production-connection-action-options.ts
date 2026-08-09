import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import type { BraidApplication } from '../app/application.js'
import type { ConnectionRegistry } from '../app/connections.js'
import type { IsoDateTime } from '../domain/entities.js'
import { defaultProductionCredentialRefResolver } from './production-credential-reference.js'
import type { ProductionStartupLoadOptions } from './production-startup.js'

export interface ProductionConnectionActionsOptions {
  readonly currentApp: () => BraidApplication
  readonly currentCatalog: () => ConnectionRegistry
  readonly configPath: string
  readonly startupOptions: ProductionStartupLoadOptions
  readonly productionConnection?: ProductionConnectionOptions
  readonly now?: () => IsoDateTime
}

export function resolveProductionConnectionOptions(
  options: ProductionConnectionActionsOptions,
): ProductionConnectionOptions {
  const credentials =
    options.productionConnection?.credentials ??
    options.startupOptions.credentialStore ??
    options.startupOptions.credentialContext?.store ??
    createOperatingSystemCredentialStore()
  return {
    ...(options.productionConnection ?? {}),
    credentials,
    credentialRefResolver:
      options.productionConnection?.credentialRefResolver ??
      options.startupOptions.credentialRefResolver ??
      defaultProductionCredentialRefResolver,
  }
}
