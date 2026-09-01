import { isCredentialRefId } from './ids.js'
import { redactSensitiveText } from './secret-sanitizer.js'

export const STRUCTURED_REDACTION_MARKER = '[redacted]'
const MAX_DEPTH = 8
const MAX_ITEMS = 256
const MAX_TOTAL_BYTES = 64 * 1024
const MAX_ALLOWED_DEPTH = 32
const MAX_ALLOWED_ITEMS = 500_000
const MAX_ALLOWED_BYTES = 16 * 1024 * 1024
const MAX_KEY_BYTES = 128
const OPAQUE_REFERENCE = /^(?:cred:v1:|sha(?:256|512):)[A-Za-z0-9._:/-]{1,512}$/u
const SAFE_NUMERIC_FIELDS = new Set([
  'inputtokens',
  'outputtokens',
  'reasoningtokens',
  'prompttokens',
  'completiontokens',
  'totaltokens',
  'cachedtokens',
  'cachedprompttokens',
  'cachewritetokens',
  'tokensinput',
  'tokensoutput',
  'maxtokens',
  'maxcompletiontokens',
  'maxoutputtokens',
  'maxreasoningtokens',
  'maxvisibleoutputtokens',
  'maxtotaloutputtokens',
  'mintokens',
  'tokencount',
  'tokenestimate',
])
const SAFE_BOOLEAN_FIELDS = new Set(['tokensknown'])
const SAFE_NAME_LIST_FIELDS = new Set(['secretnames'])

export function isSafeNumericTelemetryField(key: string, value: unknown): value is number {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return (
    SAFE_NUMERIC_FIELDS.has(normalized) &&
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  )
}

export function isSafeBooleanTelemetryField(key: string, value: unknown): value is boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return SAFE_BOOLEAN_FIELDS.has(normalized) && typeof value === 'boolean'
}

/** Accept Runtime's exact aggregate token counter without accepting arbitrary token-shaped data. */
export function isSafeTokenUsageRecord(key: string, value: unknown): value is SafeTokenUsageRecord {
  return safeTokenUsageRecord(key, value) !== undefined
}

interface SafeTokenUsageRecord {
  readonly input: number
  readonly output: number
  readonly tokensKnown?: false
  readonly freshInput?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly cacheBreakdownKnown?: false
}

function safeTokenUsageRecord(key: string, value: unknown): SafeTokenUsageRecord | undefined {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  if ((normalized !== 'tokens' && normalized !== 'tokenusage') || !isRecord(value)) {
    return undefined
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    let fields = 0
    let input: number | undefined
    let output: number | undefined
    let tokensKnown: false | undefined
    let freshInput: number | undefined
    let cacheRead: number | undefined
    let cacheWrite: number | undefined
    let cacheBreakdownKnown: false | undefined
    for (const field in value) {
      if (!Object.prototype.propertyIsEnumerable.call(value, field)) continue
      if (
        field !== 'input' &&
        field !== 'output' &&
        field !== 'tokensKnown' &&
        field !== 'freshInput' &&
        field !== 'cacheRead' &&
        field !== 'cacheWrite' &&
        field !== 'cacheBreakdownKnown'
      )
        return undefined
      fields += 1
      if (fields > 7) return undefined
      const fieldValue = value[field]
      if (field === 'tokensKnown') {
        if (fieldValue !== false) return undefined
        tokensKnown = false
        continue
      }
      if (field === 'cacheBreakdownKnown') {
        if (fieldValue !== false) return undefined
        cacheBreakdownKnown = false
        continue
      }
      const count = fieldValue
      if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return undefined
      if (field === 'input') input = count
      else if (field === 'output') output = count
      else if (field === 'freshInput') freshInput = count
      else if (field === 'cacheRead') cacheRead = count
      else cacheWrite = count
    }
    if (input === undefined || output === undefined) return undefined
    const cacheValues = [freshInput, cacheRead, cacheWrite]
    const cacheFieldCount = cacheValues.filter((entry) => entry !== undefined).length
    if (input > 0 && cacheFieldCount > 0 && cacheFieldCount < 3 && cacheBreakdownKnown !== false)
      return undefined
    if (
      cacheBreakdownKnown !== false &&
      cacheFieldCount === 3 &&
      (freshInput ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) !== input
    )
      return undefined
    return {
      input,
      output,
      ...(tokensKnown === false ? { tokensKnown } : {}),
      ...(freshInput === undefined ? {} : { freshInput }),
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWrite }),
      ...(cacheBreakdownKnown === false ? { cacheBreakdownKnown } : {}),
    }
  } catch {
    return undefined
  }
}

