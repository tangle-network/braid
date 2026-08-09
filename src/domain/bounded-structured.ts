import { redactSensitiveText } from './secret-sanitizer.js'
import { isCredentialRefId } from './ids.js'

export const STRUCTURED_REDACTION_MARKER = '[redacted]'
const MAX_DEPTH = 8
const MAX_ITEMS = 256
const MAX_TOTAL_BYTES = 64 * 1024
const OPAQUE_REFERENCE = /^(?:cred:v1:|sha(?:256|512):)[A-Za-z0-9._:/-]{1,512}$/u
const SAFE_NUMERIC_FIELDS = new Set([
  'inputtokens',
  'outputtokens',
  'reasoningtokens',
  'tokensinput',
  'tokensoutput',
  'maxtokens',
  'mintokens',
  'tokencount',
  'tokenestimate',
])

export function isSafeNumericTelemetryField(key: string, value: unknown): value is number {
  const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase()
  return SAFE_NUMERIC_FIELDS.has(normalized) && typeof value === 'number' && Number.isFinite(value)
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
}

interface RedactionContext {
  readonly maxDepth: number
  readonly maxItems: number
  readonly maxBytes: number
  readonly seen: WeakSet<object>
  usedBytes: number
}

function boundedString(value: string, context: RedactionContext): string {
  const remaining = Math.max(0, context.maxBytes - context.usedBytes)
  const bounded = redactSensitiveText(value, context.maxBytes)
  let output = bounded
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

function sanitize(
  value: unknown,
  key: string | undefined,
  depth: number,
  context: RedactionContext,
): unknown {
  if (key && isSensitiveFieldName(key)) {
    if (typeof value === 'boolean' || value === null) return value
    if (typeof value === 'string' && isSafeOpaqueReference(key, value)) return value
    return STRUCTURED_REDACTION_MARKER
  }
  if (typeof value === 'string') return boundedString(value, context)
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
      for (const item of value.slice(0, context.maxItems))
        output.push(sanitize(item, undefined, depth + 1, context))
      if (value.length > context.maxItems) output.push('[unavailable: item limit]')
      return output
    }
    const output: Record<string, unknown> = {}
    let count = 0
    let truncated = false
    for (const childKey of Object.keys(value as Record<string, unknown>)) {
      if (count >= context.maxItems) {
        truncated = true
        break
      }
      try {
        output[childKey] = sanitize(
          (value as Record<string, unknown>)[childKey],
          childKey,
          depth + 1,
          context,
        )
      } catch {
        output[childKey] = '[unavailable]'
      }
      count += 1
    }
    if (truncated) output.__braidTruncated = true
    return output
  } finally {
    context.seen.delete(value)
  }
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
  return sanitize(value, key, 0, {
    maxDepth: limits.maxDepth ?? MAX_DEPTH,
    maxItems: limits.maxItems ?? MAX_ITEMS,
    maxBytes: limits.maxBytes ?? MAX_TOTAL_BYTES,
    seen: new WeakSet<object>(),
    usedBytes: 0,
  })
}

/** Preserve non-secret numeric usage/configuration while still masking string tokens. */
export function redactStructuredValueWithNumericTelemetry(
  value: unknown,
  key?: string,
  limits: StructuredRedactionLimits = {},
): unknown {
  const redacted = redactStructuredValue(value, key, limits)
  restoreNumericTelemetry(value, redacted)
  return redacted
}

function restoreNumericTelemetry(source: unknown, target: unknown): void {
  if (Array.isArray(source) && Array.isArray(target)) {
    const length = Math.min(source.length, target.length)
    for (let index = 0; index < length; index += 1) {
      restoreNumericTelemetry(source[index], target[index])
    }
    return
  }
  if (!isRecord(source) || !isRecord(target)) return
  for (const [childKey, child] of Object.entries(source)) {
    if (isSafeNumericTelemetryField(childKey, child)) {
      target[childKey] = child
      continue
    }
    restoreNumericTelemetry(child, target[childKey])
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
