import type { BraidViewModel, UsageMeasurementStatus, UsageTotalsView } from '../shared/models.js'
import { compactTerminalNumber } from './terminal-identity.js'

/** Returns only telemetry that the provider measured or priced. */
export function metricsFor(view: BraidViewModel): string[] {
  return [
    ...usageMetrics(view.sessionUsage.turns),
    usageGroup('analysis', view.sessionUsage.analyses),
    usageGroup('workers', view.sessionUsage.delegated),
  ].filter((value): value is string => value !== undefined)
}

function usageGroup(label: string, usage: UsageTotalsView): string | undefined {
  if (usage.sourceCount === 0) return undefined
  const metrics = usageMetrics(usage)
  if (metrics.length === 0) return undefined
  return `${label} ${metrics.join(' · ')}`
}

function usageMetrics(usage: UsageTotalsView): string[] {
  if (usage.sourceCount === 0) return []
  return [
    ...tokenMetrics(usage),
    costMetric(usage),
    measurementMetric('calls', usage.llmCalls, usage.callStatus, (value) =>
      String(Math.round(value)),
    ),
    measurementMetric(
      'model',
      usage.llmLatencyMs,
      usage.latencyStatus,
      (value) => `${Math.round(value)}ms`,
    ),
  ].filter((value): value is string => value !== undefined)
}

function tokenMetrics(usage: UsageTotalsView): string[] {
  const input = finiteNonNegative(usage.input)
  const output = finiteNonNegative(usage.output)
  const noObservedTokens = (input ?? 0) === 0 && (output ?? 0) === 0
  if (usage.tokenStatus !== 'complete' && noObservedTokens) return []
  const prefix = usage.tokenStatus === 'complete' ? '' : '≥'
  return [
    ...(input === undefined ? [] : [`in ${prefix}${compactTerminalNumber(input)}`]),
    ...(output === undefined ? [] : [`out ${prefix}${compactTerminalNumber(output)}`]),
  ]
}

function costMetric(usage: UsageTotalsView): string | undefined {
  const reported = finiteNonNegative(usage.costUsd)
  if (usage.costStatus === 'reported' && reported !== undefined) {
    return `$${reported.toFixed(4)}`
  }
  const estimated = finiteNonNegative(usage.estimatedCostUsd)
  if (usage.costStatus === 'estimated' && estimated !== undefined) {
    return `~$${estimated.toFixed(4)}`
  }
  if (usage.costStatus === 'observed-floor' && reported !== undefined && reported > 0) {
    return `≥$${reported.toFixed(4)}`
  }
  return undefined
}

function measurementMetric(
  label: string,
  value: number | undefined,
  status: UsageMeasurementStatus | undefined,
  format: (value: number) => string,
): string | undefined {
  const measured = finiteNonNegative(value)
  if (measured === undefined || status === 'unknown') return undefined
  const prefix = status === 'partial' ? '≥' : ''
  return `${label} ${prefix}${format(measured)}`
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}
