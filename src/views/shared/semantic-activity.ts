import type { BraidState } from '../../domain/state.js'
import { sanitizeTerminalText, sanitizeTitle } from './sanitize.js'
import { compareSemanticText } from './semantic-graph-filters.js'
import {
  assertRunScope,
  isInScope,
  resolveScope,
  type SemanticQueryScope,
} from './semantic-query-scope.js'
import type {
  ActivityQueryResult,
  SemanticActivityItem,
  SemanticNodeType,
} from './semantic-query-types.js'

const MAX_ACTIVITY_ITEMS = 2_048

function safe(value: string): string {
  return sanitizeTerminalText(value)
}

function safeTitle(value: string): string {
  return sanitizeTitle(value) || '[untitled]'
}

function elapsedMs(startedAt: string, endedAt: string | undefined): number | undefined {
  if (endedAt === undefined) return undefined
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : undefined
}

function kindForActivity(type: string): SemanticActivityItem['kind'] {
  const normalized = type.toLowerCase()
  if (normalized.includes('tool')) return 'tool'
  if (normalized.includes('interaction') || normalized.includes('question')) return 'interaction'
  if (normalized.includes('analysis')) return 'analysis'
  if (normalized.includes('worker')) return 'worker'
  if (normalized === 'run') return 'run'
  return 'system'
}

function add(
  output: SemanticActivityItem[],
  item: Omit<SemanticActivityItem, 'id'> & { readonly id: string },
): void {
  output.push(item)
}

function includeRun(
  state: BraidState,
  run: BraidState['runs'][number],
  scope: SemanticQueryScope,
  runId: string | undefined,
): boolean {
  return (runId === undefined || run.id === runId) && isInScope(state, 'run', run.id, scope)
}

function activityForRun(
  state: BraidState,
  run: BraidState['runs'][number],
  output: SemanticActivityItem[],
): void {
  const runElapsedMs = elapsedMs(run.startedAt, run.terminalAt)
  add(output, {
    id: `run:${run.id}`,
    kind: 'run',
    title: `run ${safe(run.id)}`,
    status: run.status,
    occurredAt: run.startedAt,
    ...(run.error === undefined ? {} : { detail: safe(run.error) }),
    runId: run.id,
    entityType: 'run',
    entityId: run.id,
    ...(runElapsedMs === undefined ? {} : { elapsedMs: runElapsedMs }),
  })

  for (const item of run.activity) {
    const occurredAt = item.source?.occurredAt ?? run.updatedAt
    add(output, {
      id: `activity:${item.id}`,
      kind: kindForActivity(item.type),
      title: safeTitle(item.label),
      status: run.status,
      occurredAt,
      ...(item.detail === undefined ? {} : { detail: safe(item.detail) }),
      ...(item.source?.eventId === undefined ? {} : { sourceEventId: safe(item.source.eventId) }),
      runId: run.id,
      entityType: 'run',
      entityId: run.id,
    })
  }

  for (const event of run.eventDetails) {
    add(output, {
      id: `event:${run.id}:${event.eventId}`,
      kind: 'system',
      title: `event ${safe(event.type)}`,
      status: run.status,
      occurredAt: event.occurredAt ?? run.updatedAt,
      detail: `sequence ${event.sequence}`,
      sourceEventId: safe(event.eventId),
      runId: run.id,
      entityType: 'run',
      entityId: run.id,
    })
  }

  const seenInteractionIds = new Set<string>()
  for (const interaction of state.interactions) {
    if (interaction.runId !== run.id) continue
    seenInteractionIds.add(interaction.id)
    add(output, {
      id: `interaction:${interaction.id}`,
      kind: 'interaction',
      title: safeTitle(interaction.request.title),
      status: interaction.status,
      occurredAt: interaction.createdAt,
      ...(interaction.request.body === undefined ? {} : { detail: safe(interaction.request.body) }),
      runId: run.id,
      entityType: 'run',
      entityId: run.id,
    })
  }
  for (const interaction of run.interactions) {
    const id = interaction.request.id
    if (seenInteractionIds.has(id)) continue
    add(output, {
      id: `interaction:${id}`,
      kind: 'interaction',
      title: safeTitle(interaction.request.title),
      status: interaction.status,
      occurredAt: interaction.source.occurredAt ?? run.updatedAt,
      ...(interaction.request.body === undefined ? {} : { detail: safe(interaction.request.body) }),
      ...(interaction.source.eventId === undefined
        ? {}
        : { sourceEventId: safe(interaction.source.eventId) }),
      runId: run.id,
      entityType: 'run',
      entityId: run.id,
    })
  }
}

function activityForAnalysis(analysis: BraidState['analyses'][number]): SemanticActivityItem {
  return {
    id: `analysis:${analysis.id}`,
    kind: 'analysis',
    title: safeTitle(analysis.recipe ?? `analysis ${analysis.id}`),
    status: analysis.status,
    occurredAt: analysis.updatedAt,
    ...(analysis.question === undefined ? {} : { detail: safe(analysis.question) }),
    entityType: 'analysis',
    entityId: analysis.id,
    ...(analysis.source.runId === undefined ? {} : { runId: analysis.source.runId }),
  }
}

function activityForWorker(worker: BraidState['workers'][number]): SemanticActivityItem {
  return {
    id: `worker:${worker.id}`,
    kind: 'worker',
    title: safeTitle(worker.title ?? `worker ${worker.id}`),
    status: worker.status,
    occurredAt: worker.updatedAt,
    ...(worker.logTail === undefined ? {} : { detail: safe(worker.logTail) }),
    ...(worker.runId === undefined ? {} : { runId: worker.runId }),
    entityType: 'worker',
    entityId: worker.id,
  }
}

function compare(left: SemanticActivityItem, right: SemanticActivityItem): number {
  const dates = Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
  if (Number.isFinite(dates) && dates !== 0) return dates
  const kinds = compareSemanticText(left.kind, right.kind)
  if (kinds !== 0) return kinds
  return compareSemanticText(left.id, right.id)
}

export function queryActivity(
  state: BraidState,
  input: {
    readonly conversationId?: string
    readonly branchId?: string
    readonly runId?: string
  } = {},
): ActivityQueryResult {
  const scope = resolveScope(state, input)
  if (input.runId !== undefined) assertRunScope(state, input.runId, scope)
  const output: SemanticActivityItem[] = []
  for (const run of state.runs) {
    if (includeRun(state, run, scope, input.runId)) activityForRun(state, run, output)
  }
  for (const analysis of state.analyses) {
    if (
      isInScope(state, 'analysis', analysis.id, scope) &&
      (input.runId === undefined || analysis.source.runId === input.runId)
    ) {
      output.push(activityForAnalysis(analysis))
    }
  }
  for (const worker of state.workers) {
    if (
      isInScope(state, 'worker', worker.id, scope) &&
      (input.runId === undefined || worker.runId === input.runId)
    ) {
      output.push(activityForWorker(worker))
    }
  }
  output.sort(compare)
  return {
    ...(scope.conversationId === undefined ? {} : { conversationId: scope.conversationId }),
    ...(scope.branchId === undefined ? {} : { branchId: scope.branchId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    activity: output.slice(-MAX_ACTIVITY_ITEMS),
  }
}

export type { SemanticNodeType }
