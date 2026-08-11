import { resultFromComparisonRecord } from '../../app/analysis-comparison-record.js'
import type { AnalysisRecord } from '../../domain/entities.js'
import type { SupervisorRecord, WorkerRecord } from '../../domain/entities-runtime.js'
import type { BraidState } from '../../domain/state.js'
import { analysisLines, analysisViewForRecord } from '../../views/shared/analysis-presentation.js'
import {
  comparisonLines,
  comparisonViewForResult,
} from '../../views/shared/comparison-presentation.js'
import type { ActivityItemView, EntityDetailView } from '../../views/shared/models.js'
import { sanitizeTerminalText } from '../../views/shared/sanitize.js'
import {
  environmentDetailLines,
  environmentView,
} from '../../views/shared/environment-presentation.js'

const MAX_DETAIL_LINES = 256

/** Builds rich details only for the bounded activity window shown by the terminal. */
export function entityDetailsFor(
  state: BraidState,
  activity: readonly ActivityItemView[],
): EntityDetailView[] {
  const analyses = new Map(state.analyses.map((record) => [String(record.id), record] as const))
  const supervisors = new Map(
    state.supervisors.map((record) => [String(record.id), record] as const),
  )
  const workers = new Map(state.workers.map((record) => [String(record.id), record] as const))
  const environments = new Map(
    state.environments.map((record) => [String(record.id), record] as const),
  )
  const seen = new Set<string>()
  const details: EntityDetailView[] = []

  for (const item of activity) {
    if (item.entityType === undefined || item.entityId === undefined) continue
    const key = `${item.entityType}:${item.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    const detail =
      item.entityType === 'analysis'
        ? analysisDetail(analyses.get(item.entityId))
        : item.entityType === 'supervisor'
          ? supervisorDetail(supervisors.get(item.entityId))
          : item.entityType === 'worker'
            ? workerDetail(workers.get(item.entityId))
            : item.entityType === 'environment'
              ? environmentDetail(environments.get(item.entityId))
              : undefined
    if (detail !== undefined) details.push(detail)
  }
  return details
}

function environmentDetail(
  record: BraidState['environments'][number] | undefined,
): EntityDetailView | undefined {
  if (record === undefined) return undefined
  const view = environmentView(record)
  return {
    entityType: 'environment',
    entityId: String(record.id),
    title: `${view.provider} execution`,
    status: record.lifecycle,
    lines: bounded(environmentDetailLines(view)),
  }
}

function analysisDetail(record: AnalysisRecord | undefined): EntityDetailView | undefined {
  if (record === undefined) return undefined
  const analysis = analysisViewForRecord(record)
  const rendered =
    record.kind === 'comparison' && record.comparison !== undefined
      ? comparisonLines(comparisonViewForResult(resultFromComparisonRecord(record)))
      : analysisLines(analysis)
  return {
    entityType: 'analysis',
    entityId: String(record.id),
    title: rendered[0] ?? `analysis ${record.id}`,
    status: record.status,
    lines: bounded(rendered.slice(1)),
    ...(analysis.execution === undefined ? {} : { analysisExecution: analysis.execution }),
  }
}

function supervisorDetail(record: SupervisorRecord | undefined): EntityDetailView | undefined {
  if (record === undefined) return undefined
  return {
    entityType: 'supervisor',
    entityId: String(record.id),
    title: safe(record.title ?? `supervisor ${record.id}`),
    status: record.status,
    lines: [
      `id: ${safe(record.id)}`,
      `runtime id: ${safe(record.runtimeId)}`,
      `run: ${record.rootRunId === undefined ? 'unbound workspace activity' : safe(record.rootRunId)}`,
      `status: ${safe(record.status)}`,
      ...(record.driverModel === undefined ? [] : [`driver model: ${safe(record.driverModel)}`]),
      ...(record.workerModel === undefined ? [] : [`worker model: ${safe(record.workerModel)}`]),
      ...(record.totalUsage === undefined
        ? []
        : [
            `tree usage: ${usageLine(record.totalUsage.inputTokens, record.totalUsage.outputTokens, record.totalUsage.spendUsd, record.totalUsage.completeness)}`,
            `tree latency: ${record.totalUsage.latencyMs}ms · workers ${record.workerCount ?? 'unknown'}`,
          ]),
      ...(record.driverUsage === undefined
        ? []
        : [
            `driver usage: ${usageLine(record.driverUsage.inputTokens, record.driverUsage.outputTokens, record.driverUsage.spendUsd, record.driverUsage.completeness)}`,
          ]),
      `started: ${safe(record.createdAt)}`,
      `updated: ${safe(record.updatedAt)}`,
    ],
  }
}

function workerDetail(record: WorkerRecord | undefined): EntityDetailView | undefined {
  if (record === undefined) return undefined
  const lines = [
    `id: ${safe(record.id)}`,
    `runtime id: ${safe(record.runtimeId)}`,
    `status: ${safe(record.status)}`,
    `supervisor: ${safe(record.supervisorId)}`,
    ...(record.parentRuntimeRef === undefined
      ? []
      : [
          `runtime parent: ${safe(record.parentRuntimeRef)}${record.parentWorkerId === undefined ? ' (unresolved)' : ''}`,
        ]),
    ...(record.parentWorkerId === undefined
      ? []
      : [`parent worker: ${safe(record.parentWorkerId)}`]),
    ...(record.runId === undefined ? [] : [`run: ${safe(record.runId)}`]),
    ...(record.runner === undefined ? [] : [`runner: ${safe(record.runner)}`]),
    ...(record.spendUsd === undefined
      ? []
      : [
          `cost: ${record.usageCompleteness === 'observed-floor' ? '≥' : ''}$${record.spendUsd.toFixed(4)}`,
        ]),
    ...(record.inputTokens === undefined
      ? []
      : [
          `input tokens: ${record.usageCompleteness === 'observed-floor' ? '≥' : ''}${record.inputTokens}`,
        ]),
    ...(record.outputTokens === undefined
      ? []
      : [
          `output tokens: ${record.usageCompleteness === 'observed-floor' ? '≥' : ''}${record.outputTokens}`,
        ]),
    ...(record.usageCompleteness === undefined ? [] : [`measurement: ${record.usageCompleteness}`]),
    ...(record.logTail === undefined
      ? []
      : record.logTail
          .split('\n')
          .map((line, index) => `${index === 0 ? 'latest: ' : '        '}${safe(line)}`)),
  ]
  return {
    entityType: 'worker',
    entityId: String(record.id),
    title: safe(record.title ?? `worker ${record.id}`),
    status: record.status,
    lines: bounded(lines),
  }
}

function usageLine(
  input: number,
  output: number,
  spendUsd: number,
  completeness: 'complete' | 'observed-floor' | 'unknown',
): string {
  const prefix = completeness === 'observed-floor' ? '≥' : completeness === 'unknown' ? '?' : ''
  return `${prefix}${input} in · ${prefix}${output} out · ${prefix}$${spendUsd.toFixed(4)} · ${completeness}`
}

function bounded(lines: readonly string[]): readonly string[] {
  return lines.length <= MAX_DETAIL_LINES
    ? lines
    : [...lines.slice(0, MAX_DETAIL_LINES - 1), '… additional details not shown']
}

function safe(value: string): string {
  return sanitizeTerminalText(value)
}
