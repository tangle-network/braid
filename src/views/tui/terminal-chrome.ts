import { type Component, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { BraidViewModel, UsageMeasurementStatus, UsageTotalsView } from '../shared/models.js'
import { sanitizeNotification, sanitizeTerminalText } from '../shared/sanitize.js'
import { executionTargetFor, type ExecutionTargetView } from './execution-target.js'
import { type LayoutMode, modeForColumns } from './layout.js'
import type { BraidTheme } from './theme.js'

export interface TerminalChromeState {
  readonly view: BraidViewModel
  readonly quitArmed: boolean
  readonly activityVisible: boolean
  readonly navigationHint: string
}

/** Fixed-height terminal chrome; the transcript never owns these lines. */
export class TerminalChrome implements Component {
  #theme: BraidTheme
  #state: TerminalChromeState | undefined

  constructor(theme: BraidTheme) {
    this.#theme = theme
  }

  setState(state: TerminalChromeState): void {
    this.#state = state
  }

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.#state
    if (!state) return []
    const safeWidth = Math.max(1, Math.floor(width))
    const { view } = state
    const target = executionTargetFor(view)
    const mode = modeForColumns(safeWidth)
    const header = this.#header(view, target, safeWidth, mode)
    const status = fitAtomic(
      statusText(this.#theme, view, conciseStatus(view, state.quitArmed)),
      safeWidth,
    )
    const profile = valuePart(this.#theme, `AgentProfile ${target.profileName}`)
    const runner = valuePart(this.#theme, `runner ${target.runner}`)
    const model = valuePart(this.#theme, `model ${target.model}`)
    const effort = target.effort ? valuePart(this.#theme, `thinking ${target.effort}`) : ''
    const outputLimit =
      target.maxOutputTokens === undefined
        ? ''
        : valuePart(this.#theme, `output ≤${compactNumber(target.maxOutputTokens)}`)
    const connection = valuePart(this.#theme, target.connection)
    const execution = valuePart(this.#theme, executionLabel(target))
    const metrics = metricsFor(view).map((metric) => valuePart(this.#theme, metric))
    const hint = valuePart(this.#theme, navigationHint(view, state.navigationHint))

    if (mode === 'narrow') {
      const route = joinPrefix(
        [runner, valuePart(this.#theme, `model ${compactModelName(target.model)}`)],
        safeWidth,
      )
      return [
        header,
        fitAtomic([status, route].filter((part) => part.length > 0).join(' · '), safeWidth),
        fitAtomic(joinPrefix([connection, effort, outputLimit], safeWidth), safeWidth),
      ]
    }

    const statusMetadata =
      mode === 'wide' ? [model, effort, outputLimit, ...metrics] : [model, effort, outputLimit]
    return [
      header,
      fitColumns([status], statusMetadata, safeWidth),
      fitColumns([profile, runner, connection, execution], [hint], safeWidth),
    ]
  }

  #header(
    view: BraidViewModel,
    target: ExecutionTargetView,
    width: number,
    mode: LayoutMode,
  ): string {
    if (mode === 'narrow') {
      return fitAtomic(
        `${this.#theme.brand('braid')}  ${valuePart(this.#theme, `AgentProfile ${target.profileName}`)}`,
        width,
      )
    }
    const workspace = fieldPart(this.#theme, 'cwd', workspaceBasename(view.workspace))
    const session = fieldPart(
      this.#theme,
      'session',
      cleanField(view.conversationTitle) || 'new conversation',
    )
    const branch = fieldPart(this.#theme, 'branch', view.branch)
    const parts = [this.#theme.brand('braid'), workspace, session]
    if (mode === 'wide' && branch) parts.push(branch)
    return joinHeader(parts, width)
  }
}

function compactModelName(value: string): string {
  const safe = cleanField(value)
  const segments = safe.split('/').filter((segment) => segment.length > 0)
  return segments.at(-1) ?? safe
}

function executionLabel(target: ExecutionTargetView): string {
  const environment = target.environment
  if (environment === undefined) return ''
  const location = environment.location === 'local' ? 'local' : environment.location
  const executionKind =
    environment.kind === 'sandbox'
      ? 'sandbox'
      : environment.provider === 'cli-bridge'
        ? 'CLI'
        : environment.provider
  return `exec ${location ?? 'unknown'} ${executionKind} · ${environment.lifecycle}`
}

function statusText(theme: BraidTheme, view: BraidViewModel, value: string): string {
  const safe = sanitizeNotification(value)
  if (view.status === 'failed' || view.status === 'storage-failure') return theme.danger(safe)
  if (view.status === 'running' || view.status === 'waiting' || view.status === 'cancelling')
    return theme.warning(safe)
  if (view.status === 'cancelled' || view.status === 'expired') return theme.warning(safe)
  return theme.success(safe)
}

function conciseStatus(view: BraidViewModel, quitArmed: boolean): string {
  if (quitArmed) return 'ctrl+c again to quit'
  const notification = sanitizeNotification(view.notice ?? view.statusText)
  if (
    view.activeRunId !== undefined &&
    (view.status === 'starting' ||
      view.status === 'streaming' ||
      view.status === 'running' ||
      view.status === 'waiting')
  ) {
    return `${notification || view.status} · Ctrl+C cancel`
  }
  if (view.status === 'failed' || view.status === 'unknown') {
    const run = view.runs.at(-1)
    if (run !== undefined) {
      const outcome = run.completeness === 'unknown' ? 'outcome unknown' : 'outcome failed'
      return `${outcome} · operation ${shortIdentifier(run.operationId ?? run.id)}`
    }
  }
  if (notification.length > 0) return notification
  return cleanField(view.status) || 'unknown'
}

function navigationHint(view: BraidViewModel, fallback: string): string {
  if (view.activeRunId !== undefined) return 'Enter queues input'
  if (view.status === 'failed' || view.status === 'unknown') {
    return '/export preserve · /new continue'
  }
  return fallback
}

function shortIdentifier(value: string): string {
  const safe = cleanField(value)
  return safe.length <= 18 ? safe : `${safe.slice(0, 10)}…${safe.slice(-6)}`
}

function cleanField(value: string | null | undefined): string {
  return value === undefined || value === null
    ? ''
    : sanitizeTerminalText(value)
        .replace(/[\n\t]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
}

function workspaceBasename(workspace: string | null | undefined): string {
  const safe = cleanField(workspace)
  if (!safe) return 'workspace'
  const trimmed = safe.replace(/[\\/]+$/gu, '')
  if (!trimmed) return 'workspace'
  const pieces = trimmed.split(/[\\/]/u).filter((piece) => piece.length > 0)
  if (pieces.length <= 1) return safe
  return pieces.at(-1) ?? 'workspace'
}

function valuePart(theme: BraidTheme, value: string): string {
  const safe = cleanField(value)
  return safe ? theme.text(safe) : ''
}

function fieldPart(theme: BraidTheme, label: string, value: string | null | undefined): string {
  const safeLabel = cleanField(label)
  const safeValue = cleanField(value)
  if (!safeLabel || !safeValue) return ''
  return `${theme.muted(safeLabel)}  ${theme.text(safeValue)}`
}

function joinHeader(parts: readonly string[], width: number): string {
  const present = parts.filter((part) => part.length > 0)
  if (present.length === 0) return ''
  const base = joinPrefix(present.slice(0, 2), width, '  ')
  if (present.length <= 2 || !base) return base
  let result = base
  for (const part of present.slice(2)) {
    const candidate = `${result}  ·  ${part}`
    if (visibleWidth(candidate) > width) break
    result = candidate
  }
  return result
}

function joinPrefix(parts: readonly string[], width: number, separator = ' · '): string {
  const present = parts.filter((part) => part.length > 0)
  let result = ''
  for (const part of present) {
    const candidate = result ? `${result}${separator}${part}` : part
    if (visibleWidth(candidate) > width) break
    result = candidate
  }
  return result
}

function fitAtomic(value: string, width: number): string {
  return truncateToWidth(value, width, '…')
}

function prefixes(parts: readonly string[], width: number, separator: string): readonly string[] {
  const present = parts.filter((part) => part.length > 0)
  const result = ['']
  let current = ''
  for (const part of present) {
    const candidate = current ? `${current}${separator}${part}` : part
    if (visibleWidth(candidate) > width) break
    result.push(candidate)
    current = candidate
  }
  return result
}

export function metricsFor(view: BraidViewModel): string[] {
  const totals = view.sessionUsage.turns
  if (hasMeasurementTelemetry(view.sessionUsage)) {
    return [
      usageGroup('turns', totals),
      usageGroup('analysis', view.sessionUsage.analyses),
      usageGroup('workers', view.sessionUsage.delegated),
    ].filter((value): value is string => value !== undefined)
  }
  if (totals.sourceCount === 0) return []

  return legacyMetricsFor(view)
}

function legacyMetricsFor(view: BraidViewModel): string[] {
  const totals = view.sessionUsage.turns
  const input = totals.input
  const output = totals.output
  const cost = totals.costUsd
  const tokenPrefix = totals.tokenStatus === 'complete' ? '' : '≥'
  const metrics: string[] = []
  const noObservedTokens = (input ?? 0) === 0 && (output ?? 0) === 0
  const tokenUsageUnknown = totals.tokenStatus !== 'complete' && noObservedTokens
  if (tokenUsageUnknown) {
    metrics.push('usage unknown')
  }
  if (input !== undefined && !tokenUsageUnknown)
    metrics.push(`in ${tokenPrefix}${compactNumber(input)}`)
  if (output !== undefined && !tokenUsageUnknown)
    metrics.push(`out ${tokenPrefix}${compactNumber(output)}`)
  if (totals.costStatus === 'reported' && cost !== undefined && Number.isFinite(cost)) {
    metrics.push(`$${cost.toFixed(4)}`)
  } else if (cost !== undefined && cost > 0 && Number.isFinite(cost)) {
    metrics.push(`≥$${cost.toFixed(4)}`)
  } else if (totals.estimatedCostUsd !== undefined && totals.estimatedCostUsd > 0) {
    metrics.push(`~$${totals.estimatedCostUsd.toFixed(4)}`)
  } else if (!tokenUsageUnknown) {
    metrics.push('cost unknown')
  }
  if ((totals.llmCalls ?? 0) > 0) metrics.push(`${totals.llmCalls} calls`)
  if ((totals.llmLatencyMs ?? 0) > 0)
    metrics.push(`${Math.round(totals.llmLatencyMs ?? 0)}ms model`)
  const analyses = view.sessionUsage.analyses
  if (analyses.sourceCount > 0) {
    const exact = analyses.costStatus === 'reported'
    metrics.push(
      analyses.costUsd === undefined || (!exact && analyses.costUsd === 0)
        ? 'analysis $unknown'
        : `analysis ${exact ? '' : '≥'}$${analyses.costUsd.toFixed(4)}`,
    )
  }
  const delegated = view.sessionUsage.delegated
  if (delegated.sourceCount > 0) {
    metrics.push(
      delegated.costUsd === undefined || delegated.costUsd === 0
        ? 'workers $unknown'
        : `workers ≥$${delegated.costUsd.toFixed(4)}`,
    )
  }
  return metrics
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

function usageGroup(label: string, usage: UsageTotalsView): string | undefined {
  if (usage.sourceCount === 0) return undefined
  const metrics = [...tokenMetrics(usage), costMetric(usage)].filter(
    (value): value is string => value !== undefined,
  )
  const calls = measurementMetric(
    'calls',
    usage.llmCalls,
    usage.callStatus,
    usage.unknownCallSources,
    (value) => String(Math.round(value)),
  )
  const latency = measurementMetric(
    'model',
    usage.llmLatencyMs,
    usage.latencyStatus,
    usage.unknownLatencySources,
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

function costMetric(usage: UsageTotalsView): string | undefined {
  if (
    usage.costStatus === undefined &&
    usage.costUsd === undefined &&
    usage.estimatedCostUsd === undefined
  ) {
    return undefined
  }
  const cost = usage.costUsd
  if (usage.costStatus === 'reported' && cost !== undefined && Number.isFinite(cost)) {
    return `$${cost.toFixed(4)}`
  }
  if (cost !== undefined && cost > 0 && Number.isFinite(cost)) {
    return `≥$${cost.toFixed(4)}`
  }
  if (usage.estimatedCostUsd !== undefined && usage.estimatedCostUsd > 0) {
    return `~$${usage.estimatedCostUsd.toFixed(4)}`
  }
  return usage.costStatus === undefined ? undefined : 'cost unknown'
}

function measurementMetric(
  label: string,
  value: number | undefined,
  status: UsageMeasurementStatus | undefined,
  unknownSources: number | undefined,
  format: (value: number) => string,
): string | undefined {
  if (status === undefined && value === undefined && unknownSources === undefined) return undefined
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

function fitColumns(left: readonly string[], right: readonly string[], width: number): string {
  const leftPrefixes = prefixes(left, width, ' · ')
  const rightPrefixes = prefixes(right, width, ' · ')
  let best = ''
  let bestScore = -1
  for (let leftIndex = 0; leftIndex < leftPrefixes.length; leftIndex += 1) {
    const leftValue = leftPrefixes[leftIndex] ?? ''
    for (let rightIndex = 0; rightIndex < rightPrefixes.length; rightIndex += 1) {
      const rightValue = rightPrefixes[rightIndex] ?? ''
      if (!leftValue && !rightValue) continue
      const gap = width - visibleWidth(leftValue) - visibleWidth(rightValue)
      if (leftValue && rightValue && gap < 2) continue
      const candidate =
        leftValue && rightValue
          ? `${leftValue}${' '.repeat(gap)}${rightValue}`
          : leftValue || rightValue
      const score = (leftValue && rightValue ? 1_000 : 0) + leftIndex * 10 + rightIndex
      if (score > bestScore && visibleWidth(candidate) <= width) {
        best = candidate
        bestScore = score
      }
    }
  }
  return best
}
