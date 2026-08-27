import { resolve } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  canonicalCandidateJson,
  snapshotAgentProfile,
} from '../adapters/agent-interface/profile-runtime.js'
import type { ConfigurationSelection } from '../app/configuration-session.js'
import { ConnectionRegistry } from '../app/connections.js'
import type { ConnectionRecord } from '../domain/entities.js'
import {
  assertProductionConfigMutationLock,
  type ProductionConfigMutationLock,
  readProductionConfigFile,
  removeProductionConfigFile,
  replaceProductionConfigFile,
  withProductionConfigMutationLock,
  writeProductionConfigFile,
} from './production-config-mutation-lock.js'

const MAX_STARTUP_CONFIG_BYTES = 2 * 1024 * 1024

export interface ProductionStartupPersistence {
  readonly rollback: () => Promise<void>
}

export interface ProductionStartupPersistenceOptions {
  readonly databaseKeyFile?: string
  readonly connections?: readonly ConnectionRecord[]
  readonly mutationLock?: ProductionConfigMutationLock
}

const INLINE_SECRET_VALUE =
  /(?:\bsk[-_][-_A-Za-z0-9]{10,}\b|\bgh[pousr]_[A-Za-z0-9]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\bAKIA[A-Z0-9]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|credential|secret)\b\s*[:=]\s*\S+|\b(?:canary|fixture|test)[-_ ]?(?:secret|token|credential|key|auth|bearer|basic)\b|\b(?:secret|token|credential|key|auth|bearer|basic)[-_ ]?(?:canary|fixture|test)\b)/iu

const AUTH_SCHEME_VALUE = /\b(?:Bearer|Basic)\s+([A-Za-z0-9+/_=.-]{8,})/iu
const AUTH_SCHEME_PROSE = new Set([
  'auth',
  'authentication',
  'authorization',
  'basic',
  'bearer',
  'credential',
  'credentials',
  'header',
  'headers',
  'scheme',
  'token',
  'tokens',
  'value',
  'values',
])

function hasObviousSecretValue(value: string): boolean {
  if (INLINE_SECRET_VALUE.test(value)) return true
  const schemeValue = AUTH_SCHEME_VALUE.exec(value)?.[1]
  if (schemeValue === undefined || AUTH_SCHEME_PROSE.has(schemeValue.toLowerCase())) return false
  if (/(?:canary|fixture|test|secret|token|credential|password|key|auth)/iu.test(schemeValue))
    return true
  if (/^[A-Za-z0-9+/]{12,}={0,2}$/u.test(schemeValue)) {
    const hasUpper = /[A-Z]/u.test(schemeValue)
    const hasLower = /[a-z]/u.test(schemeValue)
    if (hasUpper && hasLower) return true
  }
  return schemeValue.length >= 20
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed)
  return Object.keys(value).every((key) => accepted.has(key))
}

function validateTypedConfigValue(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(
      `Typed credential configuration at ${path} must use a typed public value or typed secret-ref wrapper`,
    )
  }
  if (value.kind === 'public') {
    if (!hasOnlyKeys(value, ['kind', 'value']) || typeof value.value !== 'string') {
      throw new Error(`Typed credential configuration at ${path} has an invalid public wrapper`)
    }
    return
  }
  if (value.kind === 'secret-ref') {
    if (
      !hasOnlyKeys(value, ['kind', 'key', 'format']) ||
      typeof value.key !== 'string' ||
      (value.format !== undefined && value.format !== 'raw' && value.format !== 'bearer')
    ) {
      throw new Error(`Typed credential configuration at ${path} has an invalid secret-ref wrapper`)
    }
    return
  }
  throw new Error(
    `Typed credential configuration at ${path} must use a typed public value or typed secret-ref wrapper`,
  )
}

function validateTypedConfigRecord(value: unknown, path: string): void {
  if (!isRecord(value)) {
    throw new Error(`Typed credential configuration at ${path} must be an object`)
  }
  for (const [key, child] of Object.entries(value)) {
    validateTypedConfigValue(child, `${path}.${key}`)
  }
}

function validateTypedConfigArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`Typed credential configuration at ${path} must be an array`)
  }
  value.forEach((child, index) => {
    validateTypedConfigValue(child, `${path}[${index}]`)
  })
}

function validateTypedConfigLocations(profile: Readonly<AgentProfile>): void {
  const hooks = profile.hooks
  if (isRecord(hooks)) {
    for (const [name, commands] of Object.entries(hooks)) {
      if (!Array.isArray(commands)) {
        throw new Error(`Typed credential configuration at hooks.${name} must be an array`)
      }
      commands.forEach((command, index) => {
        if (isRecord(command) && command.env !== undefined) {
          validateTypedConfigRecord(command.env, `hooks.${name}[${index}].env`)
        }
      })
    }
  }
  const mcp = profile.mcp
  if (!isRecord(mcp)) return
  for (const [name, server] of Object.entries(mcp)) {
    if (!isRecord(server)) continue
    if (server.args !== undefined) validateTypedConfigArray(server.args, `mcp.${name}.args`)
    if (server.env !== undefined) validateTypedConfigRecord(server.env, `mcp.${name}.env`)
    if (server.headers !== undefined)
      validateTypedConfigRecord(server.headers, `mcp.${name}.headers`)
  }
}

