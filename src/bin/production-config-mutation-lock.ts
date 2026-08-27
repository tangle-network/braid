import { closeSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  acquirePrivateFileLockAt,
  type PrivateFileLock,
  type PrivateFileWriteOptions,
  readPrivateFileAt,
  releasePrivateFileLock,
  removePrivateFileAt,
  replacePrivateFileAt,
  writePrivateFileAt,
} from '../adapters/persistence/safe-file.js'
import {
  type OpenParent,
  openOrCreatePrivateParent,
  requireOpenParentIdentity,
} from '../adapters/persistence/safe-file-descriptor.js'

const LOCK_BRAND = Symbol('production-config-mutation-lock')

export interface ProductionConfigMutationLock {
  readonly configPath: string
  readonly [LOCK_BRAND]: true
}

interface ProductionConfigMutationLockState {
  readonly fileLock: PrivateFileLock
  readonly lockPath: string
  readonly parent: OpenParent
}

const activeLocks = new WeakMap<object, ProductionConfigMutationLockState>()

function lockPath(configPath: string): string {
  return `${resolve(configPath)}.connection-mutation.lock`
}

export function assertProductionConfigMutationLock(
  lock: ProductionConfigMutationLock,
  configPath: string,
): void {
  const canonicalPath = resolve(configPath)
  const state = activeLocks.get(lock)
  if (state === undefined || lock.configPath !== canonicalPath) {
    throw new Error('The production configuration mutation lock is not active for this path')
  }
  requireOpenParentIdentity(state.parent)
}

function activeLockState(lock: ProductionConfigMutationLock): ProductionConfigMutationLockState {
  const state = activeLocks.get(lock)
  if (state === undefined) {
    throw new Error('The production configuration mutation lock is not active for this path')
  }
  requireOpenParentIdentity(state.parent)
  return state
}

export function readProductionConfigFile(
  lock: ProductionConfigMutationLock,
  maxBytes: number,
): Buffer | undefined {
  return readPrivateFileAt(activeLockState(lock).parent, maxBytes)
}

export function writeProductionConfigFile(
  lock: ProductionConfigMutationLock,
  value: string | Buffer,
): void {
  writePrivateFileAt(activeLockState(lock).parent, value)
}

export function replaceProductionConfigFile(
  lock: ProductionConfigMutationLock,
  value: string | Buffer,
  options: PrivateFileWriteOptions,
): void {
  replacePrivateFileAt(activeLockState(lock).parent, value, options)
}

export function removeProductionConfigFile(lock: ProductionConfigMutationLock): void {
  removePrivateFileAt(activeLockState(lock).parent)
}

/**
 * Serializes cooperative Braid processes.
 * A same-UID process that unlinks this file outside this API is outside the lock contract.
 */
export async function withProductionConfigMutationLock<T>(
  configPath: string,
  action: (lock: ProductionConfigMutationLock) => Promise<T>,
): Promise<T> {
  const canonicalPath = resolve(configPath)
  const parent = openOrCreatePrivateParent(canonicalPath)
  let fileLock: PrivateFileLock
  try {
    fileLock = acquirePrivateFileLockAt(
      parent.fd,
      `${parent.leaf}.connection-mutation.lock`,
      lockPath(canonicalPath),
      'Production connection configuration',
    )
  } catch (error) {
    closeSync(parent.fd)
    throw error
  }
  const lock: ProductionConfigMutationLock = Object.freeze({
    configPath: canonicalPath,
    [LOCK_BRAND]: true as const,
  })
  const acquiredLockPath = lockPath(canonicalPath)
  activeLocks.set(lock, { fileLock, lockPath: acquiredLockPath, parent })
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown }
  try {
    outcome = { ok: true, value: await action(lock) }
  } catch (error) {
    outcome = { ok: false, error }
  }
  const lockState = activeLocks.get(lock)
  activeLocks.delete(lock)
  let releaseFailure: unknown
  try {
    if (lockState === undefined) {
      throw new Error('The production configuration mutation lock lost its private state')
    }
    releasePrivateFileLock(lockState.lockPath, lockState.fileLock)
  } catch (error) {
    releaseFailure = error
  }
  if (!outcome.ok) {
    if (releaseFailure !== undefined) {
      throw new AggregateError(
        [outcome.error, releaseFailure],
        'The production configuration action failed and its mutation lock could not be released',
      )
    }
    throw outcome.error
  }
  if (releaseFailure !== undefined) throw releaseFailure
  return outcome.value
}
