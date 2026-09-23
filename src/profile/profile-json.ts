/**
 * Bounded profile JSON intake.
 *
 * `JSON.parse` accepts duplicate object keys and keeps the last one, so a
 * profile Braid validates can differ from the same bytes read by another
 * parser: the digest and the provider's behavior then disagree. It also has no
 * byte, depth, or node ceiling, so a hostile or generated file can exhaust
 * memory or the reviver stack before validation runs. This parser rejects both
 * classes at the intake boundary instead of after they became state.
 */

export interface ProfileJsonLimits {
  readonly maxBytes: number
  readonly maxDepth: number
  readonly maxNodes: number
  readonly maxStringLength: number
  readonly maxEntries: number
}

/**
 * Ceilings sized for hand-authored and generator-produced profiles. A profile
 * that legitimately exceeds them is a different artifact class and needs an
 * explicit, reviewed limit rather than an unbounded read.
 */
export const PROFILE_JSON_LIMITS: ProfileJsonLimits = Object.freeze({
  maxBytes: 1_048_576,
  maxDepth: 64,
  maxNodes: 50_000,
  maxStringLength: 262_144,
  maxEntries: 4_096,
})

export class ProfileJsonLimitError extends Error {
  readonly limit: keyof ProfileJsonLimits

  constructor(limit: keyof ProfileJsonLimits, message: string) {
    super(message)
    this.name = 'ProfileJsonLimitError'
    this.limit = limit
  }
}

export class DuplicateProfileJsonKeyError extends Error {
  readonly key: string

  constructor(key: string, path: string) {
    super(`Profile JSON has a duplicate key ${JSON.stringify(key)} at ${path}`)
    this.name = 'DuplicateProfileJsonKeyError'
    this.key = key
  }
}

export function assertProfileJsonLimits(limits: ProfileJsonLimits): void {
  const bounded =
    Number.isSafeInteger(limits.maxBytes) &&
    limits.maxBytes > 0 &&
    limits.maxBytes <= 16 * 1_048_576 &&
    Number.isSafeInteger(limits.maxDepth) &&
    limits.maxDepth > 0 &&
    limits.maxDepth <= 256 &&
    Number.isSafeInteger(limits.maxNodes) &&
    limits.maxNodes > 0 &&
    limits.maxNodes <= 1_000_000 &&
    Number.isSafeInteger(limits.maxStringLength) &&
    limits.maxStringLength > 0 &&
    limits.maxStringLength <= 1_048_576 &&
    Number.isSafeInteger(limits.maxEntries) &&
    limits.maxEntries > 0 &&
    limits.maxEntries <= 100_000
  if (!bounded) throw new Error('Profile JSON limits must be finite, positive, and bounded')
}

interface ValueCloneState {
  readonly limits: ProfileJsonLimits
  readonly ancestors: Set<object>
  readonly allowUndefined: boolean
  nodes: number
}

interface ParseState {
  readonly text: string
  readonly limits: ProfileJsonLimits
  index: number
  nodes: number
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r'])

export function assertProfileJsonByteLimit(
  bytes: Uint8Array,
  limits: ProfileJsonLimits = PROFILE_JSON_LIMITS,
): void {
  assertProfileJsonLimits(limits)
  if (bytes.byteLength > limits.maxBytes) {
    throw new ProfileJsonLimitError(
      'maxBytes',
      `Profile source is ${bytes.byteLength} bytes; the limit is ${limits.maxBytes}`,
    )
  }
}

/**
 * Copy a programmatic JSON value through the same limits as textual intake.
 *
 * Callers can reach profile validation without ever producing JSON text, so a
 * bounded parser alone is not enough.  This copy rejects accessors, symbols,
 * exotic prototypes, cycles, sparse arrays, and unbounded containers before
 * the canonical schema or digest code sees the value.
 */
export function cloneBoundedProfileValue(
  value: unknown,
  limits: ProfileJsonLimits = PROFILE_JSON_LIMITS,
  options: { readonly allowUndefined?: boolean } = {},
): unknown {
  assertProfileJsonLimits(limits)
  const state: ValueCloneState = {
    limits,
    ancestors: new Set(),
    allowUndefined: options.allowUndefined === true,
    nodes: 0,
  }
  const cloned = cloneValue(value, 1, 'root', state)
  let bytes: number
  try {
    bytes = new TextEncoder().encode(JSON.stringify(cloned)).byteLength
  } catch {
    throw new ProfileJsonLimitError('maxBytes', 'Profile value is not JSON serializable')
  }
  assertProfileJsonByteLimit(new Uint8Array(bytes), limits)
  return cloned
}

/** Copy a JSON value through the same bounds and freeze every copied container. */
export function freezeBoundedProfileValue<T>(
  value: T,
  limits: ProfileJsonLimits = PROFILE_JSON_LIMITS,
): T {
  const cloned = cloneBoundedProfileValue(value, limits)
  const freeze = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== 'object') return candidate
    for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child)
    return Object.freeze(candidate)
  }
  return freeze(cloned) as T
}

