import type { BraidRun } from './entities-messages.js'
import { redactSensitiveText } from './secret-sanitizer.js'
import { containsUnsafeControlCharacter } from './text.js'

export const SENSITIVE_DIAGNOSTIC =
  /(?:secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key|session(?:[_-]?key)?|access[_-]?key|client[_-]?secret|signature|signed[_-]?url|nonce)/iu
const SAFE_DIAGNOSTIC = /^[A-Z][A-Z0-9._:-]{0,63}$/u
const TYPED_PROVIDER_DIAGNOSTIC = /^[A-Z][A-Z0-9]*(?:[._][A-Z0-9]+)*$/u
const SAFE_PUBLIC_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u

export function finiteNonNegativeNumber(value: unknown): number
export function finiteNonNegativeNumber(value: unknown): number {
  return optionalFiniteNonNegativeNumber(value) ?? 0
}

export function optionalFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function safePublicIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return SAFE_PUBLIC_IDENTIFIER.test(text) && !SENSITIVE_DIAGNOSTIC.test(text) ? text : undefined
}

export function safeDiagnostic(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (
    text.length === 0 ||
    !SAFE_DIAGNOSTIC.test(text) ||
    containsUnsafeControlCharacter(text) ||
    SENSITIVE_DIAGNOSTIC.test(text)
  ) {
    return fallback
  }
  return text
}

/** A cause is one line a person reads in the transcript, not a log. */
export const MAX_PROVIDER_CAUSE_CHARACTERS = 400

/**
 * Keep a provider's own failure text so Braid can say why a run failed in plain words.
 *
 * The whole text passes the shared credential redactor before the length bound, so cutting the
 * text can never leave part of a credential behind. Control and format characters become spaces.
 * Returns undefined when nothing readable remains.
 */
function sanitizedProviderCause(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = redactSensitiveText(value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return line.length === 0 ? undefined : line
}

function boundProviderCause(line: string): string {
  const characters = Array.from(line)
  if (characters.length <= MAX_PROVIDER_CAUSE_CHARACTERS) return line
  const kept = characters.slice(0, MAX_PROVIDER_CAUSE_CHARACTERS - 1).join('')
  return `${kept.trimEnd()}…`
}

export function providerCause(value: unknown): string | undefined {
  const line = sanitizedProviderCause(value)
  return line === undefined ? undefined : boundProviderCause(line)
}

const BARE_FAILURE_CODE = /^[A-Z][A-Z0-9]*(?:[._:-][A-Z0-9]+)*$/u
const REDACTION_MARKER = /\[redacted(?: (?:credential|secret|bearer|link))?\]/gu
const CAUSE_EDGE_CHARACTER = /[\p{P}\p{Z}\s]/u
const FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  'failed',
  'failure',
  'error',
  'unknown',
  'blocked',
  'expired',
  'cancelled',
  'canceled',
  'aborted',
])

/** An outcome, a diagnostic code, or redaction markers alone do not explain why a run failed. */
export function hasProviderCause(value: string | undefined): value is string {
  if (value === undefined) return false
  // Redaction and display truncation add markers, not an explanation. Classify what remains.
  // Scan the edges in linear time: unbounded provider text may contain long punctuation runs.
  const characters = Array.from(value.replace(REDACTION_MARKER, ''))
  let start = 0
  let end = characters.length
  while (start < end && CAUSE_EDGE_CHARACTER.test(characters[start] ?? '')) start += 1
  while (end > start && CAUSE_EDGE_CHARACTER.test(characters[end - 1] ?? '')) end -= 1
  const readable = characters.slice(start, end).join('')
  return (
    readable.length > 0 &&
    !BARE_FAILURE_CODE.test(readable) &&
    !FAILURE_OUTCOMES.has(readable.toLowerCase())
  )
}

/** Prefer an informative reason, then the error's cause; retain outcome-only history otherwise. */
export function providerFailureReason(reason: unknown, error: unknown): string | undefined {
  // Classify before the display bound: an ellipsis must not turn a long code into a cause.
  const candidates = [sanitizedProviderCause(reason), sanitizedProviderCause(error)]
  const selected =
    candidates.find(hasProviderCause) ?? candidates.find((value) => value !== undefined)
  return selected === undefined ? undefined : boundProviderCause(selected)
}

export function safeProviderDiagnostic(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const text = value.trim()
    const redacted = redactSensitiveText(text)
    if (redacted !== text && redacted.length > 0) return redacted
    if (
      TYPED_PROVIDER_DIAGNOSTIC.test(text) &&
      !containsUnsafeControlCharacter(text) &&
      !SENSITIVE_DIAGNOSTIC.test(text)
    )
      return text
  }
  return fallback
}

const NO_RECORDED_PROVIDER_CAUSE = 'no cause was recorded'

/** The same recorded cause feeds transcript, full state and headless details. */
export function runOutcomeDetail(
  run: Pick<BraidRun, 'status' | 'activity' | 'error' | 'terminalReason'>,
): string | undefined {
  if (run.status === 'unknown') {
    const unknown = run.activity.findLast(
      (item) => item.type === 'lifecycle' && item.label === 'unknown',
    )?.detail
    const detail = [unknown, run.terminalReason, run.error].find(hasProviderCause)
    if (detail !== undefined) return detail
    const code = [unknown, run.error].find(
      (value) => value !== undefined && BARE_FAILURE_CODE.test(value),
    )
    return code === undefined
      ? NO_RECORDED_PROVIDER_CAUSE
      : `${NO_RECORDED_PROVIDER_CAUSE} (${code})`
  }
  if (run.status !== 'failed' && run.status !== 'blocked' && run.status !== 'expired')
    return undefined
  const [first, second] = [run.error, run.terminalReason].filter(hasProviderCause)
  if (first !== undefined) {
    if (second === undefined || first.includes(second)) return first
    return second.includes(first) ? second : `${first}; ${second}`
  }
  return run.error === undefined
    ? NO_RECORDED_PROVIDER_CAUSE
    : `${NO_RECORDED_PROVIDER_CAUSE} (${run.error})`
}
