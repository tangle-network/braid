export const MAX_RPC_LINE_BYTES = 1_048_576
export const MAX_TEXT_BYTES = 262_144
export const MAX_ERROR_BYTES = 4_096
export const MAX_INTERACTION_FIELDS = 1_000
export const MAX_SELECT_OPTIONS = 256
export const MAX_STRUCTURAL_DEPTH = 32
export const MAX_OUTPUT_QUEUE = 256
export const MAX_OUTPUT_QUEUE_BYTES = 8 * 1024 * 1024
export const MAX_ID_BYTES = 4_096
export const MAX_PROVIDER_EVENTS = 10_000
export const MAX_PROVIDER_STREAM_BYTES = 8 * 1024 * 1024
export const MAX_INTERACTION_TIMEOUT_MS = 365 * 24 * 60 * 60 * 1_000

export class BoundError extends Error {
  readonly code = 'BOUND_EXCEEDED'
}

export function assertBoundedString(value: string, label: string, maxBytes = MAX_TEXT_BYTES): void {
  if (utf8Bytes(value) > maxBytes) throw new BoundError(`${label} exceeds the UTF-8 byte limit`)
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function truncateUtf8(value: string, maxBytes = MAX_TEXT_BYTES): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

export function appendUtf8Bounded(
  current: string,
  addition: string,
  maxBytes = MAX_TEXT_BYTES,
): string {
  const remaining = maxBytes - utf8Bytes(current)
  if (remaining <= 0) return current
  return `${current}${truncateUtf8(addition, remaining)}`
}

export function boundedText(value: string, maxBytes = MAX_TEXT_BYTES): string {
  return truncateUtf8(value.replaceAll('\u0000', ''), maxBytes)
}

export interface StructureLimits {
  readonly maxBytes?: number
  readonly maxDepth?: number
  readonly maxArrayLength?: number
  readonly maxObjectKeys?: number
  readonly maxFields?: number
  readonly maxTotalBytes?: number
}

export function assertBoundedStructure(
  value: unknown,
  limits: StructureLimits = {},
  path = '$',
): void {
  const maxBytes = limits.maxBytes ?? MAX_TEXT_BYTES
  const maxDepth = limits.maxDepth ?? MAX_STRUCTURAL_DEPTH
  const maxArrayLength = limits.maxArrayLength ?? MAX_INTERACTION_FIELDS
  const maxObjectKeys = limits.maxObjectKeys ?? MAX_INTERACTION_FIELDS
  const maxFields = limits.maxFields ?? MAX_INTERACTION_FIELDS
  const maxTotalBytes = limits.maxTotalBytes ?? Number.POSITIVE_INFINITY
  const seen = new WeakSet<object>()
  let fieldCount = 0
  let totalBytes = 0
  const addBytes = (value: string, location: string): void => {
    totalBytes += utf8Bytes(value)
    if (totalBytes > maxTotalBytes) {
      throw new BoundError(`${location} exceeds the total UTF-8 byte limit`)
    }
  }

  const visit = (candidate: unknown, depth: number, location: string): void => {
    if (typeof candidate === 'string') {
      addBytes(candidate, location)
      if (utf8Bytes(candidate) > maxBytes) {
        throw new BoundError(`${location} exceeds the UTF-8 byte limit`)
      }
      return
    }
    if (candidate === null || typeof candidate !== 'object') return
    if (depth > maxDepth) throw new BoundError(`${location} exceeds the nesting limit`)
    if (seen.has(candidate)) throw new BoundError(`${location} contains a cycle`)
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      if (candidate.length > maxArrayLength) {
        throw new BoundError(`${location} exceeds the list limit`)
      }
      for (let index = 0; index < candidate.length; index += 1) {
        visit(candidate[index], depth + 1, `${location}[${index}]`)
      }
    } else {
      const entries = Object.entries(candidate)
      if (entries.length > maxObjectKeys) {
        throw new BoundError(`${location} exceeds the object-field limit`)
      }
      fieldCount += entries.length
      if (fieldCount > maxFields) throw new BoundError(`${location} exceeds the field limit`)
      for (const [key, child] of entries) {
        addBytes(key, `${location}.${key}`)
        if (utf8Bytes(key) > maxBytes) throw new BoundError(`${location} has an oversized key`)
        visit(child, depth + 1, `${location}.${key}`)
      }
    }
    seen.delete(candidate)
  }

  visit(value, 0, path)
}

export function redactSensitiveText(
  value: string,
  protectedValues: readonly string[] = [],
  maxBytes = MAX_ERROR_BYTES,
): string {
  // Redaction must happen before truncation. A secret can begin before the
  // output boundary and otherwise leave an identifying prefix behind.
  let safe = sanitizeTerminalText(value).replaceAll('\u0000', '')
  const values = [...new Set(protectedValues.filter((item) => item.length > 0))].sort(
    (left, right) => right.length - left.length,
  )
  for (const secret of values) safe = safe.replaceAll(secret, '<REDACTED>')
  return truncateUtf8(
    safe
      .replace(/(Bearer\s+)[^\s]+/giu, '$1<REDACTED>')
      .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9._-]{8,}\b/gu, '<REDACTED>')
      .replace(
        /((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|authorization)\s*[:=]\s*)([^\s,;}]+)/giu,
        '$1<REDACTED>',
      ),
    maxBytes,
  )
}
import { sanitizeTerminalText } from '../views/shared/sanitize.js'