function cloneValue(value: unknown, depth: number, path: string, state: ValueCloneState): unknown {
  state.nodes += 1
  if (state.nodes > state.limits.maxNodes) {
    throw new ProfileJsonLimitError(
      'maxNodes',
      `Profile value has more than ${state.limits.maxNodes} values`,
    )
  }
  if (depth > state.limits.maxDepth) {
    throw new ProfileJsonLimitError(
      'maxDepth',
      `Profile value nests deeper than ${state.limits.maxDepth} levels`,
    )
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > state.limits.maxStringLength) {
      throw new ProfileJsonLimitError(
        'maxStringLength',
        `Profile value at ${path} is longer than ${state.limits.maxStringLength} characters`,
      )
    }
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Profile value at ${path} is not finite`)
    return value
  }
  if (value === undefined) {
    if (state.allowUndefined) return undefined
    throw new Error(`Profile value at ${path} is undefined`)
  }
  if (typeof value !== 'object') throw new Error(`Profile value at ${path} is not JSON data`)
  if (state.ancestors.has(value)) throw new Error(`Profile value at ${path} must be acyclic`)
  state.ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > state.limits.maxEntries) {
        throw new ProfileJsonLimitError(
          'maxEntries',
          `Profile array at ${path} has more than ${state.limits.maxEntries} entries`,
        )
      }
      const keys = Reflect.ownKeys(value)
      for (const key of keys) {
        if (typeof key === 'symbol') {
          throw new Error(`Profile array at ${path} has symbol properties`)
        }
        if (key === 'length') continue
        if (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
          throw new Error(`Profile array at ${path} has unsupported properties`)
        }
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor?.get !== undefined || descriptor?.set !== undefined) {
          throw new Error(`Profile array at ${path}/${index} has an accessor`)
        }
        if (descriptor === undefined) throw new Error(`Profile array at ${path} is sparse`)
        if (!descriptor.enumerable) {
          throw new Error(`Profile array at ${path}/${index} has a hidden property`)
        }
        return cloneValue(descriptor.value, depth + 1, `${path}/${index}`, state)
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`Profile value at ${path} must be a plain JSON object`)
    }
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key !== 'string')) {
      throw new Error(`Profile object at ${path} has symbol keys`)
    }
    const stringKeys = keys as string[]
    if (stringKeys.length > state.limits.maxEntries) {
      throw new ProfileJsonLimitError(
        'maxEntries',
        `Profile object at ${path} has more than ${state.limits.maxEntries} keys`,
      )
    }
    const material = Object.create(null) as Record<string, unknown>
    for (const key of stringKeys) {
      if (key.length > state.limits.maxStringLength) {
        throw new ProfileJsonLimitError(
          'maxStringLength',
          `Profile key at ${path} is longer than ${state.limits.maxStringLength} characters`,
        )
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable) {
        throw new Error(`Profile property ${path}.${key} is hidden`)
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new Error(`Profile property ${path}.${key} has an accessor`)
      }
      if (descriptor.value === undefined) continue
      Object.defineProperty(material, key, {
        value: cloneValue(descriptor.value, depth + 1, `${path}.${key}`, state),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return material
  } finally {
    state.ancestors.delete(value)
  }
}

/**
 * Parse profile JSON with explicit bounds and duplicate-key rejection. The
 * result contains only null-prototype objects so a later structured edit cannot
 * reach `Object.prototype` through a parsed key.
 */
export function parseBoundedProfileJson(
  text: string,
  limits: ProfileJsonLimits = PROFILE_JSON_LIMITS,
): unknown {
  assertProfileJsonLimits(limits)
  assertProfileJsonByteLimit(new TextEncoder().encode(text), limits)
  const state: ParseState = { text, limits, index: 0, nodes: 0 }
  skipWhitespace(state)
  const value = parseValue(state, 1, '')
  skipWhitespace(state)
  if (state.index !== text.length) {
    throw new SyntaxError(`Unexpected profile JSON content at offset ${state.index}`)
  }
  return value
}

function skipWhitespace(state: ParseState): void {
  while (state.index < state.text.length) {
    const character = state.text[state.index]
    if (character === undefined || !WHITESPACE.has(character)) return
    state.index += 1
  }
}

function countNode(state: ParseState): void {
  state.nodes += 1
  if (state.nodes > state.limits.maxNodes) {
    throw new ProfileJsonLimitError(
      'maxNodes',
      `Profile JSON has more than ${state.limits.maxNodes} values`,
    )
  }
}

function assertDepth(state: ParseState, depth: number): void {
  if (depth > state.limits.maxDepth) {
    throw new ProfileJsonLimitError(
      'maxDepth',
      `Profile JSON nests deeper than ${state.limits.maxDepth} levels`,
    )
  }
}

function parseValue(state: ParseState, depth: number, path: string): unknown {
  countNode(state)
  assertDepth(state, depth)
  const character = state.text[state.index]
  if (character === undefined) throw new SyntaxError('Profile JSON ended before a value')
  if (character === '{') return parseObject(state, depth, path)
  if (character === '[') return parseArray(state, depth, path)
  if (character === '"') return parseString(state)
  return parseLiteral(state)
}

function parseObject(state: ParseState, depth: number, path: string): Record<string, unknown> {
  state.index += 1
  const material = Object.create(null) as Record<string, unknown>
  const seen = new Set<string>()
  skipWhitespace(state)
  if (state.text[state.index] === '}') {
    state.index += 1
    return material
  }
  for (;;) {
    skipWhitespace(state)
    if (state.text[state.index] !== '"') {
      throw new SyntaxError(`Profile JSON expected an object key at offset ${state.index}`)
    }
    const key = parseString(state)
    if (seen.has(key))
      throw new DuplicateProfileJsonKeyError(key, path === '' ? 'the root object' : path)
    seen.add(key)
    if (seen.size > state.limits.maxEntries) {
      throw new ProfileJsonLimitError(
        'maxEntries',
        `Profile JSON object has more than ${state.limits.maxEntries} keys`,
      )
    }
    skipWhitespace(state)
    if (state.text[state.index] !== ':') {
      throw new SyntaxError(`Profile JSON expected ':' at offset ${state.index}`)
    }
    state.index += 1
    skipWhitespace(state)
    const value = parseValue(state, depth + 1, `${path}/${key}`)
    Object.defineProperty(material, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    skipWhitespace(state)
    const next = state.text[state.index]
    if (next === ',') {
      state.index += 1
      continue
    }
    if (next === '}') {
      state.index += 1
      return material
    }
    throw new SyntaxError(`Profile JSON expected ',' or '}' at offset ${state.index}`)
  }
}

function parseArray(state: ParseState, depth: number, path: string): unknown[] {
  state.index += 1
  const values: unknown[] = []
  skipWhitespace(state)
  if (state.text[state.index] === ']') {
    state.index += 1
    return values
  }
  for (;;) {
    skipWhitespace(state)
    values.push(parseValue(state, depth + 1, `${path}/${values.length}`))
    if (values.length > state.limits.maxEntries) {
      throw new ProfileJsonLimitError(
        'maxEntries',
        `Profile JSON array has more than ${state.limits.maxEntries} entries`,
      )
    }
    skipWhitespace(state)
    const next = state.text[state.index]
    if (next === ',') {
      state.index += 1
      continue
    }
    if (next === ']') {
      state.index += 1
      return values
    }
    throw new SyntaxError(`Profile JSON expected ',' or ']' at offset ${state.index}`)
  }
}

function parseString(state: ParseState): string {
  const start = state.index
  state.index += 1
  for (;;) {
    const character = state.text[state.index]
    if (character === undefined) throw new SyntaxError('Profile JSON string is unterminated')
    if (character === '\\') {
      state.index += 2
      continue
    }
    if (character === '"') {
      state.index += 1
      break
    }
    state.index += 1
  }
  const raw = state.text.slice(start, state.index)
  const value = JSON.parse(raw) as string
  if (value.length > state.limits.maxStringLength) {
    throw new ProfileJsonLimitError(
      'maxStringLength',
      `Profile JSON string is longer than ${state.limits.maxStringLength} characters`,
    )
  }
  return value
}

const LITERAL_END = new Set([',', '}', ']', ' ', '\t', '\n', '\r'])

function parseLiteral(state: ParseState): unknown {
  const start = state.index
  while (state.index < state.text.length) {
    const character = state.text[state.index]
    if (character !== undefined && LITERAL_END.has(character)) break
    state.index += 1
  }
  const raw = state.text.slice(start, state.index)
  if (raw.length === 0) throw new SyntaxError(`Profile JSON expected a value at offset ${start}`)
  return JSON.parse(raw) as unknown
}
