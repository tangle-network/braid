import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  redactStructuredValueWithNumericTelemetry,
  STRUCTURED_REDACTION_MARKER,
} from './bounded-structured.js'
import {
  connectionCredentialReferenceProblem,
  isModelCredentialSource,
} from './connection-credential-references.js'
import type { AnalysisRecord } from './entities.js'
import { isEventId, isMessageId, isMessagePartId } from './ids.js'
import { persistedContextTransferEventRequest } from './portable-context-persistence.js'
import { providerCause, safeDiagnostic } from './provider-values.js'

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

/**
 * An error's own words, through the one credential redactor and bounded to one line.
 *
 * A typed error leads with its code. Collapsing every message that was not a bare code to
 * `PROVIDER_ERROR` hid causes: LIVE-07's exit printed only `PROVIDER_ERROR` for a latched storage
 * failure whose message named the run and the refused write. A `SyntaxError` keeps only its code:
 * `JSON.parse` quotes the rejected source text, which may hold an unrecognized secret.
 */
export function redactProviderError(error: unknown): string {
  const message =
    error instanceof SyntaxError
      ? ''
      : error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : ''
  const code =
    error instanceof Error ? safeDiagnostic((error as { readonly code?: unknown }).code, '') : ''
  const cause = providerCause(message)
  if (cause === undefined) return code || 'PROVIDER_ERROR'
  return code === '' || cause.startsWith(code) ? cause : `${code}: ${cause}`
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => recordValue(current)?.[key], value)
}

export function redactBraidEvent<T>(event: T): T {
  const canonicalTransfer = persistedContextTransferEventRequest(event)
  const transferPath = canonicalTransfer?.path
  const transfer = canonicalTransfer?.request
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
  if (transferPath !== undefined && transfer !== undefined) {
    const parent = recordValue(valueAtPath(redacted, transferPath.slice(0, -1)))
    const key = transferPath.at(-1)
    if (parent === undefined || key === undefined)
      throw new RangeError('The canonical handoff event wrapper exceeds the durable payload limit')
    parent[key] = transfer
    if (Buffer.byteLength(JSON.stringify(redacted), 'utf8') > MAX_CONVERSATION_IMPORT_EVENT_BYTES)
      throw new RangeError('The canonical handoff event exceeds the durable payload limit')
  }
  restoreConnectionCredentialReferences(event, redacted)
  restoreModelCredentialSource(event, redacted)
  return redacted
}

/**
 * Keep the profile's model credential-source selector in a retained admission.
 *
 * An interactive admission carries the exact start request, including its profile, because Runtime
 * replays that request during recovery. `credentialSource` names how the provider supplies model
 * access ("managed" or "subscription") and never holds a credential, but its field name matches the
 * key-based rule, so redaction alone would replace it with a marker and the journal would refuse it.
 */
function restoreModelCredentialSource(event: unknown, redacted: unknown): void {
  const source = recordValue(event)
  if (source?.kind !== 'run.retained.admitted') return
  const path = ['admission', 'request', 'profile', 'model', 'metadata']
  const value = recordValue(valueAtPath(source, path))?.credentialSource
  if (!isModelCredentialSource(value)) return
  const target = recordValue(valueAtPath(redacted, path))
  if (target !== undefined) target.credentialSource = value
}

/**
 * Keep a saved connection's stored-secret names and model-seat reference in its journal event.
 *
 * Their field names match the key-based redaction rule, so redaction alone would replace them with
 * a marker and the replayed connection would lose its grants. The shared validator proves they hold
 * names and commands only; a record that fails it keeps the marker.
 */
function restoreConnectionCredentialReferences(event: unknown, redacted: unknown): void {
  const source = recordValue(event)
  if (source?.kind !== 'connection.upserted') return
  const connection = recordValue(source.connection)
  const options = recordValue(connection?.providerOptions)
  if (connection === undefined || options === undefined) return
  if (options.secrets === undefined && options.modelCredentials === undefined) return
  if (
    typeof connection.kind !== 'string' ||
    connectionCredentialReferenceProblem(connection.kind, options) !== undefined
  )
    return
  const target = recordValue(recordValue(recordValue(redacted)?.connection)?.providerOptions)
  if (target === undefined) return
  for (const key of ['secrets', 'modelCredentials'] as const) {
    if (options[key] !== undefined) target[key] = structuredClone(options[key])
  }
}
