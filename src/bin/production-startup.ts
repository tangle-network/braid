import { dirname, resolve } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import { portableBridgeModel } from '../adapters/connections/cli-bridge-model-route.js'
import type { ProductionConnectionOptions } from '../adapters/connections/production-connections.js'
import { createOperatingSystemCredentialStore } from '../adapters/credentials/os.js'
import { readNoFollow } from '../adapters/persistence/safe-file.js'
import {
  type ProductionCompositionConfig,
  ProductionCompositionError,
  type ProductionCompositionErrorCode,
} from '../app/production-composition.js'
import {
  importProfileValue,
  ProfilePersistenceError,
  readProfileFile,
  validateProfileShape,
} from '../app/profiles.js'
import type { ConnectionRecord } from '../domain/entities.js'
import { redactProviderError } from '../domain/redaction.js'
import { recoverPendingConnectionCredentialRemoval } from './production-connection-credential-cleanup.js'
import { defaultProductionCredentialRefResolver } from './production-credential-reference.js'
import { productionConfigPath, resolveProductionDatabaseKeyFile } from './production-key-path.js'
import { recoverPendingProductionCredential } from './production-setup-credentials.js'
import type { ProductionStartupLoadOptions } from './production-setup-types.js'

export type { ProductionStartupLoadOptions } from './production-setup-types.js'

const MAX_STARTUP_CONFIG_BYTES = 2 * 1024 * 1024

export type ProductionStartupErrorCode =
  | 'PRODUCTION_CONFIGURATION_REQUIRED'
  | 'PRODUCTION_CONFIGURATION_NOT_FOUND'
  | 'PRODUCTION_CONFIGURATION_INVALID'
  | 'PRODUCTION_DATABASE_KEY_INVALID'
  | 'PRODUCTION_PROFILE_REQUIRED'
  | 'PRODUCTION_PROFILE_NOT_FOUND'
  | 'PRODUCTION_PROFILE_INVALID'
  | 'PRODUCTION_CONNECTION_REQUIRED'

export class ProductionStartupError extends Error {
  readonly code: ProductionStartupErrorCode

  constructor(code: ProductionStartupErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ProductionStartupError'
    this.code = code
  }
}

const STARTUP_ERROR_MESSAGES: Readonly<Record<ProductionStartupErrorCode, string>> = {
  PRODUCTION_CONFIGURATION_REQUIRED: 'Production startup requires a workspace path',
  PRODUCTION_CONFIGURATION_NOT_FOUND:
    'No production configuration found; pass --config <path> or create .braid/config.json',
  PRODUCTION_CONFIGURATION_INVALID:
    'Production configuration is invalid; check its JSON, schema version, format, and connections',
  PRODUCTION_DATABASE_KEY_INVALID:
    'The database key file must be a protected mode-0600 regular file outside the agent workspace; relative paths resolve beside the Braid config file',
  PRODUCTION_PROFILE_REQUIRED:
    'Production configuration must select a canonical profile or pass --profile <path>',
  PRODUCTION_PROFILE_NOT_FOUND: 'The selected canonical profile file was not found',
  PRODUCTION_PROFILE_INVALID: 'The selected canonical profile is invalid',
  PRODUCTION_CONNECTION_REQUIRED: 'Production configuration must select an exact connection id',
}

const COMPOSITION_ERROR_MESSAGES: Readonly<Record<ProductionCompositionErrorCode, string>> = {
  PRODUCTION_CONFIGURATION_REQUIRED:
    'Production startup requires a canonical profile and one configured connection',
  PRODUCTION_PROFILE_INVALID: 'The selected canonical profile is invalid',
  PRODUCTION_CONNECTION_REQUIRED: 'Production startup requires an exact configured connection id',
  PRODUCTION_CONNECTION_INVALID: 'The selected connection configuration is invalid',
  PRODUCTION_CONNECTION_NOT_FOUND: 'The selected production connection does not exist',
  PRODUCTION_CONNECTION_UNSUPPORTED:
    'The selected production connection uses an unsupported provider kind',
  PRODUCTION_FIXTURE_FORBIDDEN:
    'The deterministic fixture cannot be combined with production configuration',
}

const RUNTIME_STARTUP_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  CREDENTIAL_STORE_UNAVAILABLE: 'The operating-system credential facility is unavailable',
  HEADLESS_KEY_IN_WORKSPACE:
    'Headless key files must be outside the agent workspace; use an external protected key file',
  HEADLESS_KEY_PERMISSIONS: 'The headless key file must have mode 0600',
  HEADLESS_KEY_SYMLINK: 'Symlinked headless key paths are rejected',
  HEADLESS_KEY_NOT_FILE: 'The headless key source must be a regular file',
  HEADLESS_KEY_SIZE: 'The headless key file is too large',
  HEADLESS_KEY_FORMAT: 'The headless key must be 32 bytes or 64 hexadecimal characters',
  STORAGE_PATH_RACE_UNSUPPORTED: 'Encrypted storage is unsupported on this filesystem',
  STORAGE_PERMISSIONS: 'The encrypted storage path has unsafe permissions',
  STORAGE_OWNERSHIP: 'The encrypted storage path is not owned by this process',
  STORAGE_INITIALIZING: 'Another Braid process is initializing encrypted storage',
}

