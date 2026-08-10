import { effectiveElapsedMs, formatDuration } from '../shared/duration.js'
import type {
  ActivityItemView,
  BraidViewModel,
  EntityDetailView,
  RunView,
  UsageMeasurementStatus,
  UsageTotalsView,
} from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  EntityBrowser,
  type EntityBrowserDocument,
  type EntityBrowserRow,
} from './entity-browser.js'
import type { BraidTheme } from './theme.js'

export type ActivityBrowserScope = 'all' | 'analyses' | 'workers'

export interface ActivityBrowserOptions {
  readonly view: () => BraidViewModel
  readonly rows: () => number
  readonly onClose: () => void
  readonly scope?: ActivityBrowserScope
  readonly selectedId?: string
  readonly openSelected?: boolean
  readonly notice?: () => string | undefined
}

export class ActivityBrowserPanel extends EntityBrowser {
  constructor(theme: BraidTheme, options: ActivityBrowserOptions) {
    const scope = options.scope ?? 'all'
    super(theme, {
      document: () => activityDocument(options.view(), scope, options.notice?.()),
      rows: options.rows,
      onClose: options.onClose,
      ...(options.selectedId === undefined ? {} : { selectedId: options.selectedId }),
      ...(options.openSelected === undefined ? {} : { openSelected: options.openSelected }),
    })
  }
}

export function activityDocument(
  view: BraidViewModel,
  scope: ActivityBrowserScope = 'all',
  notice?: string,
): EntityBrowserDocument {
  const details = new Map(
    (view.entityDetails ?? []).map((detail) => [detailKey(detail), detail] as const),
  )
  const runs = new Map(view.runs.map((run) => [run.id, run] as const))
  const items = view.activity
    .filter((item) => included(item, scope))
    .slice()
    .reverse()
  return {
    title: scope === 'all' ? 'activity' : scope,
    context: `${view.profileName} · ${view.runner} · ${view.model} · ${sessionUsageLabel(view)}`,
    ...(notice === undefined ? {} : { notice }),
    emptyMessage:
      scope === 'analyses'
        ? 'No trace analyses have been recorded.'
        : scope === 'workers'
          ? 'No runtime workers have been reported.'
          : 'No activity has been recorded.',
    rows: items.map((item) => rowFor(item, details, runs)),
  }
}

function rowFor(
  item: ActivityItemView,
  details: ReadonlyMap<string, EntityDetailView>,
  runs: ReadonlyMap<string, RunView>,
): EntityBrowserRow {
  const entity =
    item.entityType === undefined || item.entityId === undefined
      ? undefined
      : details.get(`${item.entityType}:${item.entityId}`)
  const elapsed = effectiveElapsedMs(item.status, item.startedAt, item.elapsedMs)
  const lines = activityContext(item, elapsed)
  if (entity !== undefined) lines.push(...entity.lines)
  if (item.kind === 'run') lines.push(...runContext(item, runs))
  const meta = listMeta(item, elapsed)
  return {
    id: item.id,
    kind: item.kind,
    title: entity?.title ?? item.title,
    status: item.status,
    ...(meta === undefined ? {} : { meta }),
    ...(item.kind === 'worker' || item.kind === 'supervisor'
      ? { depth: Math.max(0, item.depth ?? 0) }
      : {}),
    detailLines: lines,
  }
}

