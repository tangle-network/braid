import { canonicalCandidateDigest, canonicalCandidateJson } from '@tangle-network/agent-interface'
import { cloneBoundedProfileValue } from '../profile/profile-json.js'

/**
 * Braid never orders canonical keys itself. RFC 8785 ordering and digesting are
 * owned by the canonical package so a Braid-reported representation cannot
 * diverge from the digest a provider or runtime computes for the same value.
 * Only undefined-entry removal happens here, matching canonical profile
 * normalization, because Braid composes receipt values from optional fields.
 */
function canonicalValue(
  value: unknown,
  path: readonly string[],
  ancestors: ReadonlySet<object> = new Set(),
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`Canonical value ${renderPath(path)} is not finite`)
    return value
  }
  if (typeof value !== 'object') {
    throw new Error(`Canonical value ${renderPath(path)} is not JSON serializable`)
  }
  if (ancestors.has(value)) {
    throw new Error(`Canonical value ${renderPath(path)} must be acyclic`)
  }
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  if (Array.isArray(value)) {
    return Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) {
        throw new Error(`Canonical value ${renderPath([...path, String(index)])} cannot be sparse`)
      }
      const entry = value[index]
      if (entry === undefined) {
        throw new Error(
          `Canonical value ${renderPath([...path, String(index)])} cannot be undefined`,
        )
      }
      return canonicalValue(entry, [...path, String(index)], nextAncestors)
    })
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Canonical value ${renderPath(path)} must be a plain JSON object`)
  }
  const material: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue
    Object.defineProperty(material, key, {
      value: canonicalValue(entry, [...path, key], nextAncestors),
      enumerable: true,
    })
  }
  return material
}

function renderPath(path: readonly string[]): string {
  return path.length === 0 ? 'root' : path.join('.')
}

/** RFC 8785 serialization from the canonical package, after undefined removal. */
export function canonicalJson(value: unknown): string {
  return canonicalCandidateJson(
    canonicalValue(cloneBoundedProfileValue(value, undefined, { allowUndefined: true }), []),
  )
}

/** Canonical `sha256:<hex>` identity for any Braid receipt or ledger value. */
export function canonicalDigest(value: unknown): string {
  return canonicalCandidateDigest(
    canonicalValue(cloneBoundedProfileValue(value, undefined, { allowUndefined: true }), []),
  )
}
