import { redactStructuredValue } from './redaction.js'

const MATERIALIZATION_RECEIPT_LIMITS = Object.freeze({
  maxDepth: 6,
  maxItems: 128,
  maxBytes: 32 * 1024,
})

/** Return the exact secret-safe receipt that Braid stores and hashes. */
export function publicMaterializationReceipt(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return freezeDeep(
    redactStructuredValue(input, undefined, MATERIALIZATION_RECEIPT_LIMITS) as Readonly<
      Record<string, unknown>
    >,
  )
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}
