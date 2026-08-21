function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON requires finite numbers')
    return Object.is(value, -0) ? 0 : value
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON cannot represent ${typeof value}`)
  }
  if (ancestors.has(value)) throw new TypeError('Canonical JSON cannot represent cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((child) => {
        if (child === undefined) {
          throw new TypeError('Canonical JSON cannot represent undefined array entries')
        }
        return canonicalValue(child, ancestors)
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON requires plain objects')
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, child]) => [key, canonicalValue(child, ancestors)]),
    )
  } finally {
    ancestors.delete(value)
  }
}

/**
 * The canonical text of a value: object keys ordered by code unit, `undefined`
 * members dropped, and every value that has no faithful JSON form refused.
 *
 * Two values that mean different things must not produce the same text, so a
 * non-finite number, a cycle, a class instance, and a bare `undefined` are
 * refused rather than serialized as `null` or as their own enumerable fields.
 * This module reaches for nothing outside the language, so the view layer can
 * use it under the boundary rule that forbids `node:` imports there.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('Canonical JSON cannot represent undefined')
  return JSON.stringify(canonicalValue(value, new Set()))
}
