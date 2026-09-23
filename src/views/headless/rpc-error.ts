import { AppError } from '../../app/application.js'
import { redactSensitiveText } from '../../domain/bounds.js'
import type { ErrorResponse } from './protocol.js'

export function errorResponse(error: unknown, requestId?: string): ErrorResponse {
  if (error instanceof AppError) {
    return {
      version: 1,
      type: 'error',
      ...(requestId ? { requestId } : {}),
      code: error.code,
      message: redactSensitiveText(error.message),
      retryable: false,
    }
  }
  return {
    version: 1,
    type: 'error',
    ...(requestId ? { requestId } : {}),
    code: 'INTERNAL_ERROR',
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    retryable: false,
  }
}
