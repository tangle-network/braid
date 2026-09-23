import { containsControlCharacters } from '../connection/redaction.js'

/**
 * Prototype-safe RFC 6901 pointer access and bounded structured views.
 *
 * Structured editing takes a caller-supplied pointer, so `/metadata/__proto__/x`
 * would otherwise reach `Object.prototype` and pollute every later object in the
 * process. Every container this module creates has a null prototype and every
 * read is an own-property check. The names `constructor`, `prototype`, and
 * `__proto__` are therefore ordinary metadata keys here, never inherited slots.
 */

const MAX_POINTER_LENGTH = 4_096

export interface StructuredProfileEntry {
  readonly path: string
  readonly value: unknown
  readonly kind: 'object' | 'array' | 'scalar'
}

export interface StructuredProfilePage {
  readonly entries: readonly StructuredProfileEntry[]
  readonly offset: number
  readonly limit: number
  readonly totalEntries: number
  readonly truncated: boolean
}

export interface StructuredViewLimits {
  readonly maxDepth: number
  readonly maxEntries: number
  readonly maxStringLength: number
  readonly pageSize: number
}

/**
 * A structured view is a display surface, so it is paged rather than fully
 * materialized: an editor never needs 50k rows at once, and building them all
 * turns a large profile into an allocation spike.
 */
export const STRUCTURED_VIEW_LIMITS: StructuredViewLimits = Object.freeze({
  maxDepth: 64,
  maxEntries: 20_000,
  maxStringLength: 262_144,
  pageSize: 500,
})

function assertStructuredViewLimits(limits: StructuredViewLimits): void {
  if (
    !Number.isSafeInteger(limits.maxDepth) ||
    limits.maxDepth <= 0 ||
    limits.maxDepth > 256 ||
    !Number.isSafeInteger(limits.maxEntries) ||
    limits.maxEntries <= 0 ||
    limits.maxEntries > 100_000 ||
    !Number.isSafeInteger(limits.maxStringLength) ||
    limits.maxStringLength <= 0 ||
    limits.maxStringLength > 1_048_576 ||
    !Number.isSafeInteger(limits.pageSize) ||
    limits.pageSize <= 0 ||
    limits.pageSize > limits.maxEntries
  ) {
    throw new Error('Structured profile view limits are invalid or oversized')
  }
}

export class ForbiddenProfilePointerError extends Error {
  readonly segment: string

  constructor(segment: string, pointer: string) {
    super(`Profile pointer ${pointer} may not address the inherited slot ${segment}`)
    this.name = 'ForbiddenProfilePointerError'
    this.segment = segment
  }
}

export function pointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

export function pointerParts(pointer: string): readonly string[] {
  if (pointer === '') return Object.freeze([])
  if (
    pointer.length > MAX_POINTER_LENGTH ||
    !pointer.startsWith('/') ||
    containsControlCharacters(pointer)
  ) {
    throw new Error(`Invalid profile JSON pointer: ${pointer}`)
  }
  const parts = pointer
    .slice(1)
    .split('/')
    .map((encoded) => {
      let decoded = ''
      for (let index = 0; index < encoded.length; index += 1) {
        const character = encoded[index]
        if (character !== '~') {
          decoded += character
          continue
        }
        const escapeCode = encoded[index + 1]
        if (escapeCode !== '0' && escapeCode !== '1') {
          throw new Error(`Invalid escape in profile JSON pointer: ${pointer}`)
        }
        decoded += escapeCode === '0' ? '~' : '/'
        index += 1
      }
      return decoded
    })
  return Object.freeze(parts)
}

/** Deep copy into null-prototype containers, preserving own metadata keys. */
function detach(
  value: unknown,
  depth: number,
  limits: StructuredViewLimits,
  ancestors: ReadonlySet<object> = new Set(),
  state: { nodes: number } = { nodes: 0 },
): unknown {
  assertStructuredViewLimits(limits)
  state.nodes += 1
  if (state.nodes > limits.maxEntries) {
    throw new Error(`Profile value has more than ${limits.maxEntries} entries`)
  }
  if (depth > limits.maxDepth) {
    throw new Error(`Profile value nests deeper than ${limits.maxDepth} levels`)
  }
  if (typeof value === 'string' && value.length > limits.maxStringLength) {
    throw new Error(`Profile string exceeds ${limits.maxStringLength} characters`)
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Profile numbers must be finite')
    return value
  }
  if (value === undefined || typeof value !== 'object') {
    throw new Error('Profile values must be JSON data')
  }
  if (ancestors.has(value)) throw new Error('Profile value must be acyclic')
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(value)
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
    if (typeof length !== 'number' || !Number.isSafeInteger(length)) {
      throw new Error('Profile arrays must have a safe length')
    }
    if (length > limits.maxEntries) {
      throw new Error(`Profile array has more than ${limits.maxEntries} entries`)
    }
    const keys = Reflect.ownKeys(value)
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          (key !== 'length' && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length)),
      ) ||
      keys.filter((key) => key !== 'length').length !== length
    ) {
      throw new Error('Profile arrays may contain only dense numeric entries')
    }
    return Array.from({ length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        throw new Error('Profile arrays cannot contain accessors or sparse holes')
      }
      return detach(descriptor.value, depth + 1, limits, nextAncestors, state)
    })
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Profile values must be plain JSON objects')
  }
  const material = Object.create(null) as Record<string, unknown>
  const keys = Reflect.ownKeys(value)
  if (keys.length > limits.maxEntries) {
    throw new Error(`Profile object has more than ${limits.maxEntries} entries`)
  }
  for (const key of keys) {
    if (typeof key !== 'string') throw new Error('Profile objects cannot contain symbol keys')
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new Error('Profile objects cannot contain hidden or accessor properties')
    }
    if (descriptor.value === undefined) continue
    Object.defineProperty(material, key, {
      value: detach(descriptor.value, depth + 1, limits, nextAncestors, state),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return material
}

/** Deep copy and recursively freeze, for values handed to a view. */
export function immutableProfileValue<T>(value: T, limits = STRUCTURED_VIEW_LIMITS): T {
  assertStructuredViewLimits(limits)
  const freeze = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== 'object') return candidate
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child)
    return Object.freeze(candidate)
  }
  return freeze(detach(value, 0, limits)) as T
}

