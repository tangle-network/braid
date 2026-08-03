import { createHash } from 'node:crypto'
import { createDigest, type Digest } from './ids.js'
import type { BraidState } from './state.js'

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

export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new TypeError('Canonical JSON cannot represent undefined')
  return JSON.stringify(canonicalValue(value, new Set()))
}

export function canonicalDigest(value: unknown): Digest {
  return createDigest(createHash('sha256').update(canonicalJson(value)).digest('hex'))
}

/**
 * Checks only product projections. Journal position and diagnostic counters
 * are deliberately excluded so incremental reduction and replay compare the
 * same durable graph even when they reached it through different batches.
 */
export function canonicalProjectionChecksum(state: BraidState): Digest {
  const {
    revision: _revision,
    sequence: _sequence,
    appliedEvents: _appliedEvents,
    projectionChecksum: _projectionChecksum,
    health: _health,
    ...projection
  } = state
  return canonicalDigest(projection)
}