function rejectObviousSecretValues(value: unknown, path: string, seen = new Set<object>()): void {
  if (typeof value === 'string') {
    if (hasObviousSecretValue(value)) {
      throw new Error(
        `Inline credential material is not allowed at ${path}; use a typed secret-ref`,
      )
    }
    return
  }
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) throw new Error(`The profile contains a cyclic value at ${path}`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        rejectObviousSecretValues(entry, `${path}[${index}]`, seen)
      })
      return
    }
    for (const [key, child] of Object.entries(value)) {
      rejectObviousSecretValues(child, `${path}.${key}`, seen)
    }
  } finally {
    seen.delete(value)
  }
}

/** Returns the exact validated profile that is safe to publish and reload. */
export function persistableProductionProfile(profile: Readonly<AgentProfile>): AgentProfile {
  validateTypedConfigLocations(profile)
  let snapshot: AgentProfile
  try {
    snapshot = snapshotAgentProfile(profile)
  } catch (error) {
    throw new Error('The selected profile is not a canonical AgentProfile', { cause: error })
  }
  rejectObviousSecretValues(snapshot, 'profile')
  try {
    canonicalCandidateJson(snapshot)
  } catch (error) {
    throw new Error('The selected profile has no canonical JSON representation', { cause: error })
  }
  return snapshot
}

export function productionConnectionsForSelection(
  selection: ConfigurationSelection,
  candidates: readonly ConnectionRecord[] = [],
): readonly ConnectionRecord[] {
  const records = new Map(candidates.map((record) => [record.id, record] as const))
  records.set(selection.connection.id, selection.connection)
  return new ConnectionRegistry([...records.values()]).list()
}

function serializedSelection(
  selection: ConfigurationSelection,
  databaseKeyFile?: string,
  connections?: readonly ConnectionRecord[],
): string {
  return `${canonicalCandidateJson({
    format: 'braid-startup-config',
    schemaVersion: 2,
    profile: persistableProductionProfile(selection.profile.profile),
    connectionId: selection.connection.id,
    connections: productionConnectionsForSelection(selection, connections),
    ...(databaseKeyFile === undefined ? {} : { databaseKeyFile }),
  })}\n`
}

function publish(
  lock: ProductionConfigMutationLock,
  bytes: Buffer,
  previous: Buffer | undefined,
): void {
  if (previous === undefined) {
    writeProductionConfigFile(lock, bytes)
    return
  }
  replaceProductionConfigFile(lock, bytes, {
    overwrite: true,
    expected: (current) => {
      if (current === undefined || !current.equals(previous)) {
        throw new Error('The production configuration changed while setup was applying')
      }
    },
    maxExistingBytes: MAX_STARTUP_CONFIG_BYTES,
  })
}

function restore(
  lock: ProductionConfigMutationLock,
  bytes: Buffer,
  previous: Buffer | undefined,
): void {
  if (previous !== undefined) {
    replaceProductionConfigFile(lock, previous, {
      overwrite: true,
      expected: (current) => {
        if (current === undefined || !current.equals(bytes)) {
          throw new Error('The production configuration changed during setup rollback')
        }
      },
      maxExistingBytes: MAX_STARTUP_CONFIG_BYTES,
    })
    return
  }
  const current = readProductionConfigFile(lock, MAX_STARTUP_CONFIG_BYTES)
  if (current?.equals(bytes)) removeProductionConfigFile(lock)
}

/** Publishes a selection only after the caller has prepared the replacement app. */
export async function persistProductionStartupSelection(
  configPath: string,
  selection: ConfigurationSelection,
  options: ProductionStartupPersistenceOptions = {},
): Promise<ProductionStartupPersistence> {
  const target = resolve(configPath)
  const publishSelection = async (
    lock: ProductionConfigMutationLock,
  ): Promise<ProductionStartupPersistence> => {
    assertProductionConfigMutationLock(lock, target)
    const previous = readProductionConfigFile(lock, MAX_STARTUP_CONFIG_BYTES)
    const bytes = Buffer.from(
      serializedSelection(selection, options.databaseKeyFile, options.connections),
      'utf8',
    )
    try {
      publish(lock, bytes, previous)
    } catch (error) {
      try {
        restore(lock, bytes, previous)
      } catch (rollbackError) {
        throw new Error('The production configuration could not be safely rolled back', {
          cause: rollbackError,
        })
      }
      throw error
    }
    return {
      rollback: async () => {
        const rollback = async (activeLock: ProductionConfigMutationLock): Promise<void> => {
          assertProductionConfigMutationLock(activeLock, target)
          restore(activeLock, bytes, previous)
        }
        if (options.mutationLock !== undefined) return rollback(options.mutationLock)
        return withProductionConfigMutationLock(target, rollback)
      },
    }
  }
  if (options.mutationLock !== undefined) {
    return publishSelection(options.mutationLock)
  }
  return withProductionConfigMutationLock(target, publishSelection)
}

/** Persists selected metadata only; credentials remain in the operating-system store. */
export async function saveProductionStartupSelection(
  configPath: string,
  selection: ConfigurationSelection,
  options: ProductionStartupPersistenceOptions = {},
): Promise<void> {
  await persistProductionStartupSelection(configPath, selection, options)
}