function runtimeStartupError(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== 'string') return undefined
  const message = RUNTIME_STARTUP_ERROR_MESSAGES[error.code]
  return message === undefined ? undefined : `${error.code}: ${message}`
}

export function formatProductionStartupError(error: unknown): string {
  if (error instanceof ProductionStartupError) {
    return `${error.code}: ${STARTUP_ERROR_MESSAGES[error.code]}`
  }
  if (error instanceof ProductionCompositionError) {
    return `${error.code}: ${COMPOSITION_ERROR_MESSAGES[error.code]}`
  }
  const runtimeError = runtimeStartupError(error)
  if (runtimeError !== undefined) return runtimeError
  return redactProviderError(error)
}

export interface ProductionStartupDocument {
  readonly schemaVersion: 1 | 2
  readonly profile?: unknown
  readonly connection?: string
  readonly connectionId?: string
  readonly databaseKeyFile?: string
  readonly connections?: readonly unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      `${name} must be a non-empty string`,
    )
  }
  return value
}

function requiredStringValue(value: unknown, name: string): string {
  const result = stringValue(value, name)
  if (result === undefined) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      `${name} must be a non-empty string`,
    )
  }
  return result
}

function parseConfig(bytes: Buffer, path: string): ProductionStartupDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      `Production configuration is not valid JSON: ${path}`,
      error,
    )
  }
  if (!isRecord(parsed)) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      'Production configuration must be a JSON object',
    )
  }
  const schemaVersion = parsed.schemaVersion ?? 1
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      'Production configuration schema version is unsupported',
    )
  }
  if (
    'format' in parsed &&
    parsed.format !== undefined &&
    parsed.format !== 'braid-startup-config'
  ) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      'Production configuration format is unsupported',
    )
  }
  const connections = parsed.connections
  if (connections !== undefined && !Array.isArray(connections)) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      'Production configuration connections must be an array',
    )
  }
  return {
    schemaVersion,
    ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
    ...(parsed.connection === undefined
      ? {}
      : { connection: requiredStringValue(parsed.connection, 'connection') }),
    ...(parsed.connectionId === undefined
      ? {}
      : { connectionId: requiredStringValue(parsed.connectionId, 'connectionId') }),
    ...(parsed.databaseKeyFile === undefined
      ? {}
      : { databaseKeyFile: requiredStringValue(parsed.databaseKeyFile, 'databaseKeyFile') }),
    ...(connections === undefined ? {} : { connections }),
  }
}

function migrateStartupProfile(
  profile: Readonly<AgentProfile>,
  schemaVersion: 1 | 2,
  connection: ConnectionRecord | undefined,
): Readonly<AgentProfile> {
  const runner = profile.harness
  const model = profile.model?.default
  if (
    schemaVersion !== 1 ||
    connection?.kind !== 'cli-bridge' ||
    runner === undefined ||
    model === undefined
  ) {
    return profile
  }
  const portable = portableBridgeModel(runner, model, profile.model?.provider)
  if (!portable.includes('/') && profile.model?.provider === runner) return profile
  if (portable === model) return profile
  return {
    ...profile,
    model: {
      ...profile.model,
      default: portable,
    },
  }
}

function effectiveStartupProfile(
  profile: Readonly<AgentProfile>,
  options: Pick<ProductionStartupLoadOptions, 'model' | 'runner'>,
): Readonly<AgentProfile> {
  const candidate = {
    ...profile,
    ...(options.runner === undefined ? {} : { harness: options.runner }),
    ...(options.model === undefined
      ? {}
      : {
          model: {
            ...(profile.model ?? {}),
            default: options.model,
          },
        }),
  }
  const validated = validateProfileShape(candidate)
  if (!validated.ok || validated.profile === undefined) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      'The selected run-level model and runner do not produce a valid canonical AgentProfile',
    )
  }
  return validated.profile
}

function configPathFor(options: ProductionStartupLoadOptions): string {
  return productionConfigPath(options.workspace, options.configPath)
}

function readConfig(path: string): ProductionStartupDocument {
  let bytes: Buffer | undefined
  try {
    bytes = readNoFollow(path, MAX_STARTUP_CONFIG_BYTES)
  } catch (error) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_INVALID',
      `Could not safely read production configuration: ${path}`,
      error,
    )
  }
  if (bytes === undefined) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_NOT_FOUND',
      `No production configuration found at ${path}; pass --config <path> or create this file`,
    )
  }
  return parseConfig(bytes, path)
}

