/**
 * Provider-supplied text and values cross into views, receipts, and storage, so
 * a provider that echoes a request header or an environment value would persist
 * a live secret in Braid's own artifacts. Every provider string is redacted and
 * length-bounded here before any consumer sees it; secret-shaped values are
 * replaced rather than truncated, because a truncated secret is still a leak of
 * its prefix.
 */

const REDACTED = '[redacted]'

/**
 * Stored provider text carries no control or bidi characters at all. This is a
 * stricter rule than terminal rendering needs: a receipt is compared, diffed, and
 * replayed, so an invisible reordering character would make two different strings
 * look identical to a reviewer.
 */
const BIDI_CONTROLS = /\p{Bidi_Control}/gu
const BIDI_CHARACTER = /\p{Bidi_Control}/u

export function containsControlCharacters(value: string): boolean {
  if (BIDI_CHARACTER.test(value)) return true
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function stripControlCharacters(value: string): string {
  return [...value]
    .map((character) => (containsControlCharacters(character) ? ' ' : character))
    .join('')
}

/** Longest provider message Braid stores or displays. */
export const MAX_PROVIDER_MESSAGE_LENGTH = 512

/** Longest provider-normalized value Braid stores in a receipt. */
export const MAX_PROVIDER_VALUE_LENGTH = 1_024

/** Most keys Braid retains from a provider-normalized value map. */
export const MAX_PROVIDER_VALUE_ENTRIES = 128

const SECRET_KEY =
  /(?:token|secret|password|passwd|api[-_]?key|authorization|bearer|private[-_]?key|credential|cookie|session[-_]?id|signature)/iu

const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/giu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/giu,
  /\bBearer\s+[\w.~+/-]+=*/giu,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/giu,
  /\bsk-[A-Za-z0-9_-]{8,}/giu,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/giu,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/giu,
  /\bAKIA[A-Z0-9]{8,}/giu,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/giu,
  /(?<=\b(?:authorization|token|secret|password|passwd|api[-_]?key|apikey|bearer|credential|cookie)\b\s*[:=]\s*)(?:"[^"\n]{1,512}"|'[^'\n]{1,512}'|[^\s,;&"']{1,512})/giu,
  /(?<=[?&](?:access_token|token|api_key|apikey|key|secret|signature|sig)=)[^\s&#]{1,512}/giu,
])

function replaceKnownSecrets(value: string, secrets: readonly string[]): string {
  return [...new Set(secrets)]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((current, secret) => current.split(secret).join(REDACTED), value)
}

/** True when a key names secret material regardless of the value it carries. */
export function isSecretBearingKey(key: string): boolean {
  return SECRET_KEY.test(key)
}

/**
 * Redact secret-shaped substrings, strip control and bidi characters, and bound
 * the result. Returns `undefined` when nothing printable survives.
 */
export function redactProviderText(
  value: string,
  maxLength = MAX_PROVIDER_MESSAGE_LENGTH,
  secrets: readonly string[] = [],
): string | undefined {
  let redacted = replaceKnownSecrets(value, secrets).replace(BIDI_CONTROLS, '')
  redacted = stripControlCharacters(redacted)
  for (const pattern of SECRET_VALUE_PATTERNS) redacted = redacted.replace(pattern, REDACTED)
  const collapsed = redacted.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return undefined
  return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, maxLength)}…`
}

/** Convert any caught provider or protocol error to safe, bounded text. */
export function redactErrorMessage(error: unknown, secrets: readonly string[] = []): string {
  const raw =
    error instanceof Error
      ? error.message
      : error !== null &&
          typeof error === 'object' &&
          'message' in error &&
          typeof (error as { message?: unknown }).message === 'string'
        ? (error as { message: string }).message
        : String(error)
  return redactProviderText(raw, 512, secrets) ?? 'The operation failed'
}

/**
 * Redact one provider-normalized value tree. Keys that name secret material lose
 * their value outright; strings are redacted and bounded; values outside the JSON
 * domain become a marker so a receipt can never carry an opaque object graph.
 */
export function redactProviderValue(
  value: unknown,
  depth = 0,
  secrets: readonly string[] = [],
  ancestors: ReadonlySet<object> = new Set(),
): unknown {
  if (depth > 8) return REDACTED
  if (value === undefined) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED
  if (typeof value === 'string') {
    return redactProviderText(value, MAX_PROVIDER_VALUE_LENGTH, secrets) ?? ''
  }
  if (Array.isArray(value)) {
    let length: unknown
    let keys: string[]
    try {
      length = Object.getOwnPropertyDescriptor(value, 'length')?.value
      keys = Object.keys(value)
    } catch {
      return REDACTED
    }
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length > MAX_PROVIDER_VALUE_ENTRIES ||
      keys.length !== length ||
      keys.some((key, index) => key !== String(index))
    ) {
      return REDACTED
    }
    if (ancestors.has(value)) return REDACTED
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(value)
    return keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        return REDACTED
      }
      return redactProviderValue(descriptor.value, depth + 1, secrets, nextAncestors)
    })
  }
  if (typeof value !== 'object') return REDACTED
  if (ancestors.has(value)) return REDACTED
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  const material: Record<string, unknown> = {}
  let keys: string[]
  try {
    keys = Object.keys(value).slice(0, MAX_PROVIDER_VALUE_ENTRIES)
  } catch {
    return REDACTED
  }
  for (const key of keys) {
    const safeKey = redactProviderText(key, 256) ?? REDACTED
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    Object.defineProperty(material, safeKey, {
      value:
        isSecretBearingKey(key) ||
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
          ? REDACTED
          : redactProviderValue(descriptor.value, depth + 1, secrets, nextAncestors),
      enumerable: true,
    })
  }
  return material
}

/** Redact a provider-normalized value map for storage in a receipt. */
export function redactProviderValues(
  values: Readonly<Record<string, unknown>>,
  secrets: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const redacted = redactProviderValue(values, 0, secrets)
  if (redacted === null || typeof redacted !== 'object' || Array.isArray(redacted)) {
    return Object.freeze({})
  }
  return Object.freeze(redacted as Record<string, unknown>)
}

/** True when the text still contains a secret-shaped substring after redaction. */
export function containsSecretShape(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}
