function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalValue(child)]),
  )
}

/**
 * Canonicalizes a protocol value for stable request identity.
 * The protocol layer owns this small value-only helper so views do not import
 * application or domain modules merely to detect duplicate JSONL requests.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function canonicalDigest(value: unknown): string {
  return canonicalJson(value)
}
