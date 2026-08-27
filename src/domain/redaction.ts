import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  isSensitiveFieldName,
  redactSensitiveText,
  redactSensitiveUrls,
} from './incremental-sanitizer.js'

export { isSensitiveFieldName, redactSensitiveText, redactSensitiveUrls }

export function redactStructuredValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveFieldName(key)) return '[redacted]'
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item))

  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactStructuredValue(child, childKey),
    ]),
  )
}

export function redactProfile(profile: Readonly<AgentProfile>): Readonly<AgentProfile> {
  return redactStructuredValue(profile) as Readonly<AgentProfile>
}

export function redactProviderError(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.message)
  if (typeof error === 'string') return redactSensitiveText(error)
  return 'Provider error'
}

/**
 * Sanitizes every string a journal event carries without collapsing structure.
 *
 * Braid builds canonical domain records itself, so blanking a value because its
 * key reads as sensitive would destroy legitimate records such as
 * `profile.registered` or `credential.reference.created`, both of which already
 * carry references and digests rather than secret material. Provider-authored
 * text is the untrusted part, and it is always a string, so control sequences,
 * bidi overrides, credential URLs, and bearer values are stripped in place.
 */
export function redactBraidEvent<T>(event: T): T {
  return sanitizeStrings(event) as T
}

function sanitizeStrings(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sanitizeStrings)
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, sanitizeStrings(child)]),
  )
}
