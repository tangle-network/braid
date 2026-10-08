import { canonicalDigest } from './canonical.js'
import type { RunRecord } from './entities.js'
import { assertUniqueIds, fail, objectValue } from './invariants-base.js'
import {
  MAX_NATIVE_CHILD_EVENTS,
  MAX_NATIVE_CHILDREN,
  nativeChildEvent,
} from './native-children.js'
import { safePublicIdentifier } from './provider-values.js'

export function assertNativeChildren(record: RunRecord): void {
  const projection = record.nativeChildren
  if (projection === undefined) return
  objectValue(projection, 'run.nativeChildren')
  if (!Array.isArray(projection.children) || projection.children.length > MAX_NATIVE_CHILDREN)
    fail('run.nativeChildren.children must be a bounded array')
  if (
    !Array.isArray(projection.appliedEventIds) ||
    projection.appliedEventIds.length > MAX_NATIVE_CHILD_EVENTS
  )
    fail('run.nativeChildren.appliedEventIds must be a bounded array')
  if (typeof projection.truncated !== 'boolean')
    fail('run.nativeChildren.truncated must be boolean')
  for (const id of projection.appliedEventIds) {
    if (typeof id !== 'string' || safePublicIdentifier(id) !== id)
      fail('run.nativeChildren.appliedEventIds must contain public identifiers')
  }
  assertUniqueIds(projection.appliedEventIds, 'run.nativeChildren.appliedEventIds')
  const sources = new Set(projection.appliedEventIds)
  const ids = projection.children.map((child) => {
    const parsed = nativeChildEvent(child)
    if (parsed === undefined || canonicalDigest(parsed) !== canonicalDigest(child))
      fail('run.nativeChildren.children must contain canonical public child events')
    if (!sources.has(parsed.sourceEventId))
      fail('run.nativeChildren child source must be in appliedEventIds')
    return parsed.childId
  })
  assertUniqueIds(ids, 'run.nativeChildren.children')
}
