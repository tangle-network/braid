import type { AnalysisRecord } from '../../domain/entities.js'
import { resultFromComparisonRecord } from '../../app/analysis-comparison-record.js'
import { analysisLines, analysisViewForRecord } from '../../views/shared/analysis-presentation.js'
import {
  comparisonLines,
  comparisonViewForResult,
  isAnalysisComparisonResult,
} from '../../views/shared/comparison-presentation.js'
import type {
  ActivityItemView,
  BraidViewModel,
  EntityDetailView,
} from '../../views/shared/models.js'
import { freezeView } from '../../views/shared/models.js'
import { sanitizeTerminalText } from '../../views/shared/sanitize.js'
import { viewStatusForSemanticStatus } from '../../views/shared/semantic-query-types.js'
import { MAX_VISIBLE_RUNS } from './ui-projection.js'

export interface IntelligenceResultViewOptions {
  readonly durableAnalyses: readonly AnalysisRecord[]
  readonly allowUnpersisted?: boolean
}

/** Pins one accepted intelligence result into the bounded browser projection. */
export function withIntelligenceResult(
  view: BraidViewModel,
  data: unknown,
  options: IntelligenceResultViewOptions,
): BraidViewModel {
  const analysis = selectedAnalysis(data, options)
  if (analysis !== undefined) {
    const analysisView = analysisViewForRecord(analysis)
    const rendered = analysisLines(analysisView)
    return attach(
      view,
      {
        id: `analysis:${analysis.id}`,
        kind: 'analysis',
        title: rendered[0] ?? `analysis ${analysis.id}`,
        status: viewStatusForSemanticStatus(analysis.status),
        ...(analysis.question === undefined
          ? {}
          : { detail: sanitizeTerminalText(analysis.question) }),
        occurredAt: analysis.updatedAt,
        ...(analysis.source.runId === undefined ? {} : { runId: analysis.source.runId }),
        entityType: 'analysis',
        entityId: String(analysis.id),
      },
      {
        entityType: 'analysis',
        entityId: String(analysis.id),
        title: rendered[0] ?? `analysis ${analysis.id}`,
        status: analysis.status,
        lines: rendered.slice(1),
        analysisFindingCount: analysisView.findings.length,
        analysisSupportedFindingCount: analysisView.citationSupport.supportedFindings,
        analysisCitationSupport: analysisView.citationSupport.status,
        ...(analysisView.execution === undefined
          ? {}
          : { analysisExecution: analysisView.execution }),
      },
    )
  }

  const comparisonId = comparisonAnalysisId(data)
  if (comparisonId === undefined || !isAnalysisComparisonResult(data)) return view
  const durable = options.durableAnalyses.find((candidate) => String(candidate.id) === comparisonId)
  if (durable === undefined && options.allowUnpersisted !== true) return view
  const comparison =
    durable === undefined
      ? data
      : durable.comparison === undefined
        ? undefined
        : resultFromComparisonRecord(durable)
  if (comparison === undefined) return view
  const rendered = comparisonLines(comparisonViewForResult(comparison))
  return attach(
    view,
    {
      id: `analysis:${comparisonId}`,
      kind: 'analysis',
      title: rendered[0] ?? '/compare · frozen runs',
      status: viewStatusForSemanticStatus(durable?.status ?? 'completed'),
      ...(durable?.updatedAt === undefined ? {} : { occurredAt: durable.updatedAt }),
      ...(durable?.source.runId === undefined ? {} : { runId: durable.source.runId }),
      entityType: 'analysis',
      entityId: comparisonId,
    },
    {
      entityType: 'analysis',
      entityId: comparisonId,
      title: rendered[0] ?? '/compare · frozen runs',
      status: durable?.status ?? 'completed',
      lines: rendered.slice(1),
    },
  )
}

function attach(
  view: BraidViewModel,
  activity: ActivityItemView,
  detail: EntityDetailView,
): BraidViewModel {
  return freezeView({
    ...view,
    activity: Object.freeze(pinActivity(view.activity, Object.freeze(activity))),
    entityDetails: Object.freeze([
      ...(view.entityDetails ?? []).filter(
        (item) => item.entityType !== detail.entityType || item.entityId !== detail.entityId,
      ),
      Object.freeze(detail),
    ]),
  })
}

function pinActivity(
  visible: readonly ActivityItemView[],
  selected: ActivityItemView,
): readonly ActivityItemView[] {
  const insertionOrder = new Map(visible.map((item, index) => [item.id, index] as const))
  const selectedIsVisible = visible.some((item) => item.id === selected.id)
  const retained = selectedIsVisible
    ? visible.filter((item) => item.id !== selected.id).slice(-(MAX_VISIBLE_RUNS - 1))
    : visible.slice(-(MAX_VISIBLE_RUNS - 1))
  const merged = [...retained, selected]
  merged.sort((left, right) => compareActivity(left, right, insertionOrder, visible.length))
  return merged
}

function compareActivity(
  left: ActivityItemView,
  right: ActivityItemView,
  insertionOrder: ReadonlyMap<string, number>,
  nextInsertionOrder: number,
): number {
  const leftTime = left.occurredAt === undefined ? Number.NaN : Date.parse(left.occurredAt)
  const rightTime = right.occurredAt === undefined ? Number.NaN : Date.parse(right.occurredAt)
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime
  }
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1
  }
  const leftOrder = insertionOrder.get(left.id) ?? nextInsertionOrder
  const rightOrder = insertionOrder.get(right.id) ?? nextInsertionOrder
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function selectedAnalysis(
  data: unknown,
  options: IntelligenceResultViewOptions,
): AnalysisRecord | undefined {
  const parsed = analysisRecord(data)
  if (parsed === undefined) return undefined
  const durable = options.durableAnalyses.find((candidate) => String(candidate.id) === parsed.id)
  if (durable !== undefined) return durable
  return options.allowUnpersisted === true ? parsed : undefined
}

function analysisRecord(data: unknown): AnalysisRecord | undefined {
  if (!isRecord(data) || !isRecord(data.analysis)) return undefined
  const analysis = data.analysis
  if (
    typeof analysis.id !== 'string' ||
    typeof analysis.status !== 'string' ||
    typeof analysis.updatedAt !== 'string' ||
    !Array.isArray(analysis.findings) ||
    !isRecord(analysis.source) ||
    typeof analysis.source.digest !== 'string' ||
    typeof analysis.source.complete !== 'boolean'
  ) {
    return undefined
  }
  return analysis as unknown as AnalysisRecord
}

function comparisonAnalysisId(data: unknown): string | undefined {
  return isRecord(data) && typeof data.analysisId === 'string' ? data.analysisId : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
