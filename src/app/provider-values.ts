import { safeProviderDiagnostic } from '../domain/provider-values.js'

export {
  finiteNonNegativeNumber,
  optionalFiniteNonNegativeNumber,
  safeDiagnostic,
  safeProviderDiagnostic,
  safePublicIdentifier,
} from '../domain/provider-values.js'

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
