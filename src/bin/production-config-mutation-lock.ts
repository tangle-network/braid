import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  acquirePrivateFileLock,
  assertNoSymlinkPath,
  assertSafeDirectory,
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
  // The lock sits beside the configuration, so a first save in a fresh workspace creates
  // `.braid` before taking it; the directory is private and no component may be a link.
  const directory = dirname(canonicalPath)
  assertNoSymlinkPath(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkPath(directory)
  assertSafeDirectory(directory)
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
