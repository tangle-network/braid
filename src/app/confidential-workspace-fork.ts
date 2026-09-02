import {
  type ConfidentialExecutionRequest,
  ConfidentialExecutionRequestSchema,
} from '@tangle-network/agent-interface'
import { AppError } from './errors.js'

/** Parse the canonical request shared by every workspace-fork surface. */
export function parseConfidentialWorkspaceForkRequest(
  value: unknown,
): ConfidentialExecutionRequest | undefined {
  if (value === undefined) return undefined
  const parsed = ConfidentialExecutionRequestSchema.safeParse(value)
  if (!parsed.success)
    throw new AppError('INVALID_FORK_PLAN', 'Confidential placement request is invalid')
  return parsed.data
}

/** Parse one TUI JSON argument without exposing its contents in an error. */
export function parseConfidentialWorkspaceForkArgument(
  value: string,
): ConfidentialExecutionRequest {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new AppError('INVALID_FORK_PLAN', 'Confidential placement request must be valid JSON')
  }
  const parsed = parseConfidentialWorkspaceForkRequest(decoded)
  if (parsed === undefined)
    throw new AppError('INVALID_FORK_PLAN', 'Confidential placement request is invalid')
  return parsed
}

export type { ConfidentialExecutionRequest }
