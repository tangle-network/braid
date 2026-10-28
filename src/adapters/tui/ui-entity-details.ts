import { resultFromComparisonRecord } from '../../app/analysis-comparison-record.js'
import type { AnalysisRecord } from '../../domain/entities.js'
import type { SupervisorRecord, WorkerRecord } from '../../domain/entities-runtime.js'
import type { BraidState } from '../../domain/state.js'
import { analysisLines, analysisViewForRecord } from '../../views/shared/analysis-presentation.js'
import {
  comparisonLines,
  comparisonViewForResult,
} from '../../views/shared/comparison-presentation.js'
import {
  environmentDetailLines,
  environmentView,
} from '../../views/shared/environment-presentation.js'
import type { ActivityItemView, EntityDetailView } from '../../views/shared/models.js'
import { sanitizeTerminalText } from '../../views/shared/sanitize.js'
import { omitUnreportedCostAndLatency } from '../../views/tui/measurement-display.js'

const MAX_DETAIL_LINES = 256

/** Builds rich details only for the bounded activity window shown by the terminal. */
export function entityDetailsFor(
  state: BraidState,
  activity: readonly ActivityItemView[],
): EntityDetailView[] {
  const wanted = new Map<string, Set<string>>()
  for (const item of activity) {
    if (item.entityType === undefined || item.entityId === undefined) continue
    const ids = wanted.get(item.entityType) ?? new Set<string>()
    ids.add(item.entityId)
    wanted.set(item.entityType, ids)
  }
  const analyses = selectedRecords(state.analyses, wanted.get('analysis'))
  const supervisors = selectedRecords(state.supervisors, wanted.get('supervisor'))
  const workers = selectedRecords(state.workers, wanted.get('worker'))
  const environments = selectedRecords(state.environments, wanted.get('environment'))
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

function selectedRecords<T extends { readonly id: string }>(
  records: readonly T[],
  ids: ReadonlySet<string> | undefined,
): ReadonlyMap<string, T> {
  if (ids === undefined || ids.size === 0) return new Map()
  const selected = new Map<string, T>()
  for (const record of records) {
    const id = String(record.id)
    if (!ids.has(id)) continue
    selected.set(id, record)
    if (selected.size === ids.size) break
  }
  return selected
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
  const visible = omitUnreportedCostAndLatency(rendered)
  return {
    entityType: 'analysis',
    entityId: String(record.id),
    title: visible[0] ?? `analysis ${record.id}`,
    status: record.status,
    lines: bounded(visible.slice(1)),
    analysisFindingCount: analysis.findings.length,
    analysisSupportedFindingCount: analysis.citationSupport.supportedFindings,
    analysisCitationSupport: analysis.citationSupport.status,
    ...(analysis.execution === undefined ? {} : { analysisExecution: analysis.execution }),
  }
}

function supervisorDetail(record: SupervisorRecord | undefined): EntityDetailView | undefined {
  if (record === undefined) return undefined
  return {
    entityType: 'supervisor',
    ...(record.remoteEndpointEnv === undefined ? {} : { runtimeReadOnly: true as const }),
    entityId: String(record.id),
    title: safe(record.title ?? `supervisor ${record.id}`),
    status: record.status,
    lines: [
      ...(record.remoteEndpointEnv === undefined
        ? []
        : [
            `Runtime tree · read-only`,
            `conversation: ${safe(record.conversationId ?? 'unbound')}`,
          ]),
      `id: ${safe(record.id)}`,
      `runtime id: ${safe(record.runtimeId)}`,
      ...(record.remoteEndpointEnv === undefined
        ? [
            `run: ${record.rootRunId === undefined ? 'unbound workspace activity' : safe(record.rootRunId)}`,
          ]
        : []),
      `status: ${safe(record.status)}`,
      ...(record.driverModel === undefined ? [] : [`driver model: ${safe(record.driverModel)}`]),
      ...(record.workerModel === undefined ? [] : [`worker model: ${safe(record.workerModel)}`]),
      ...(record.totalUsage === undefined
        ? []
        : [
            `tree usage: ${usageLine(record.totalUsage)}`,
            `tree latency: ${record.totalUsage.latencyMs}ms${record.workerCount === undefined ? '' : ` · workers ${record.workerCount}`}`,
          ]),
      ...(record.driverUsage === undefined
        ? []
        : [`driver usage: ${usageLine(record.driverUsage)}`]),
      `${record.remoteEndpointEnv === undefined ? 'started' : 'first observed'}: ${safe(record.createdAt)}`,
      `${record.remoteEndpointEnv === undefined ? 'updated' : 'last recorded change'}: ${safe(record.updatedAt)}`,
    ],
  }
}

function workerDetail(record: WorkerRecord | undefined): EntityDetailView | undefined {
  if (record === undefined) return undefined
  if (record.role !== undefined) {
    return {
      entityType: 'worker',
      runtimeReadOnly: true,
      entityId: String(record.id),
      title: safe(record.title ?? record.runtimeId),
      status: record.status,
      lines: bounded([
        `${safe(record.title ?? record.runtimeId)} · ${record.role} · ${safe(record.runner ?? 'runner unknown')}`,
        `status: ${safe(record.status)}`,
        `parent: ${safe(record.parentRuntimeRef ?? 'Runtime root')}`,
        safe(record.streamStatus ?? 'select this agent to read live events'),
        ...(record.logTail === undefined ? [] : record.logTail.split('\n').map(safe)),
        `Runtime id: ${safe(record.runtimeId)}`,
      ]),
    }
  }
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
    ...(record.estimatedSpendUsd === undefined
      ? []
      : [`estimated cost: ~$${record.estimatedSpendUsd.toFixed(4)} (billed cost unknown)`]),
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

function usageLine(usage: NonNullable<SupervisorRecord['totalUsage']>): string {
  const prefix =
    usage.completeness === 'observed-floor' ? '≥' : usage.completeness === 'unknown' ? '?' : ''
  const cost =
    usage.completeness === 'unknown' || usage.spendUsd === undefined
      ? 'cost unknown'
      : `${prefix}$${usage.spendUsd.toFixed(4)}`
  const estimate =
    usage.estimatedSpendUsd === undefined
      ? ''
      : ` · estimated ~$${usage.estimatedSpendUsd.toFixed(4)} (billed cost unknown)`
  return `${prefix}${usage.inputTokens} in · ${prefix}${usage.outputTokens} out · ${cost}${estimate} · ${usage.completeness}`
}

function bounded(lines: readonly string[]): readonly string[] {
  return lines.length <= MAX_DETAIL_LINES
    ? lines
    : [...lines.slice(0, MAX_DETAIL_LINES - 1), '… additional details not shown']
}

function safe(value: string): string {
  return sanitizeTerminalText(value)
}
