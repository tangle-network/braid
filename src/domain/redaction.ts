import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  redactStructuredValue,
  redactStructuredValueWithNumericTelemetry,
  STRUCTURED_REDACTION_MARKER,
} from './bounded-structured.js'
import { safeProviderDiagnostic } from './provider-values.js'

export const MAX_PROFILE_BYTES = 16 * 1024 * 1024
export const MAX_CONVERSATION_IMPORT_EVENT_BYTES = 4 * 1024 * 1024

export {
  isSensitiveFieldName,
  redactStructuredValue,
  redactStructuredValueWithNumericTelemetry,
} from './bounded-structured.js'
export { redactSensitiveText, redactSensitiveUrls } from './secret-sanitizer.js'

export function redactProfile(profile: Readonly<AgentProfile>): Readonly<AgentProfile> {
  return removeProfileMetadata(
    redactStructuredValue(profile, undefined, { maxBytes: MAX_PROFILE_BYTES }),
  ) as Readonly<AgentProfile>
}

function removeProfileMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeProfileMetadata)
  if (value === null || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'metadata') {
      output[key] = { redacted: STRUCTURED_REDACTION_MARKER }
      continue
    }
    output[key] = removeProfileMetadata(child)
  }
  return output
}

export function redactProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : error
  return safeProviderDiagnostic(message, 'PROVIDER_ERROR')
}

export function redactBraidEvent<T>(event: T): T {
  const importEvent =
    event !== null &&
    typeof event === 'object' &&
    !Array.isArray(event) &&
    (event as { readonly kind?: unknown }).kind === 'conversation.imported'
  return redactStructuredValueWithNumericTelemetry(
    event,
    undefined,
    importEvent
      ? { maxDepth: 32, maxItems: 500_000, maxBytes: MAX_CONVERSATION_IMPORT_EVENT_BYTES }
      : { maxItems: 20_000 },
  ) as T
}
