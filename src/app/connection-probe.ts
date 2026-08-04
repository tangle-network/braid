import type {
  ConnectionCapabilityReport,
  ConnectionHealthOptions,
  ConnectionModelVerificationOptions,
} from '../adapters/connections/production-connection-types.js'
import type {
  ConnectionHealth,
  ConnectionModelVerification,
  ConnectionRecord,
} from '../domain/entities.js'

/** Provider work required only by an explicit connection test. */
export interface ConnectionProbe {
  readonly capabilities: () => Promise<ConnectionCapabilityReport>
  readonly health: (options?: ConnectionHealthOptions) => Promise<ConnectionHealth>
  readonly verifyModel?: (
    model: string,
    options?: ConnectionModelVerificationOptions,
  ) => Promise<ConnectionModelVerification>
}

export type ConnectionProbeFactory = (record: ConnectionRecord) => ConnectionProbe | undefined