const sensitiveNamePattern =
  /(?:password|passwd|passphrase|token|secret|credential|authorization|auth(?:entication)?|key|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|signature|cookie|header|query|fragment|nonce|challenge)/iu

export function isSensitiveFieldName(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return sensitiveNamePattern.test(value) || normalized === 'key' || normalized.endsWith('key')
}

export interface StructuredRedactionLimits {
  readonly maxDepth?: number
  readonly maxItems?: number
  readonly maxBytes?: number
  readonly redactionMarker?: string
  readonly stringTransform?: (value: string) => string
}

interface RedactionContext {
  readonly maxDepth: number
  readonly maxBytes: number
  readonly preserveNumericTelemetry: boolean
  readonly redactionMarker: string
  readonly stringTransform: (value: string) => string
  readonly seen: WeakSet<object>
  remainingItems: number
  usedBytes: number
}

function boundedString(value: string, context: RedactionContext): string {
  const remaining = Math.max(0, context.maxBytes - context.usedBytes)
  const sanitized = redactSensitiveText(value, context.maxBytes)
  let output = context.stringTransform(sanitized)
  if (Buffer.byteLength(output, 'utf8') > remaining) {
    const marker = '… [truncated]'
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    const prefixBytes = Math.max(0, remaining - markerBytes)
    let used = 0
    let prefix = ''
    for (const character of output) {
      const size = Buffer.byteLength(character, 'utf8')
      if (used + size > prefixBytes) break
      prefix += character
      used += size
    }
    const boundedMarker = takeUtf8Prefix(marker, Math.max(0, remaining - used))
    output = prefix + boundedMarker
  }
  context.usedBytes = Math.min(
    context.maxBytes,
    context.usedBytes + Buffer.byteLength(output, 'utf8'),
  )
  return output
}

function takeUtf8Prefix(value: string, bytes: number): string {
  if (bytes <= 0) return ''
  if (Buffer.byteLength(value, 'utf8') <= bytes) return value
  let used = 0
  let output = ''
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (used + size > bytes) break
    output += character
    used += size
  }
  return output
}

function boundedKey(value: string, context: RedactionContext): string {
  const sanitized = redactSensitiveText(value, MAX_KEY_BYTES)
  const transformed = context.stringTransform(sanitized)
  const bounded = takeUtf8Prefix(transformed, MAX_KEY_BYTES)
  return bounded.length === 0 ? context.redactionMarker : bounded
}

