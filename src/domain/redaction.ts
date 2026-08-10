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
  const modelMetadata = publicModelMetadata(profile.model?.metadata)
  return removeProfileMetadata(
    redactStructuredValue(profile, undefined, { maxBytes: MAX_PROFILE_BYTES }),
    [],
    modelMetadata,
  ) as Readonly<AgentProfile>
}

function removeProfileMetadata(
  value: unknown,
  path: readonly string[],
  modelMetadata: Readonly<Record<string, unknown>>,
): unknown {
  if (Array.isArray(value))
    return value.map((child) => removeProfileMetadata(child, path, modelMetadata))
  if (value === null || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'metadata') {
      output[key] =
        path.length === 1 && path[0] === 'model'
          ? modelMetadata
          : { redacted: STRUCTURED_REDACTION_MARKER }
      continue
    }
    output[key] = removeProfileMetadata(child, [...path, key], modelMetadata)
  }
  return output
}

/** Keeps only the public output-token limit used by agent-runtime. */
function publicModelMetadata(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { redacted: STRUCTURED_REDACTION_MARKER }
  }
  const entries = Object.entries(value)
  const maxTokens = (value as Record<string, unknown>).maxTokens
  const validMaxTokens =
    typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0
  const hasPrivateFields = entries.some(([key]) => key !== 'maxTokens')
  return {
    ...(validMaxTokens ? { maxTokens } : {}),
    ...(!validMaxTokens || hasPrivateFields ? { redacted: STRUCTURED_REDACTION_MARKER } : {}),
  }
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