function runContext(item: ActivityItemView, runs: ReadonlyMap<string, RunView>): readonly string[] {
  if (item.runId === undefined) return []
  const run = runs.get(item.runId)
  if (run === undefined) return []
  const usage = run.usage
  const tokenPrefix = usage?.tokenStatus === 'complete' ? '' : '≥'
  const noObservedTokens = (usage?.input ?? 0) === 0 && (usage?.output ?? 0) === 0
  const tokenUsageUnknown = usage?.tokenStatus !== 'complete' && noObservedTokens
  const cost = costLabel(usage)
  const cached = Object.values(usage?.promptCache ?? {}).reduce((total, value) => total + value, 0)
  const metrics = [
    ...(tokenUsageUnknown ? ['tokens unknown'] : []),
    ...(usage?.input === undefined || tokenUsageUnknown ? [] : [`${tokenPrefix}${usage.input} in`]),
    ...(usage?.output === undefined || tokenUsageUnknown
      ? []
      : [`${tokenPrefix}${usage.output} out`]),
    ...(usage?.reasoning === undefined ? [] : [`${usage.reasoning} reasoning`]),
    ...(cached === 0 ? [] : [`${cached} cached`]),
    ...(cost === undefined ? [] : [cost]),
    ...(usage?.elapsedMs === undefined ? [] : [`${Math.round(usage.elapsedMs)}ms`]),
  ]
  return [
    ...(run.provider === undefined ? [] : [`provider: ${sanitizeTerminalText(run.provider)}`]),
    ...(run.runner === undefined ? [] : [`runner: ${sanitizeTerminalText(run.runner)}`]),
    ...(run.connection === undefined
      ? []
      : [`connection: ${sanitizeTerminalText(run.connection)}`]),
    ...(run.environmentId === undefined
      ? []
      : [`execution environment: ${sanitizeTerminalText(run.environmentId)}`]),
    ...(run.providerSessionId === undefined
      ? []
      : [`provider session: ${sanitizeTerminalText(run.providerSessionId)}`]),
    ...(usage?.model === undefined ? [] : [`model: ${sanitizeTerminalText(usage.model)}`]),
    ...(metrics.length === 0 ? [] : [`usage: ${metrics.join(' · ')}`]),
    ...(usage === undefined
      ? []
      : [`model calls: ${usage.llmCalls === undefined ? 'unknown' : usage.llmCalls}`]),
    ...(usage === undefined
      ? []
      : [
          `model latency: ${
            usage.llmLatencyMs === undefined ? 'unknown' : `${Math.round(usage.llmLatencyMs)}ms`
          }`,
        ]),
    ...(usage?.tokenStatus === undefined ? [] : [`token measurement: ${usage.tokenStatus}`]),
    ...(usage?.costStatus === undefined ? [] : [`cost measurement: ${usage.costStatus}`]),
    `history: ${sanitizeTerminalText(run.completeness)}`,
    ...(run.error === undefined ? [] : [`! ${sanitizeTerminalText(run.error)}`]),
  ]
}

function costLabel(usage: RunView['usage']): string | undefined {
  if (usage === undefined) return undefined
  if (usage.costStatus === 'reported' && usage.costUsd !== undefined) {
    return `$${usage.costUsd.toFixed(4)}`
  }
  if (usage.costStatus === 'observed-floor' && usage.costUsd !== undefined) {
    return usage.costUsd > 0 ? `≥$${usage.costUsd.toFixed(4)}` : 'cost unknown'
  }
  if (usage.estimatedCostUsd !== undefined && usage.estimatedCostUsd > 0)
    return `~$${usage.estimatedCostUsd.toFixed(4)}`
  return usage.costStatus === 'unknown' ? 'cost unknown' : undefined
}

function sessionUsageLabel(view: BraidViewModel): string {
  const turns = view.sessionUsage.turns
  if (hasMeasurementTelemetry(view.sessionUsage)) {
    return [
      usageGroup('turns', turns, true),
      usageGroup('analysis', view.sessionUsage.analyses, false),
      usageGroup('workers', view.sessionUsage.delegated, false),
    ]
      .filter((value): value is string => value !== undefined)
      .join(' · ')
  }
  const prefix = turns.tokenStatus === 'complete' ? '' : '≥'
  const tokens =
    turns.tokenStatus !== 'complete' && (turns.input ?? 0) === 0 && (turns.output ?? 0) === 0
      ? 'tokens unknown'
      : `${prefix}${turns.input ?? 0}/${prefix}${turns.output ?? 0} tok`
  const directCost = costLabel(turns)
  const delegated = view.sessionUsage.delegated
  const delegatedCost = costLabel(delegated)
  const analyses = view.sessionUsage.analyses
  const analysisCost = costLabel(analyses)
  return [
    tokens,
    ...(directCost === undefined ? [] : [directCost]),
    ...((turns.llmCalls ?? 0) === 0 ? [] : [`${turns.llmCalls} calls`]),
    ...((turns.llmLatencyMs ?? 0) === 0 ? [] : [`${Math.round(turns.llmLatencyMs ?? 0)}ms model`]),
    ...(delegated.sourceCount === 0 ? [] : [`workers ${delegatedCost ?? 'cost unknown'}`]),
    ...(analyses.sourceCount === 0 ? [] : [`analysis ${analysisCost ?? 'cost unknown'}`]),
  ].join(' · ')
}

function hasMeasurementTelemetry(view: BraidViewModel['sessionUsage']): boolean {
  return [view.turns, view.analyses, view.delegated].some(hasMeasurementFields)
}

