import { type OperationId, parseOperationId } from '../domain/ids.js'
import { redactSensitiveText } from '../domain/redaction.js'
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
  const cause =
    failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : undefined
  const detail =
    cause === undefined ? '' : redactSensitiveText(cause).replace(/\s+/gu, ' ').trim().slice(0, 240)
  return new AppError(
    'STORAGE_FAILURE',
    `Durable storage is unavailable${detail === '' ? '' : ` (${detail})`}; reopen Braid to continue`,
  )
}

export function admissionIsAsync(execution: ExecutionPort): boolean {
  return 'admissionMode' in execution && execution.admissionMode === 'async'
}
