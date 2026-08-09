import type { ConnectionCapabilityReport } from '../adapters/connections/production-connection-types.js'
import type {
  ConnectionHealth,
  ConnectionModelVerification,
  ConnectionRecord,
} from '../domain/entities.js'

export interface ConnectionSummary {
  readonly id: string
  readonly name: string
  readonly kind: ConnectionRecord['kind']
  readonly endpoint?: string
  readonly region?: string
  readonly account?: string
  readonly credentialConfigured: boolean
  readonly health: ConnectionHealth
  readonly modelVerification?: ConnectionModelVerification
  readonly capabilityHints: readonly string[]
  readonly capabilities?: ConnectionCapabilityReport
  readonly ready: boolean
}

export interface ConnectionListResult {
  readonly connections: readonly ConnectionSummary[]
}

export interface ConnectionTestResultData {
  readonly connection: ConnectionSummary
  readonly health: ConnectionHealth
  readonly modelVerification: ConnectionModelVerification
  readonly capabilities?: ConnectionCapabilityReport
  readonly ready: boolean
}

export interface ConnectionTestResult extends ConnectionTestResultData {
  readonly revision: number
  readonly replayed: boolean
}

export interface ConnectionSelectionResult {
  readonly connection: ConnectionSummary
  readonly revision: number
  readonly replayed: boolean
}
