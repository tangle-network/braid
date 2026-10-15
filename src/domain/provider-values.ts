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
export function providerCause(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const line = redactSensitiveText(value)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (line.length === 0) return undefined
  const characters = Array.from(line)
  if (characters.length <= MAX_PROVIDER_CAUSE_CHARACTERS) return line
  return `${characters.slice(0, MAX_PROVIDER_CAUSE_CHARACTERS - 1).join('').trimEnd()}…`
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
