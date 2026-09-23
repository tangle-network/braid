const encoder = new TextEncoder()
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const ANALYSIS_LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  maxItems: 65_536,
  maxDepth: 64,
  maxStringBytes: 64 * 1024,
  maxSpans: 4_096,
  maxTraces: 256,
} as const

export class AnalysisLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnalysisLimitError'
  }
}

interface Frame {
  readonly source: object
  readonly target: object
  readonly keys: readonly string[]
  index: number
  readonly depth: number
}

function stringBytes(value: string): number {
  const bytes = encoder.encode(value).byteLength
  if (bytes > ANALYSIS_LIMITS.maxStringBytes)
    throw new AnalysisLimitError('Analysis string exceeds its byte limit')
  return bytes
}

function assertArrayKeys(keys: readonly string[]): void {
  if (keys.some((key) => PROTOTYPE_KEYS.has(key)))
    throw new AnalysisLimitError('Prototype-sensitive array keys are not supported')
}

/** Clone untrusted JSON-like data without recursion and freeze every level. */
export function boundedCloneAndFreeze<T>(value: T): T {
  let bytes = 0
  let items = 0
  const count = (amount: number): void => {
    items += amount
    if (items > ANALYSIS_LIMITS.maxItems)
      throw new AnalysisLimitError('Analysis item limit exceeded')
  }
  const addString = (text: string): string => {
    bytes += stringBytes(text)
    if (bytes > ANALYSIS_LIMITS.maxBytes)
      throw new AnalysisLimitError('Analysis byte limit exceeded')
    return text
  }
  const primitive = (item: unknown): unknown => {
    if (typeof item === 'string') return addString(item)
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      if (typeof item === 'number' && !Number.isFinite(item))
        throw new AnalysisLimitError('Analysis value is not finite')
      return item
    }
    return undefined
  }
  const first = primitive(value)
  if (first !== undefined || value === null) return first as T
  if (typeof value !== 'object') throw new AnalysisLimitError('Analysis value is not JSON-like')

  const rootPrototype = Object.getPrototypeOf(value)
  if (rootPrototype !== Object.prototype && rootPrototype !== null && !Array.isArray(value))
    throw new AnalysisLimitError('Analysis value is not a plain object')
  const root = Array.isArray(value) ? [] : (Object.create(null) as Record<string, unknown>)
  const rootKeys = Object.keys(value)
  if (Array.isArray(value)) assertArrayKeys(rootKeys)
  const seen = new Set<object>([value])
  const stack: Frame[] = [
    {
      source: value,
      target: root,
      keys: rootKeys,
      index: 0,
      depth: 0,
    },
  ]
  count(stack[0]?.keys.length ?? 0)
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]
    if (!frame) break
    const key = frame.keys[frame.index]
    if (key === undefined) {
      Object.freeze(frame.target)
      seen.delete(frame.source)
      stack.pop()
      continue
    }
    frame.index += 1
    const child = (frame.source as Record<string, unknown>)[key]
    const childPrimitive = primitive(child)
    addString(key)
    if (childPrimitive !== undefined || child === null) {
      ;(frame.target as Record<string, unknown>)[key] = childPrimitive
      continue
    }
    if (typeof child !== 'object') throw new AnalysisLimitError('Analysis value is not JSON-like')
    if (frame.depth + 1 >= ANALYSIS_LIMITS.maxDepth)
      throw new AnalysisLimitError('Analysis nesting depth limit exceeded')
    if (seen.has(child)) throw new AnalysisLimitError('Analysis value contains a cycle')
    const prototype = Object.getPrototypeOf(child)
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(child))
      throw new AnalysisLimitError('Analysis value is not a plain object')
    const target = Array.isArray(child) ? [] : (Object.create(null) as Record<string, unknown>)
    ;(frame.target as Record<string, unknown>)[key] = target
    const keys = Object.keys(child)
    if (Array.isArray(child)) assertArrayKeys(keys)
    count(keys.length)
    seen.add(child)
    stack.push({ source: child, target, keys, index: 0, depth: frame.depth + 1 })
  }
  return root as T
}

export function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}