function hasMeasurementFields(usage: UsageTotalsView): boolean {
  return (
    usage.callStatus !== undefined ||
    usage.latencyStatus !== undefined ||
    usage.unknownCallSources !== undefined ||
    usage.unknownLatencySources !== undefined
  )
}

function usageGroup(
  label: string,
  usage: UsageTotalsView,
  includeEmpty: boolean,
): string | undefined {
  if (!includeEmpty && usage.sourceCount === 0) return undefined
  const metrics = tokenMetrics(usage)
  const cost = costLabel(usage)
  if (cost !== undefined) metrics.push(cost)
  const calls = measurementMetric(
    'calls',
    usage.llmCalls,
    usage.callStatus,
    usage.unknownCallSources,
    usage.sourceCount,
    (value) => String(Math.round(value)),
  )
  const latency = measurementMetric(
    'model',
    usage.llmLatencyMs,
    usage.latencyStatus,
    usage.unknownLatencySources,
    usage.sourceCount,
    (value) => `${Math.round(value)}ms`,
  )
  if (calls !== undefined) metrics.push(calls)
  if (latency !== undefined) metrics.push(latency)
  return metrics.length === 0 ? undefined : `${label} ${metrics.join(' · ')}`
}

function tokenMetrics(usage: UsageTotalsView): string[] {
  const tokenPrefix = usage.tokenStatus === 'complete' ? '' : '≥'
  const noObservedTokens = (usage.input ?? 0) === 0 && (usage.output ?? 0) === 0
  const tokenUsageUnknown = usage.tokenStatus !== 'complete' && noObservedTokens
  if (tokenUsageUnknown) return ['usage unknown']
  return [
    ...(usage.input === undefined ? [] : [`in ${tokenPrefix}${compactNumber(usage.input)}`]),
    ...(usage.output === undefined ? [] : [`out ${tokenPrefix}${compactNumber(usage.output)}`]),
  ]
}

function measurementMetric(
  label: string,
  value: number | undefined,
  status: UsageMeasurementStatus | undefined,
  unknownSources: number | undefined,
  sourceCount: number,
  format: (value: number) => string,
): string | undefined {
  if (status === undefined && value === undefined && unknownSources === undefined) return undefined
  if (sourceCount === 0 && value === undefined && (unknownSources ?? 0) === 0) return undefined
  const missing = Math.max(0, unknownSources ?? (value === undefined ? 1 : 0))
  if (value === undefined || status === 'unknown') {
    return `${label} unknown${missing > 0 ? ` (${missing} missing)` : ''}`
  }
  const prefix = status === 'partial' ? '≥' : ''
  const suffix = status === 'partial' && missing > 0 ? ` (+${missing} missing)` : ''
  return `${label} ${prefix}${format(value)}${suffix}`
}

function compactNumber(value: number): string {
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}m`
}

function activityContext(item: ActivityItemView, elapsed: number | undefined): string[] {
  const lines: string[] = []
  if (item.occurredAt !== undefined) lines.push(`time: ${sanitizeTerminalText(item.occurredAt)}`)
  if (elapsed !== undefined) lines.push(`elapsed: ${formatDuration(elapsed)}`)
  if (item.runId !== undefined) lines.push(`run: ${sanitizeTerminalText(item.runId)}`)
  if (item.parentId !== undefined) lines.push(`parent: ${sanitizeTerminalText(item.parentId)}`)
  if (item.sourceEventId !== undefined) {
    lines.push(`source event: ${sanitizeTerminalText(item.sourceEventId)}`)
  }
  if (item.detail !== undefined && item.detail.trim().length > 0) {
    lines.push(...item.detail.split('\n').map((line) => sanitizeTerminalText(line)))
  }
  return lines
}

function listMeta(item: ActivityItemView, elapsed: number | undefined): string | undefined {
  if (elapsed !== undefined) return formatDuration(elapsed)
  if (item.detail === undefined) return undefined
  const line = item.detail.split('\n')[0]?.trim()
  return line ? sanitizeTerminalText(line) : undefined
}

function included(item: ActivityItemView, scope: ActivityBrowserScope): boolean {
  if (scope === 'all') return true
  if (scope === 'analyses') return item.kind === 'analysis'
  return item.kind === 'supervisor' || item.kind === 'worker'
}

function detailKey(detail: EntityDetailView): string {
  return `${detail.entityType}:${detail.entityId}`
}
