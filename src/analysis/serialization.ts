export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Reject unsupported values before an analysis record crosses a storage boundary. */
export function toJsonValue(value: unknown, path = '$', seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`)
    return value
  }
  if (value === undefined) throw new TypeError(`${path} contains undefined`)
  if (typeof value !== 'object') throw new TypeError(`${path} contains a non-JSON value`)
  if (seen.has(value)) throw new TypeError(`${path} contains a cycle`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).some((key) => PROTOTYPE_KEYS.has(key)))
        throw new TypeError(`${path} contains prototype-sensitive array keys`)
      return value.map((item, index) => toJsonValue(item, `${path}[${index}]`, seen))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null)
      throw new TypeError(`${path} contains a non-plain object`)
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) result[key] = toJsonValue(child, `${path}.${key}`, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(toJsonValue(value))) as T
}
