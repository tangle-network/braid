import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  redactStructuredValueWithNumericTelemetry,
  STRUCTURED_REDACTION_MARKER,
} from './bounded-structured.js'
import type { AnalysisRecord } from './entities.js'
import { isEventId, isMessageId, isMessagePartId } from './ids.js'
import { safeProviderDiagnostic } from './provider-values.js'

export const MAX_PROFILE_BYTES = 16 * 1024 * 1024
export const MAX_CONVERSATION_IMPORT_EVENT_BYTES = 4 * 1024 * 1024
// Leave room for the journal envelope inside SQLite's 4 MiB transaction limit.
export const MAX_ANALYSIS_EVENT_BYTES = 3 * 1024 * 1024

function analysisEvent(value: unknown): value is { readonly analysis: AnalysisRecord } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const kind = (value as { readonly kind?: unknown }).kind
  return kind === 'analysis.created' || kind === 'analysis.updated' || kind === 'analysis.completed'
}

function sameSourceIds(original: AnalysisRecord, redacted: AnalysisRecord): boolean {
  const source = original.sourceRange
  const safe = redacted.sourceRange
  if (source === undefined || safe === undefined) return source === safe
  for (const [field, valid] of [
    ['eventIds', isEventId],
    ['messageIds', isMessageId],
    ['messagePartIds', isMessagePartId],
  ] as const) {
    const before: readonly unknown[] = source[field]
    const after: unknown = safe[field]
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) {
      return false
    }
    if (before.some((id, index) => !valid(id) || id !== after[index])) return false
  }
  return true
}

export {
  isSensitiveFieldName,
  redactStructuredValue,
  redactStructuredValueWithNumericTelemetry,
} from './bounded-structured.js'
export { redactSensitiveText, redactSensitiveUrls } from './secret-sanitizer.js'

export function redactProfile(profile: Readonly<AgentProfile>): Readonly<AgentProfile> {
  const modelMetadata = publicModelMetadata(profile.model?.metadata)
  return removeProfileMetadata(
    redactStructuredValueWithNumericTelemetry(profile, undefined, { maxBytes: MAX_PROFILE_BYTES }),
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
  const isAnalysisEvent = analysisEvent(event)
  const redacted = redactStructuredValueWithNumericTelemetry(
    event,
    undefined,
    importEvent
      ? { maxDepth: 32, maxItems: 500_000, maxBytes: MAX_CONVERSATION_IMPORT_EVENT_BYTES }
      : isAnalysisEvent
        ? { maxItems: 100_000, maxBytes: MAX_ANALYSIS_EVENT_BYTES }
        : { maxItems: 20_000 },
  ) as T
  if (isAnalysisEvent) {
    if (!analysisEvent(redacted) || !sameSourceIds(event.analysis, redacted.analysis)) {
      throw new RangeError('Analysis source identifiers exceed the bounded event payload')
    }
    if (Buffer.byteLength(JSON.stringify(redacted), 'utf8') > MAX_ANALYSIS_EVENT_BYTES) {
      throw new RangeError('Analysis event exceeds the bounded event payload')
    }
  }
  return redacted
}