function arrayIndex(part: string, pointer: string, length: number): number {
  if (part !== '0' && !/^[1-9][0-9]*$/u.test(part)) {
    throw new Error(`Missing profile array path ${pointer}`)
  }
  const index = Number(part)
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new Error(`Missing profile array path ${pointer}`)
  }
  return index
}

/**
 * Replace the value at `pointer`. Intermediate objects are created only for
 * pointer segments that are not inherited slots, and the whole result is a fresh
 * null-prototype tree so the caller can never mutate the input draft.
 */
export function setAtProfilePointer(
  value: unknown,
  pointer: string,
  replacement: unknown,
  limits: StructuredViewLimits = STRUCTURED_VIEW_LIMITS,
): unknown {
  const parts = pointerParts(pointer)
  if (parts.length === 0) return detach(replacement, 0, limits)
  const root = detach(value, 0, limits)
  let cursor: unknown = root
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]
    if (part === undefined || cursor === null || typeof cursor !== 'object') {
      throw new Error(`Missing profile path ${pointer}`)
    }
    if (Array.isArray(cursor)) {
      cursor = cursor[arrayIndex(part, pointer, cursor.length)]
      continue
    }
    const object = cursor as Record<string, unknown>
    if (!Object.hasOwn(object, part)) {
      Object.defineProperty(object, part, {
        value: Object.create(null),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    cursor = object[part]
  }
  const finalPart = parts.at(-1)
  if (finalPart === undefined || cursor === null || typeof cursor !== 'object') {
    throw new Error(`Missing profile path ${pointer}`)
  }
  const detached = detach(replacement, 0, limits)
  if (Array.isArray(cursor)) {
    cursor[arrayIndex(finalPart, pointer, cursor.length)] = detached
    return root
  }
  Object.defineProperty(cursor as Record<string, unknown>, finalPart, {
    value: detached,
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return root
}

/**
 * Flatten one page of a profile into display rows. Traversal stops at
 * `maxEntries` and reports truncation instead of silently showing a prefix as if
 * it were the whole profile.
 */
export function structuredProfilePage(
  value: unknown,
  options: {
    readonly offset?: number
    readonly limit?: number
    readonly limits?: StructuredViewLimits
  } = {},
): StructuredProfilePage {
  const limits = options.limits ?? STRUCTURED_VIEW_LIMITS
  assertStructuredViewLimits(limits)
  const offset = options.offset ?? 0
  const limit = options.limit ?? limits.pageSize
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1_000_000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > limits.maxEntries
  ) {
    throw new Error('Structured profile page bounds are invalid or oversized')
  }
  const entries: StructuredProfileEntry[] = []
  let visited = 0
  let truncated = false

  const push = (entry: () => StructuredProfileEntry): void => {
    if (visited >= offset && entries.length < limit) entries.push(entry())
    visited += 1
    if (visited >= limits.maxEntries) truncated = true
  }

  const walk = (candidate: unknown, path: string, depth: number): void => {
    if (truncated || depth > limits.maxDepth) {
      truncated = truncated || depth > limits.maxDepth
      return
    }
    if (Array.isArray(candidate)) {
      push(() =>
        Object.freeze({ path, value: immutableProfileValue(candidate, limits), kind: 'array' }),
      )
      for (const [index, child] of candidate.entries()) {
        if (truncated) return
        walk(child, `${path}/${index}`, depth + 1)
      }
      return
    }
    if (candidate !== null && typeof candidate === 'object') {
      push(() =>
        Object.freeze({ path, value: immutableProfileValue(candidate, limits), kind: 'object' }),
      )
      for (const key of Object.keys(candidate)) {
        if (truncated) return
        walk(
          (candidate as Record<string, unknown>)[key],
          `${path}/${pointerSegment(key)}`,
          depth + 1,
        )
      }
      return
    }
    push(() => Object.freeze({ path, value: candidate, kind: 'scalar' }))
  }

  walk(detach(value, 0, limits), '', 0)
  return Object.freeze({
    entries: Object.freeze(entries),
    offset,
    limit,
    totalEntries: visited,
    truncated,
  })
}
