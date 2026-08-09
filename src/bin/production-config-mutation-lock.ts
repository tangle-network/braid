import { resolve } from 'node:path'
import {
  acquirePrivateFileLock,
  releasePrivateFileLock,
} from '../adapters/persistence/safe-file.js'

const LOCK_BRAND = Symbol('production-config-mutation-lock')
const activeLocks = new WeakSet<object>()

export interface ProductionConfigMutationLock {
  readonly configPath: string
  readonly [LOCK_BRAND]: true
}

function lockPath(configPath: string): string {
  return `${resolve(configPath)}.connection-mutation.lock`
}

export function assertProductionConfigMutationLock(
  lock: ProductionConfigMutationLock,
  configPath: string,
): void {
  if (!activeLocks.has(lock) || lock.configPath !== resolve(configPath)) {
    throw new Error('The production configuration mutation lock is not active for this path')
  }
}

/** Serializes configuration publication and protected credential cleanup across processes. */
export async function withProductionConfigMutationLock<T>(
  configPath: string,
  action: (lock: ProductionConfigMutationLock) => Promise<T>,
): Promise<T> {
  const canonicalPath = resolve(configPath)
  const path = lockPath(canonicalPath)
  const handle = acquirePrivateFileLock(path, 'Production connection configuration')
  const lock: ProductionConfigMutationLock = Object.freeze({
    configPath: canonicalPath,
    [LOCK_BRAND]: true as const,
  })
  activeLocks.add(lock)
  let outcome:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown }
  try {
    outcome = { ok: true, value: await action(lock) }
  } catch (error) {
    outcome = { ok: false, error }
  }
  activeLocks.delete(lock)
  let releaseFailure: unknown
  try {
    releasePrivateFileLock(path, handle)
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
