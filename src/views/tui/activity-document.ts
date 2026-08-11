import type {
  ActivityItemView,
  BraidViewModel,
  GraphNodeType,
  UsageView,
} from '../shared/models.js'

export interface ActivityDocumentSource {
  readonly eventId?: string
  readonly entityType?: GraphNodeType
  readonly entityId?: string
}

export interface ActivityDocumentItem {
  readonly id: string
  readonly kind: ActivityItemView['kind']
  readonly title: string
  readonly status: string
  readonly summary: string
  readonly detail?: string
  readonly durationMs?: number
  readonly startedAt?: string
  readonly occurredAt?: string
  readonly source?: ActivityDocumentSource
  readonly runId?: string
  readonly parentId?: string
  readonly depth?: number
  readonly usage?: UsageView
}

export interface ActivityDocument {
  readonly items: readonly ActivityDocumentItem[]
}

/** Joins activity rows with the event-aware transcript projection for presentation only. */
export function projectActivityDocument(view: BraidViewModel): ActivityDocument {
  const partsBySourceEvent = new Map<string, string>()
  const unscopedPartsBySourceEvent = new Map<string, string>()
  for (const message of view.messages) {
    for (const part of message.parts) {
      if (part.sourceEventId !== undefined && part.status !== undefined) {
        if (message.runId === undefined) {
          unscopedPartsBySourceEvent.set(part.sourceEventId, part.status)
        } else {
          partsBySourceEvent.set(sourceKey(message.runId, part.sourceEventId), part.status)
        }
      }
    }
  }
  const runs = new Map(view.runs.map((run) => [run.id, run] as const))
  const items = view.activity.map((item) => {
    const sourceEventId = item.sourceEventId
    const eventStatus =
      sourceEventId === undefined
        ? undefined
        : (partsBySourceEvent.get(sourceKey(item.runId, sourceEventId)) ??
          unscopedPartsBySourceEvent.get(sourceEventId))
    const run = item.runId === undefined ? undefined : runs.get(item.runId)
    const durationMs = item.elapsedMs ?? (item.kind === 'run' ? run?.usage?.elapsedMs : undefined)
    const source = sourceFor(item)
    return Object.freeze({
      id: item.id,
      kind: item.kind,
      title: item.title,
      status: eventStatus ?? item.status,
      summary: summaryFor(item),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
      ...(item.occurredAt === undefined ? {} : { occurredAt: item.occurredAt }),
      ...(source === undefined ? {} : { source }),
      ...(item.runId === undefined ? {} : { runId: item.runId }),
      ...(item.parentId === undefined ? {} : { parentId: item.parentId }),
      ...(item.depth === undefined ? {} : { depth: item.depth }),
      ...(item.kind === 'run' && run?.usage !== undefined ? { usage: run.usage } : {}),
    })
  })
  return Object.freeze({ items: Object.freeze(items) })
}

function sourceFor(item: ActivityItemView): ActivityDocumentSource | undefined {
  if (
    item.sourceEventId === undefined &&
    item.entityType === undefined &&
    item.entityId === undefined
  ) {
    return undefined
  }
  return Object.freeze({
    ...(item.sourceEventId === undefined ? {} : { eventId: item.sourceEventId }),
    ...(item.entityType === undefined ? {} : { entityType: item.entityType }),
    ...(item.entityId === undefined ? {} : { entityId: item.entityId }),
  })
}

function summaryFor(item: ActivityItemView): string {
  const detail = item.detail?.split('\n')[0]?.trim()
  return detail && detail.length > 0 ? detail : item.title
}

function sourceKey(runId: string | undefined, eventId: string): string {
  return `${runId ?? ''}:${eventId}`
}
