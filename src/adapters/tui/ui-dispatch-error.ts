import type { AppError } from '../../app/application.js'
import type { UiDispatchResult } from '../../views/shared/intents.js'
import { redactSensitiveText } from '../../views/shared/sanitize.js'

export function errorResult(error: unknown): UiDispatchResult {
  const typed = error as Partial<AppError>
  if (typeof typed.code === 'string' && typeof typed.message === 'string') {
    return {
      kind: 'error',
      code: typed.code,
      message: redactSensitiveText(typed.message),
      retryable: false,
    }
  }
  return {
    kind: 'error',
    code: 'INTERNAL_ERROR',
    message: redactSensitiveText(error instanceof Error ? error.message : 'Internal error'),
    retryable: false,
  }
}
