import { matchesKey } from '@earendil-works/pi-tui'
import { effectiveElapsedMs, formatDuration } from '../shared/duration.js'
import type { BraidViewModel, EntityDetailView, RunView } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { type ActivityDocumentItem, projectActivityDocument } from './activity-document.js'
import {
  EntityBrowser,
  type EntityBrowserDocument,
  type EntityBrowserRow,
} from './entity-browser.js'
import { executionTargetFor } from './execution-target.js'
import type { BraidTheme } from './theme.js'

export type ActivityBrowserScope = 'all' | 'runs' | 'analyses' | 'workers'
export type ActivityBrowserAction = 'refresh' | 'steer' | 'cancel' | 'attach' | 'promote'

const ACTIVITY_SCOPES = ['all', 'runs', 'analyses', 'workers'] as const

export interface ActivityBrowserOptions {
  readonly view: () => BraidViewModel
  readonly rows: () => number
  readonly onClose: () => void
  readonly onOpenSelected?: (row: EntityBrowserRow) => void
  readonly scope?: ActivityBrowserScope
  readonly selectedId?: string
  readonly openSelected?: boolean
  readonly notice?: () => string | undefined
  readonly emptyMessage?: string
  readonly pinned?: string
  readonly onAction?: (action: ActivityBrowserAction, selectedId: string | undefined) => void
}

export class ActivityBrowserPanel extends EntityBrowser {
  readonly #scopeState: { scope: ActivityBrowserScope }
  readonly #onAction: ActivityBrowserOptions['onAction']

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
      ...(options.onOpenSelected === undefined ? {} : { onOpenSelected: options.onOpenSelected }),
      ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
      ...(options.openSelected === undefined ? {} : { openSelected: options.openSelected }),
    })
    this.#scopeState = scopeState
    this.#onAction = options.onAction
  }

  override handleInput(data: string): void {
    if (matchesKey(data, 'tab')) {
      const current = ACTIVITY_SCOPES.indexOf(this.#scopeState.scope)
      this.#scopeState.scope = ACTIVITY_SCOPES[(current + 1) % ACTIVITY_SCOPES.length] ?? 'all'
      this.invalidate()
      return
    }
    const action = activityAction(data, this.#scopeState.scope)
    if (action !== undefined && this.#onAction !== undefined) {
      this.#onAction(action, this.selectedId)
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
  return {
    title: scope === 'all' ? 'activity' : scope,
    filterHint: activityFooter(scope, view),
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

function activityAction(
  data: string,
  scope: ActivityBrowserScope,
): ActivityBrowserAction | undefined {
  if (matchesKey(data, 'r')) return 'refresh'
  if (scope === 'runs') return undefined
  if (matchesKey(data, 'x')) return 'cancel'
  if (scope === 'analyses') return matchesKey(data, 'p') ? 'promote' : undefined
  if (matchesKey(data, 's')) return 'steer'
  if (matchesKey(data, 'a')) return 'attach'
  if (scope === 'all' && matchesKey(data, 'p')) return 'promote'
  return undefined
}

function activityFooter(scope: ActivityBrowserScope, view: BraidViewModel): string {
  if (scope === 'workers') {
    const steer = view.capabilities['supervisor.worker.steer']?.available === true
    const attach = view.capabilities['supervisor.worker.attach']?.available === true
    return steer || attach ? 's steer · x cancel · a/r' : 's/a off · x cancel · r'
  }
  if (scope === 'analyses') return 'p promote · x cancel · r'
  if (scope === 'all') return 'tab filter: selected actions s/x/a/p · r refresh'
  return 'tab filter · r refresh'
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
    ...(item.runId === undefined ? {} : { runId: item.runId }),
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
    `model: ${sanitizeTerminalText(target.model)}`,
    ...(target.effort === undefined ? [] : [`thinking: ${sanitizeTerminalText(target.effort)}`]),
    ...(target.maxVisibleOutputTokens === undefined
      ? []
      : [`max visible output tokens: ${target.maxVisibleOutputTokens}`]),
    ...(target.maxReasoningTokens === undefined
      ? []
      : [`max reasoning tokens: ${target.maxReasoningTokens}`]),
    ...(target.maxTotalOutputTokens === undefined
      ? []
      : [`max total output tokens: ${target.maxTotalOutputTokens}`]),
    ...(metrics.length === 0 ? [] : [`usage: ${metrics.join(' · ')}`]),
    ...measurementValue('model calls', usage?.llmCalls),
    ...measurementValue('model latency', usage?.llmLatencyMs, (value) => `${Math.round(value)}ms`),
    ...measurementStatus('token measurement', usage?.tokenStatus),
    ...measurementStatus('cost measurement', usage?.costStatus),
    `history: ${sanitizeTerminalText(run.completeness)}`,
    ...(run.error === undefined ? [] : [`! ${sanitizeTerminalText(run.error)}`]),
  ]
}

function measurementValue(
  label: string,
  value: number | undefined,
  format: (value: number) => string = (measured) => String(measured),
): readonly string[] {
  return value === undefined ? [] : [`${label}: ${format(value)}`]
}

function measurementStatus(label: string, status: string | undefined): readonly string[] {
  if (status === undefined || status === 'unknown') return []
  return [`${label}: ${status}`]
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