function profileFromValue(value: unknown, referenceRoot: string): Readonly<AgentProfile> {
  try {
    if (typeof value === 'string') {
      const profilePath = resolve(referenceRoot, value)
      try {
        return readProfileFile(profilePath).imported.profile
      } catch (error) {
        if (error instanceof ProfilePersistenceError && error.code === 'PROFILE_NOT_FOUND') {
          throw new ProductionStartupError(
            'PRODUCTION_PROFILE_NOT_FOUND',
            `The configured profile file does not exist: ${profilePath}`,
            error,
          )
        }
        throw error
      }
    }
    return importProfileValue(value).profile
  } catch (error) {
    if (error instanceof ProductionStartupError) throw error
    if (error instanceof ProfilePersistenceError) {
      throw new ProductionStartupError(
        'PRODUCTION_PROFILE_INVALID',
        `The configured profile is invalid: ${error.message}`,
        error,
      )
    }
    throw new ProductionStartupError(
      'PRODUCTION_PROFILE_INVALID',
      'The configured profile is not a valid canonical AgentProfile',
      error,
    )
  }
}

function connectionRecords(value: readonly unknown[] | undefined): readonly ConnectionRecord[] {
  if (value === undefined || value.length === 0) {
    throw new ProductionStartupError(
      'PRODUCTION_CONNECTION_REQUIRED',
      'Production configuration must contain at least one connection record',
    )
  }
  return value.map((record, index) => {
    if (!isRecord(record)) {
      throw new ProductionStartupError(
        'PRODUCTION_CONFIGURATION_INVALID',
        `connections[${index}] must be an object`,
      )
    }
    return record as unknown as ConnectionRecord
  })
}

export async function loadProductionStartup(
  options: ProductionStartupLoadOptions,
): Promise<ProductionCompositionConfig> {
  if (!options.workspace) {
    throw new ProductionStartupError(
      'PRODUCTION_CONFIGURATION_REQUIRED',
      'Production startup requires a workspace path',
    )
  }
  const configPath = configPathFor(options)
  const document = readConfig(configPath)
  let databaseKeyFile: string | undefined
  const configuredDatabaseKeyFile = options.databaseKeyFile ?? document.databaseKeyFile
  if (configuredDatabaseKeyFile !== undefined) {
    try {
      databaseKeyFile = resolveProductionDatabaseKeyFile(
        configuredDatabaseKeyFile,
        configPath,
        options.workspace,
      )
    } catch (error) {
      throw new ProductionStartupError(
        'PRODUCTION_DATABASE_KEY_INVALID',
        'The configured database key file is invalid',
        error,
      )
    }
  }
  await recoverPendingProductionCredential(configPath, {
    ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    ...(options.credentialContext === undefined
      ? {}
      : { credentialContext: options.credentialContext }),
  })
  await recoverPendingConnectionCredentialRemoval(configPath, {
    ...(options.credentialStore === undefined ? {} : { credentialStore: options.credentialStore }),
    ...(options.credentialContext === undefined
      ? {}
      : { credentialContext: options.credentialContext }),
    ...(options.credentialRefResolver === undefined
      ? {}
      : { credentialRefResolver: options.credentialRefResolver }),
  })
  const profileValue = options.profileReference ?? document.profile
  if (profileValue === undefined) {
    throw new ProductionStartupError(
      'PRODUCTION_PROFILE_REQUIRED',
      'Production configuration must select a canonical profile or --profile <path>',
    )
  }
  const profileRoot =
    options.profileReference === undefined ? dirname(configPath) : options.workspace
  const loadedProfile = profileFromValue(profileValue, profileRoot)
  const connections = connectionRecords(document.connections)
  const selectedConnectionId =
    options.connectionId ??
    document.connectionId ??
    document.connection ??
    (connections.length === 1 ? connections[0]?.id : undefined)
  if (selectedConnectionId === undefined) {
    throw new ProductionStartupError(
      'PRODUCTION_CONNECTION_REQUIRED',
      'Select one configured connection with connectionId or --connection <id>',
    )
  }
  const selectedConnection = connections.find((record) => record.id === selectedConnectionId)
  const profile = effectiveStartupProfile(
    migrateStartupProfile(loadedProfile, document.schemaVersion, selectedConnection),
    options,
  )
  const credentialStore =
    selectedConnection?.credentialRef === undefined
      ? undefined
      : (options.credentialStore ??
        options.credentialContext?.store ??
        createOperatingSystemCredentialStore())
  const connectionOptions: ProductionConnectionOptions = {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(credentialStore === undefined ? {} : { credentials: credentialStore }),
    ...(credentialStore === undefined
      ? {}
      : {
          credentialRefResolver:
            options.credentialRefResolver ?? defaultProductionCredentialRefResolver,
        }),
  }
  return {
    profile,
    connections,
    connectionId: selectedConnectionId,
    ...(databaseKeyFile === undefined ? {} : { databaseKeyFile }),
    ...(Object.keys(connectionOptions).length === 0 ? {} : { connectionOptions }),
  }
}