function sanitize(
  value: unknown,
  key: string | undefined,
  depth: number,
  context: RedactionContext,
): unknown {
  if (context.preserveNumericTelemetry && key && isSafeNumericTelemetryField(key, value)) {
    return value
  }
  if (key && isSafeNameListField(key, value)) {
    return sanitizeNameList(value, context)
  }
  if (key) {
    const tokenUsage = safeTokenUsageRecord(key, value)
    if (tokenUsage !== undefined) return tokenUsage
  }
  if (
    typeof value === 'string' &&
    key &&
    isSensitiveFieldName(key) &&
    !isSafeOpaqueReference(key, value)
  ) {
    return context.redactionMarker
  }
  if (typeof value === 'string') {
    return boundedString(value, context)
  }
  if (key && isSensitiveFieldName(key)) {
    if (typeof value === 'boolean' || value === null) return value
    return context.redactionMarker
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : '[unavailable: number]'
  if (depth >= context.maxDepth) return '[unavailable: depth limit]'
  if (typeof value !== 'object') return '[unavailable]'
  if (value instanceof Uint8Array) return '[unavailable: binary]'
  if (context.seen.has(value)) return '[unavailable: cycle]'
  context.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = []
      let index = 0
      for (; index < value.length; index += 1) {
        if (context.remainingItems <= 0) break
        context.remainingItems -= 1
        output.push(sanitize(value[index], undefined, depth + 1, context))
      }
      if (index < value.length) output.push('[unavailable: item limit]')
      return output
    }
    const output: Record<string, unknown> = {}
    const keyCounts = new Map<string, number>()
    let truncated = false
    for (const childKey in value as Record<string, unknown>) {
      if (!Object.prototype.propertyIsEnumerable.call(value, childKey)) continue
      if (context.remainingItems <= 0) {
        truncated = true
        break
      }
      context.remainingItems -= 1
      const safeKey = boundedKey(childKey, context)
      const outputKey = uniqueKey(safeKey, keyCounts)
      try {
        setOwn(
          output,
          outputKey,
          sanitize((value as Record<string, unknown>)[childKey], childKey, depth + 1, context),
        )
      } catch {
        setOwn(output, outputKey, '[unavailable]')
      }
    }
    if (truncated) setOwn(output, '__braidTruncated', true)
    return output
  } finally {
    context.seen.delete(value)
  }
}

function isSafeNameListField(key: string, value: unknown): value is readonly unknown[] {
  return (
    SAFE_NAME_LIST_FIELDS.has(key.replace(/[^a-z0-9]/giu, '').toLowerCase()) && Array.isArray(value)
  )
}

function sanitizeNameList(
  values: readonly unknown[],
  context: RedactionContext,
): readonly string[] {
  const output: string[] = []
  for (const value of values) {
    if (context.remainingItems <= 0) break
    context.remainingItems -= 1
    if (typeof value !== 'string') continue
    output.push(boundedString(value, context))
  }
  return output
}

function isSafeOpaqueReference(key: string, value: string): boolean {
  if (OPAQUE_REFERENCE.test(value)) return true
  return (
    key.replace(/[^a-z0-9]/giu, '').toLowerCase() === 'credentialref' && isCredentialRefId(value)
  )
}

export function redactStructuredValue(
  value: unknown,
  key?: string,
  limits: StructuredRedactionLimits = {},
): unknown {
  return sanitize(value, key, 0, createContext(limits, false))
}

/** Preserve non-secret numeric usage/configuration while still masking string tokens. */
export function redactStructuredValueWithNumericTelemetry(
  value: unknown,
  key?: string,
  limits: StructuredRedactionLimits = {},
): unknown {
  return sanitize(value, key, 0, createContext(limits, true))
}

function createContext(
  limits: StructuredRedactionLimits,
  preserveNumericTelemetry: boolean,
): RedactionContext {
  const maxItems = boundedLimit(limits.maxItems, MAX_ITEMS, MAX_ALLOWED_ITEMS)
  return {
    maxDepth: boundedLimit(limits.maxDepth, MAX_DEPTH, MAX_ALLOWED_DEPTH),
    maxBytes: boundedLimit(limits.maxBytes, MAX_TOTAL_BYTES, MAX_ALLOWED_BYTES),
    preserveNumericTelemetry,
    redactionMarker: limits.redactionMarker ?? STRUCTURED_REDACTION_MARKER,
    stringTransform: limits.stringTransform ?? identity,
    seen: new WeakSet<object>(),
    remainingItems: maxItems,
    usedBytes: 0,
  }
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(0, Math.floor(value)))
}

function identity(value: string): string {
  return value
}

function uniqueKey(value: string, counts: Map<string, number>): string {
  const count = (counts.get(value) ?? 0) + 1
  counts.set(value, count)
  return count === 1 ? value : `${value}#${String(count)}`
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
