import { toJsonValue, type JsonObject, type JsonValue } from './serialization.js'

const MAX_DIAGNOSTIC_BYTES = 4_096
const MAX_DIAGNOSTIC_MESSAGE = 1_024
const MAX_DIAGNOSTIC_INPUT = 4_096
const secretPatterns = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;}]+/giu,
]

export interface BoundedDiagnostic {
  readonly code: string
  readonly message: string
  readonly details?: JsonObject
}

export function sanitizeDiagnosticText(value: unknown, fallback = 'Operation failed'): string {
  const safeFallback = fallback.slice(0, MAX_DIAGNOSTIC_INPUT) || 'Operation failed'
  let message = typeof value === 'string' ? value.slice(0, MAX_DIAGNOSTIC_INPUT) : safeFallback
  for (const pattern of secretPatterns) message = message.replace(pattern, '<redacted-secret>')
  message = [...message]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code <= 0x1f || code === 0x7f ? ' ' : character
    })
    .join('')
    .trim()
  if (!message) message = safeFallback
  return message.length > MAX_DIAGNOSTIC_MESSAGE
    ? `${message.slice(0, MAX_DIAGNOSTIC_MESSAGE - 1)}…`
    : message
}

function sanitizeJson(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return '<redacted-depth>'
  if (typeof value === 'string') return sanitizeDiagnosticText(value, '<redacted>')
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeJson(item, depth + 1))
  if (typeof value !== 'object') return '<redacted>'
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    if (count >= 64) break
    result[sanitizeDiagnosticText(key, '<field>')] = sanitizeJson(
      (value as Record<string, unknown>)[key],
      depth + 1,
    )
    count += 1
  }
  return result
}

export function diagnosticFor(
  error: unknown,
  code: string,
  fallback = 'Operation failed',
): BoundedDiagnostic {
  const source = error as { readonly message?: unknown; readonly details?: unknown }
  const message = sanitizeDiagnosticText(source?.message, fallback)
  const details = source?.details === undefined ? undefined : sanitizeJson(source.details)
  const result =
    details === undefined ? { code, message } : { code, message, details: details as JsonObject }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_DIAGNOSTIC_BYTES)
    return { code, message: sanitizeDiagnosticText(message.slice(0, 256), fallback) }
  return result
}

export function sanitizeRegistryValue<T>(value: T): T {
  return toJsonValue(sanitizeJson(value)) as T
}
