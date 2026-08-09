import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import type { ProfileRecord } from '../app/profile-types.js'
import type { ConnectionRecord } from '../domain/entities.js'
import type { CredentialPort } from '../ports/credentials.js'
import type { ProductionCredentialContext } from './production-credential-context.js'

export interface ProductionStartupLoadOptions {
  readonly workspace: string
  readonly configPath?: string
  readonly profileReference?: string
  readonly connectionId?: string
  readonly model?: string
  readonly runner?: string
  readonly effort?: string
  /** Protected headless SQLite key file, absolute or relative to the config directory. */
  readonly databaseKeyFile?: string
  readonly fetch?: typeof fetch
  /** Explicit non-default bridge endpoint for isolated local or test setups. */
  readonly cliBridgeEndpoint?: string
  /** Optional in-memory bridge authorization; never persisted in startup config. */
  readonly bridgeAuth?: string
  /** Discovery timeout for /health and /v1/models. */
  readonly discoveryTimeoutMs?: number
  /** Realistic bounded timeout for a cold first-run model request. */
  readonly modelValidationTimeoutMs?: number
  readonly credentialStore?: CredentialPort
  /** Shared key-backed store for setup, recovery, and the durable app. */
  readonly credentialContext?: ProductionCredentialContext
  readonly credentialRefResolver?: ProductionConnectionOptions['credentialRefResolver']
}

export interface ProductionSetupVerification {
  readonly status: 'unverified' | 'verified'
  readonly detail: string
}

export interface ProductionStartupSetup {
  readonly configPath: string
  readonly profiles: readonly ProfileRecord[]
  readonly connections: readonly ConnectionRecord[]
  readonly diagnostics: readonly string[]
  readonly initialProfileId?: ProfileRecord['id']
  readonly verification: ProductionSetupVerification
}
