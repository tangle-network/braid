export type * from './ids-types.js'
export * from './ids-values.js'

import type { IdForKind, IdKind } from './ids-types.js'
import { assertPrefixedId, isPrefixedId, parsePrefixedId } from './ids-core.js'

export function parseId<K extends IdKind>(kind: K, value: unknown): IdForKind<K> {
  return parsePrefixedId(kind, value)
}

export function isId<K extends IdKind>(kind: K, value: unknown): value is IdForKind<K> {
  return isPrefixedId(kind, value)
}

export function assertId<K extends IdKind>(kind: K, value: unknown): asserts value is IdForKind<K> {
  assertPrefixedId(kind, value)
}
