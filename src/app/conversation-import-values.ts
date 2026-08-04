import { canonicalDigest } from '../domain/canonical.js'
import { type IdForKind, type IdKind, type OperationId, parseId } from '../domain/ids.js'
import { prefixes } from '../domain/ids-core.js'
import { isCanonicalIsoDateTime } from '../domain/text.js'
import { AppError } from './errors.js'

export interface ConversationImportIds {
  id<K extends IdKind>(kind: K, source: unknown, label: string): IdForKind<K>
  derived<K extends IdKind>(kind: K, label: string): IdForKind<K>
}

export function createConversationImportIds(
  operationId: OperationId,
  contentDigest: string,
): ConversationImportIds {
  const remapped = new Map<string, string>()
  const create = <K extends IdKind>(kind: K, source: string): IdForKind<K> => {
    const key = `${kind}:${source}`
    const existing = remapped.get(key)
    if (existing !== undefined) return existing as IdForKind<K>
    const prefix = prefixes[kind][0]
    if (prefix === undefined) throw new AppError('IMPORT_INVALID', `Unsupported import ID ${kind}`)
    const suffix = canonicalDigest({ operationId, contentDigest, kind, source }).slice(0, 40)
    const value = parseId(kind, `${prefix}import-${suffix}`)
    remapped.set(key, value)
    return value
  }
  return {
    id(kind, source, label) {
      try {
        return create(kind, parseId(kind, source))
      } catch {
        throw new AppError('IMPORT_INVALID', `${label} is not a valid ${kind} identifier`)
      }
    },
    derived(kind, label) {
      return create(kind, label)
    },
  }
}

export function importRecords<K extends IdKind>(
  value: unknown,
  kind: K,
  label: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new AppError('IMPORT_INVALID', `${label} must be an array`)
  const records = value.map((entry, index) => importRecord(entry, `${label}[${index}]`))
  const seen = new Set<string>()
  for (const [index, record] of records.entries()) {
    let id: string
    try {
      id = parseId(kind, record.id)
    } catch {
      throw new AppError('IMPORT_INVALID', `${label}[${index}].id is invalid`)
    }
    if (seen.has(id)) throw new AppError('IMPORT_INVALID', `${label} contains duplicate ID ${id}`)
    seen.add(id)
  }
  return records
}

export function importRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('IMPORT_INVALID', `${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('IMPORT_INVALID', `${label} must be non-empty text`)
  }
  return value
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new AppError('IMPORT_INVALID', `${label} must be text`)
  return value
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, label)
}

export function canonicalDateTime(value: unknown, label: string): string {
  if (!isCanonicalIsoDateTime(value)) {
    throw new AppError('IMPORT_INVALID', `${label} must be a canonical ISO timestamp`)
  }
  return value
}

export function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AppError('IMPORT_INVALID', `${label} must be a non-negative number`)
  }
  return value
}

export function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label)
}

export function finiteInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label)
  if (!Number.isSafeInteger(number)) {
    throw new AppError('IMPORT_INVALID', `${label} must be a non-negative integer`)
  }
  return number
}

export function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new AppError('IMPORT_INVALID', `${label} must be boolean`)
  return value
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new AppError('IMPORT_INVALID', `${label} is unsupported`)
  }
  return value as T[number]
}

export function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) throw new AppError('IMPORT_INVALID', `${label} is outside the export`)
}
