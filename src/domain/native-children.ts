import { CanonicalStreamEventSchema, type ChildTaskEvent } from '@tangle-network/agent-interface'
import { safePublicIdentifier } from './provider-values.js'
import { redactSensitiveText } from './redaction.js'
import type { RuntimeRunFields } from './runtime-projection.js'

export const MAX_NATIVE_CHILDREN = 512
export const MAX_NATIVE_CHILD_EVENTS = 8192
type Projection = NonNullable<RuntimeRunFields['nativeChildren']>
const terminal = new Set<ChildTaskEvent['status']>(['completed', 'failed', 'cancelled'])

/** Use the shared wire validator; private provider fields never enter the projection. */
export function nativeChildEvent(value: unknown): ChildTaskEvent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { raw: _raw, ...publicFields } = value as Record<string, unknown>
  const parsed = CanonicalStreamEventSchema.safeParse(publicFields)
  if (!parsed.success || parsed.data.type !== 'child-task') return undefined
  const child = parsed.data
  if (
    [child.time.started, child.time.updated, child.time.ended].some(
      (value) => value !== undefined && !Number.isFinite(new Date(value).getTime()),
    )
  )
    return undefined
  for (const id of [
    child.childId,
    child.parentChildId,
    child.sourceEventId,
    child.runner,
    child.model,
  ]) {
    if (id !== undefined && safePublicIdentifier(id) !== id) return undefined
  }
  return {
    ...child,
    ...(child.title === undefined ? {} : { title: redactSensitiveText(child.title) }),
    ...(child.terminalReason === undefined
      ? {}
      : { terminalReason: redactSensitiveText(child.terminalReason) }),
  }
}

/** Source event identity is scoped to the owning run, including after compaction. */
export function projectNativeChild(
  current: Projection | undefined,
  event: ChildTaskEvent,
): Projection {
  const projection = current ?? { children: [], appliedEventIds: [], truncated: false }
  if (projection.appliedEventIds.includes(event.sourceEventId)) return projection
  const previous = projection.children.find((child) => child.childId === event.childId)
  if (
    projection.truncated ||
    projection.appliedEventIds.length >= MAX_NATIVE_CHILD_EVENTS ||
    (previous === undefined && projection.children.length >= MAX_NATIVE_CHILDREN)
  ) {
    return { ...projection, truncated: true }
  }
  const appliedEventIds = [...projection.appliedEventIds, event.sourceEventId]
  // A delayed observation cannot regress a terminal child or rewrite its parent identity.
  if (
    previous !== undefined &&
    (event.time.updated < previous.time.updated ||
      event.time.started !== previous.time.started ||
      event.parentChildId !== previous.parentChildId ||
      (previous.status === 'running' && event.status === 'started') ||
      (terminal.has(previous.status) && event.status !== previous.status))
  )
    return { ...projection, appliedEventIds }
  return {
    ...projection,
    appliedEventIds,
    children:
      previous === undefined
        ? [...projection.children, event]
        : projection.children.map((child) => (child.childId === event.childId ? event : child)),
  }
}
