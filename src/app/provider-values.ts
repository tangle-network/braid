import { providerCause, safeProviderDiagnostic } from '../domain/provider-values.js'
import { providerHttpFailureDiagnostic } from '../domain/runtime-diagnostics.js'

export {
  finiteNonNegativeNumber,
  optionalFiniteNonNegativeNumber,
  providerCause,
  safeDiagnostic,
  safeProviderDiagnostic,
  safePublicIdentifier,
} from '../domain/provider-values.js'

/** A runtime failure keeps its provider HTTP status and error code; other text falls back. */
export function runtimeFailureDiagnostic(value: unknown, fallback: string): string {
  return providerHttpFailureDiagnostic(value) ?? safeProviderDiagnostic(value, fallback)
}

function safeProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key)
  } catch {
    return undefined
  }
}

function nestedRuntimeCode(value: unknown, depth = 0): string {
  if (depth > 4 || typeof value !== 'object' || value === null) return ''
  const code = safeProviderDiagnostic(safeProperty(value, 'code'), '')
  if (code.length > 0) return code
  return nestedRuntimeCode(safeProperty(value, 'cause'), depth + 1)
}

/**
 * Provider payloads are untrusted input to durable state.
 *
 * A runtime may report a diagnostic, a model name, or a token count that
 * carries credential material, control sequences, or a value the journal
 * invariants reject. Everything a provider hands Braid passes through this
 * module before it reaches an event, so a bad provider can degrade a field to
 * a bounded placeholder but can never poison the journal.
 */

export function safeRuntimeDiagnostic(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null) {
    const code = safeProviderDiagnostic(safeProperty(value, 'code'), '')
    if (code.length > 0) {
      const causeCode = nestedRuntimeCode(safeProperty(value, 'cause'))
      if (causeCode.length > 0 && causeCode !== code) {
        return safeProviderDiagnostic(`${code}.${causeCode}`, code)
      }
      return code
    }
    const message = safeProviderDiagnostic(safeProperty(value, 'message'), '')
    if (message.length > 0) return message
    const name = safeProperty(value, 'name')
    if (typeof name === 'string') {
      const typedName = name
        .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
        .replace(/[^A-Za-z0-9._]/gu, '_')
        .toUpperCase()
      const safeName = safeProviderDiagnostic(typedName, '')
      if (safeName.length > 0 && safeName !== 'ERROR') return safeName
    }
  }
  return safeProviderDiagnostic(value, fallback)
}

const PUBLIC_ERROR_TOKEN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u
const TYPED_RUNTIME_CODE = /^[A-Z][A-Z0-9]*(?:[._][A-Z0-9]+)*$/u
const MAX_CAUSE_DEPTH = 4

function publicErrorToken(value: unknown): string | undefined {
  return typeof value === 'string' && PUBLIC_ERROR_TOKEN.test(value) ? value : undefined
}

/**
 * The plain words of a thrown runtime error: its message, the messages of the errors it wraps,
 * and the public code, reason and reset time a capacity refusal carries.
 */
function errorText(value: unknown): string | undefined {
  const parts: string[] = []
  let current = value
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (typeof current === 'string') {
      parts.push(current)
      break
    }
    if (typeof current !== 'object' || current === null) break
    const message = safeProperty(current, 'message')
    if (typeof message === 'string' && message.trim().length > 0) {
      const details = [safeProperty(current, 'code'), safeProperty(current, 'reason')]
        .map(publicErrorToken)
        .filter((token): token is string => token !== undefined && !message.includes(token))
      const resetAt = safeProperty(current, 'resetAt')
      const resets = typeof resetAt === 'string' && isResetTime(resetAt) ? `resets ${resetAt}` : ''
      const suffix = [details.join(', '), resets].filter((part) => part.length > 0).join('; ')
      parts.push(suffix.length === 0 ? message : `${message} (${suffix})`)
    }
    current = safeProperty(current, 'cause')
  }
  const unique = parts.filter((part, index) => !parts.slice(0, index).some((seen) => seen.includes(part)))
  return unique.length === 0 ? undefined : unique.join(': ')
}

function isResetTime(value: string): boolean {
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

/** A thrown runtime failure: its stable code and, when the provider said why, its redacted cause. */
export interface RuntimeFailure {
  readonly code: string
  readonly cause?: string
  /** The cause, followed by a provider code it does not already name; the code alone otherwise. */
  readonly text: string
}

export function runtimeFailure(error: unknown, fallback: string): RuntimeFailure {
  const diagnostic = safeRuntimeDiagnostic(error, '')
  const providerCode = TYPED_RUNTIME_CODE.test(diagnostic) ? diagnostic : ''
  const code = providerCode || fallback
  const cause = providerCause(errorText(error))
  if (cause === undefined || cause === code) return { code, text: code }
  const text = providerCode === '' || cause.includes(providerCode) ? cause : `${cause} (${providerCode})`
  return { code, cause, text }
}
