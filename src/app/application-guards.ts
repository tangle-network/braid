import { type OperationId, parseOperationId } from '../domain/ids.js'
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
  if (failure !== undefined)
    throw new AppError(
      'STORAGE_FAILURE',
      'Durable storage is unavailable; reopen Braid to continue',
    )
}

export function admissionIsAsync(execution: ExecutionPort): boolean {
  return 'admissionMode' in execution && execution.admissionMode === 'async'
}
