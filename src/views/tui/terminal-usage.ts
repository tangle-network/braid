import type { BraidViewModel, UsageMeasurementStatus, UsageTotalsView } from '../shared/models.js'
import { compactTerminalNumber } from './terminal-identity.js'

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
    metrics.push(`in ${tokenPrefix}${compactTerminalNumber(input)}`)
  if (output !== undefined && !tokenUsageUnknown)
    metrics.push(`out ${tokenPrefix}${compactTerminalNumber(output)}`)
  if (totals.costStatus === 'reported' && cost !== undefined && Number.isFinite(cost)) {
    metrics.push(`$${cost.toFixed(4)}`)
  } else if (
    totals.costStatus === 'estimated' &&
    totals.estimatedCostUsd !== undefined &&
    Number.isFinite(totals.estimatedCostUsd) &&
    totals.estimatedCostUsd >= 0
  ) {
    metrics.push(`~$${totals.estimatedCostUsd.toFixed(4)}`)
  } else if (cost !== undefined && cost > 0 && Number.isFinite(cost)) {
    metrics.push(`≥$${cost.toFixed(4)}`)
  } else if (
    totals.estimatedCostUsd !== undefined &&
    Number.isFinite(totals.estimatedCostUsd) &&
    totals.estimatedCostUsd >= 0
  ) {
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
    'latency',
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
    ...(usage.input === undefined
      ? []
      : [`in ${tokenPrefix}${compactTerminalNumber(usage.input)}`]),
    ...(usage.output === undefined
      ? []
      : [`out ${tokenPrefix}${compactTerminalNumber(usage.output)}`]),
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
  if (
    usage.costStatus === 'estimated' &&
    usage.estimatedCostUsd !== undefined &&
    Number.isFinite(usage.estimatedCostUsd) &&
    usage.estimatedCostUsd >= 0
  ) {
    return `~$${usage.estimatedCostUsd.toFixed(4)}`
  }
  if (cost !== undefined && cost > 0 && Number.isFinite(cost)) {
    return `≥$${cost.toFixed(4)}`
  }
  if (
    usage.estimatedCostUsd !== undefined &&
    Number.isFinite(usage.estimatedCostUsd) &&
    usage.estimatedCostUsd >= 0
  ) {
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
