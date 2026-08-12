import { matchesKey } from '@earendil-works/pi-tui'
import { effectiveElapsedMs, formatDuration } from '../shared/duration.js'
import type { BraidViewModel, EntityDetailView, RunView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { projectActivityDocument, type ActivityDocumentItem } from './activity-document.js'
import { executionTargetFor } from './execution-target.js'
import {
  EntityBrowser,
  type EntityBrowserDocument,
  type EntityBrowserRow,
} from './entity-browser.js'
import { metricsFor } from './terminal-usage.js'
import type { BraidTheme } from './theme.js'

export type ActivityBrowserScope = 'all' | 'runs' | 'analyses' | 'workers'

const ACTIVITY_SCOPES = ['all', 'runs', 'analyses', 'workers'] as const

export interface ActivityBrowserOptions {
  readonly view: () => BraidViewModel
  readonly rows: () => number
  readonly onClose: () => void
  readonly scope?: ActivityBrowserScope
  readonly selectedId?: string
  readonly openSelected?: boolean
  readonly notice?: () => string | undefined
  readonly emptyMessage?: string
  readonly pinned?: string
}

export class ActivityBrowserPanel extends EntityBrowser {
  readonly #scopeState: { scope: ActivityBrowserScope }

  constructor(theme: BraidTheme, options: ActivityBrowserOptions) {
    const scopeState: { scope: ActivityBrowserScope } = { scope: options.scope ?? 'all' }
    super(theme, {
      document: () =>
        activityDocument(
          options.view(),
          scopeState.scope,
          options.notice?.(),
          options.emptyMessage,
          options.pinned,
        ),
      rows: options.rows,
      onClose: options.onClose,
      ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
      ...(options.openSelected === undefined ? {} : { openSelected: options.openSelected }),
    })
    this.#scopeState = scopeState
  }

  override handleInput(data: string): void {
    if (matchesKey(data, 'tab')) {
      const current = ACTIVITY_SCOPES.indexOf(this.#scopeState.scope)
      this.#scopeState.scope = ACTIVITY_SCOPES[(current + 1) % ACTIVITY_SCOPES.length] ?? 'all'
      this.invalidate()
      return
    }
    super.handleInput(data)
  }
}

export function activityDocument(
  view: BraidViewModel,
  scope: ActivityBrowserScope = 'all',
  notice?: string,
  emptyMessage?: string,
  pinned?: string,
): EntityBrowserDocument {
  const details = new Map(
    (view.entityDetails ?? []).map((detail) => [detailKey(detail), detail] as const),
  )
  const runs = new Map(view.runs.map((run) => [run.id, run] as const))
  const items = projectActivityDocument(view)
    .items.filter((item) => included(item, scope))
    .slice()
    .reverse()
  const target = executionTargetFor(view)
  const usage = metricsFor(view)
  return {
    title: scope === 'all' ? 'activity' : `activity · ${scope}`,
    context: [target.profileName, target.runner, target.model, ...usage].join(' · '),
    filterHint: `tab filter: ${scope}`,
    ...(pinned === undefined ? {} : { pinned }),
    ...(notice === undefined ? {} : { notice }),
    emptyMessage:
      emptyMessage ??
      (scope === 'analyses'
        ? 'No trace analyses have been recorded.'
        : scope === 'workers'
          ? 'No runtime workers have been reported.'
          : 'No activity has been recorded.'),
    rows: items.map((item) => rowFor(item, details, runs, view)),
  }
}

function rowFor(
  item: ActivityDocumentItem,
  details: ReadonlyMap<string, EntityDetailView>,
  runs: ReadonlyMap<string, RunView>,
  view: BraidViewModel,
): EntityBrowserRow {
  const entityType = item.source?.entityType
  const entityId = item.source?.entityId
  const entity =
    entityType === undefined || entityId === undefined
      ? undefined
      : details.get(`${entityType}:${entityId}`)
  const elapsed = effectiveElapsedMs(item.status, item.startedAt, item.durationMs)
  const activityLines = activityContext(item, elapsed, entity?.entityType !== 'analysis')
  const lines =
    entity?.entityType === 'analysis'
      ? [
          ...entity.lines,
          ...(activityLines.length === 0 ? [] : ['── activity record', ...activityLines]),
        ]
      : [...activityLines, ...(entity?.lines ?? [])]
  if (item.kind === 'run') lines.push(...runContext(item, runs, view))
  const meta = listMeta(item, elapsed)
  return {
    id: item.id,
    kind: item.kind,
    title: entity?.title ?? item.title,
    status: item.status,
    ...(meta === undefined ? {} : { meta }),
    ...(item.depth === undefined ? {} : { depth: Math.max(0, item.depth) }),
    detailLines: lines,
  }
}

function runContext(
  item: ActivityDocumentItem,
  runs: ReadonlyMap<string, RunView>,
  view: BraidViewModel,
): readonly string[] {
  if (item.runId === undefined) return []
  const run = runs.get(item.runId)
  if (run === undefined) return []
  const target = executionTargetFor(view, run.id)
  const usage = item.usage
  const tokenPrefix = usage?.tokenStatus === 'complete' ? '' : '≥'
  const noObservedTokens = (usage?.input ?? 0) === 0 && (usage?.output ?? 0) === 0
  const hideTokens = usage?.tokenStatus !== 'complete' && noObservedTokens
  const cost = costLabel(usage)
  const cached = Object.values(usage?.promptCache ?? {}).reduce((total, value) => total + value, 0)
  const metrics = [
    ...(usage?.input === undefined || hideTokens ? [] : [`${tokenPrefix}${usage.input} in`]),
    ...(usage?.output === undefined || hideTokens ? [] : [`${tokenPrefix}${usage.output} out`]),
    ...(usage?.reasoning === undefined ? [] : [`${usage.reasoning} reasoning`]),
    ...(cached === 0 ? [] : [`${cached} cached`]),
    ...(cost === undefined ? [] : [cost]),
    ...(usage?.elapsedMs === undefined ? [] : [`${Math.round(usage.elapsedMs)}ms`]),
  ]
  return [
    ...(run.provider === undefined ? [] : [`provider: ${sanitizeTerminalText(run.provider)}`]),
    `AgentProfile: ${sanitizeTerminalText(target.profileName)}`,
    ...(target.profileDigest === undefined
      ? []
      : [`profile digest: ${sanitizeTerminalText(target.profileDigest)}`]),
    `runner: ${sanitizeTerminalText(target.runner)}`,
    `connection: ${sanitizeTerminalText(target.connection)}`,
    ...(target.connectionId === undefined || target.connectionId === target.connection
      ? []
      : [`connection id: ${sanitizeTerminalText(target.connectionId)}`]),
    ...(run.environmentId === undefined
      ? []
      : [`execution environment: ${sanitizeTerminalText(run.environmentId)}`]),
    ...(run.providerSessionId === undefined
      ? []
      : [`provider session: ${sanitizeTerminalText(run.providerSessionId)}`]),
    `model: ${sanitizeTerminalText(target.model)}`,
    ...(target.effort === undefined ? [] : [`thinking: ${sanitizeTerminalText(target.effort)}`]),
    ...(target.maxOutputTokens === undefined
      ? []
      : [`max output tokens: ${target.maxOutputTokens}`]),
    ...(metrics.length === 0 ? [] : [`usage: ${metrics.join(' · ')}`]),
    ...measurementValue('model calls', usage?.llmCalls, usage !== undefined),
    ...measurementValue(
      'model latency',
      usage?.llmLatencyMs,
      usage !== undefined,
      (value) => `${Math.round(value)}ms`,
    ),
    ...measurementStatus('token measurement', usage?.tokenStatus),
    ...measurementStatus('cost measurement', usage?.costStatus),
    `history: ${sanitizeTerminalText(run.completeness)}`,
    ...(run.error === undefined ? [] : [`! ${sanitizeTerminalText(run.error)}`]),
  ]
}

function measurementValue(
  label: string,
  value: number | undefined,
  measurementExists: boolean,
  format: (value: number) => string = (measured) => String(measured),
): readonly string[] {
  if (value !== undefined) return [`${label}: ${format(value)}`]
  return measurementExists ? [`${label}: not reported`] : []
}

function measurementStatus(label: string, status: string | undefined): readonly string[] {
  if (status === undefined) return []
  return [`${label}: ${status === 'unknown' ? 'not reported' : status}`]
}

function costLabel(usage: RunView['usage']): string | undefined {
  if (usage === undefined) return undefined
  if (usage.costStatus === 'reported' && usage.costUsd !== undefined) {
    return `$${usage.costUsd.toFixed(4)}`
  }
  if (usage.costStatus === 'observed-floor' && usage.costUsd !== undefined) {
    return usage.costUsd > 0 ? `≥$${usage.costUsd.toFixed(4)}` : undefined
  }
  if (
    usage.costStatus === 'estimated' &&
    usage.estimatedCostUsd !== undefined &&
    usage.estimatedCostUsd >= 0
  )
    return `~$${usage.estimatedCostUsd.toFixed(4)}`
  return undefined
}

function activityContext(
  item: ActivityDocumentItem,
  elapsed: number | undefined,
  includeDetail: boolean,
): string[] {
  const lines: string[] = []
  if (item.occurredAt !== undefined) lines.push(`time: ${sanitizeTerminalText(item.occurredAt)}`)
  if (elapsed !== undefined) lines.push(`elapsed: ${formatDuration(elapsed)}`)
  if (item.runId !== undefined) lines.push(`run: ${sanitizeTerminalText(item.runId)}`)
  if (item.parentId !== undefined) lines.push(`parent: ${sanitizeTerminalText(item.parentId)}`)
  if (item.source?.eventId !== undefined) {
    lines.push(`source event: ${sanitizeTerminalText(item.source.eventId)}`)
  }
  if (includeDetail && item.detail !== undefined && item.detail.trim().length > 0) {
    lines.push(...item.detail.split('\n').map((line) => sanitizeTerminalText(line)))
  }
  return lines
}

function listMeta(item: ActivityDocumentItem, elapsed: number | undefined): string | undefined {
  if (elapsed !== undefined) return formatDuration(elapsed)
  return item.summary === item.title ? undefined : sanitizeTerminalText(item.summary)
}

function included(item: ActivityDocumentItem, scope: ActivityBrowserScope): boolean {
  if (scope === 'all') return true
  if (scope === 'analyses') return item.kind === 'analysis'
  if (scope === 'workers') return item.kind === 'supervisor' || item.kind === 'worker'
  return item.kind !== 'analysis' && item.kind !== 'supervisor' && item.kind !== 'worker'
}

function detailKey(detail: EntityDetailView): string {
  return `${detail.entityType}:${detail.entityId}`
}
