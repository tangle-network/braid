import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import type { BraidApplication } from '../app/application.js'
import type { ConnectionRegistry } from '../app/connections.js'
import type { IsoDateTime } from '../domain/entities.js'
import {
  type ProductionStartupLoadOptions,
  productionConnectionOptions,
} from './production-startup.js'

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
  return {
    ...productionConnectionOptions(options.startupOptions),
    ...(options.productionConnection ?? {}),
  }
}
