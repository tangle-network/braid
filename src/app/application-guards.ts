import { type OperationId, parseOperationId } from '../domain/ids.js'
import { providerCause } from '../domain/provider-values.js'
import type { EffectStoragePort } from '../ports/effect-storage.js'
import type { ExecutionPort } from '../ports/execution.js'
import { AppError } from './errors.js'

export function operationId(value: string, command: string): OperationId {
  try {
    return parseOperationId(value)
  } catch {
    throw new AppError('INVALID_OPERATION_ID', `${command} requires a valid operationId`)
  }
}

export function assertWritable(failure: unknown): void {
  if (failure !== undefined) throw storageUnavailable(failure)
}

/**
 * The latched failure says why storage stopped. A bare code left two concurrent LIVE-07 runs
 * undiagnosable, so the cause travels with the code, redacted and bounded.
 */
export function storageUnavailable(failure: unknown): AppError {
  const detail = providerCause(failure instanceof Error ? failure.message : failure)
  return new AppError(
    'STORAGE_FAILURE',
    `Durable storage is unavailable${detail === undefined ? '' : ` (${detail})`}; reopen Braid to continue`,
  )
}

/** A viewer opened with --read-only writes nothing; the Braid that owns the run decides. */
export function readOnlyRefusal(): AppError {
  return new AppError(
    'READ_ONLY',
    'This Braid is attached read-only, so it cannot change the conversation or its runs; act from the Braid that owns the run',
  )
}

/** Reads pass through; an effect, which precedes every external dispatch, is refused. */
export function readOnlyEffectStorage(storage: EffectStoragePort): EffectStoragePort {
  const refuse = (): never => {
    throw readOnlyRefusal()
  }
  const fingerprint = storage.fingerprint?.bind(storage)
  return {
    ...(fingerprint === undefined ? {} : { fingerprint }),
    reserveEffect: refuse,
    appendEffect: refuse,
    current: (id) => storage.current(id),
    latest: (id, requestDigest) => storage.latest(id, requestDigest),
    history: (id) => storage.history(id),
  }
}

export function admissionIsAsync(execution: ExecutionPort): boolean {
  return 'admissionMode' in execution && execution.admissionMode === 'async'
}
