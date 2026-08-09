import type { ConnectionRecord } from '../../domain/entities.js'
import { healthForConnection, verifyModelForConnection } from './production-connection-health.js'
import { capabilitiesForConnection } from './production-connection-providers.js'
import type {
  ConnectionHealthOptions,
  ConnectionModelVerificationOptions,
  ProductionConnectionAdapter,
  ProductionConnectionOptions,
} from './production-connection-types.js'

export { readConnectionCredential } from './production-connection-credentials.js'
export {
  connectionEndpoint,
  normalizeCliBridgeRuntimeBaseUrl,
} from './production-connection-endpoints.js'
export { createTangleSandboxClient } from './production-connection-providers.js'
export {
  type ConnectionCapabilityAction,
  type ConnectionCapabilityReport,
  type ConnectionHealthOptions,
  type ConnectionModelVerificationOptions,
  type ConnectionProviderMethods,
  type ConnectionRuntimeCapabilities,
  DEFAULT_TANGLE_SANDBOX_ENDPOINT,
  type ProductionConnectionAdapter,
  type ProductionConnectionOptions,
  type SandboxClientFactory,
  type SandboxClientFactoryInput,
} from './production-connection-types.js'

export function createProductionConnectionAdapter(
  record: ConnectionRecord,
  options: ProductionConnectionOptions = {},
): ProductionConnectionAdapter {
  return Object.freeze({
    record,
    capabilities: () => capabilitiesForConnection(record, options),
    health: (healthOptions: ConnectionHealthOptions = {}) =>
      healthForConnection(record, options, healthOptions),
    verifyModel: (model: string, verificationOptions: ConnectionModelVerificationOptions = {}) =>
      verifyModelForConnection(record, options, model, verificationOptions),
  })
}
