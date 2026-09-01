import type { BraidState } from '../../domain/state.js'
import { sanitizeTerminalText, sanitizeTitle } from './sanitize.js'
import { recentWorkersForActivity } from './semantic-activity-limit.js'
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

function activityForRun(run: BraidState['runs'][number], output: SemanticActivityItem[]): void {
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
    startedAt: run.startedAt,
    ...(runElapsedMs === undefined ? {} : { elapsedMs: runElapsedMs }),
  })

  for (const item of run.activity) {
    if (item.type === 'session.updated') continue
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
    if (event.type === 'session.updated') continue
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

  for (const interaction of run.interactions) {
    const id = interaction.request.id
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

function activityForSupervisor(
  supervisor: BraidState['supervisors'][number],
): SemanticActivityItem {
  const wallElapsedMs = elapsedMs(supervisor.createdAt, supervisor.updatedAt)
  return {
    id: `supervisor:${supervisor.id}`,
    kind: 'supervisor',
    title: safeTitle(supervisor.title ?? `supervisor ${supervisor.id}`),
    status: supervisor.status,
    occurredAt: supervisor.updatedAt,
    ...(supervisor.rootRunId === undefined ? {} : { runId: supervisor.rootRunId }),
    entityType: 'supervisor',
    entityId: supervisor.id,
    startedAt: supervisor.createdAt,
    ...(wallElapsedMs === undefined ? {} : { elapsedMs: wallElapsedMs }),
  }
}

function activityForWorker(
  worker: BraidState['workers'][number],
  rootRunId: string | undefined,
): SemanticActivityItem {
  const runId = worker.runId ?? rootRunId
  const wallElapsedMs = elapsedMs(worker.createdAt, worker.updatedAt)
  return {
    id: `worker:${worker.id}`,
    kind: 'worker',
    title: safeTitle(worker.title ?? `worker ${worker.id}`),
    status: worker.status,
    occurredAt: worker.updatedAt,
    ...(worker.logTail === undefined ? {} : { detail: safe(worker.logTail) }),
    ...(runId === undefined ? {} : { runId }),
    entityType: 'worker',
    entityId: worker.id,
    startedAt: worker.createdAt,
    ...(wallElapsedMs === undefined ? {} : { elapsedMs: wallElapsedMs }),
  }
}

function activityForEnvironment(
  environment: BraidState['environments'][number],
  runId: string | undefined,
): SemanticActivityItem {
  return {
    id: `environment:${environment.id}`,
    kind: 'environment',
    title: safeTitle(`${environment.placement.provider} execution`),
    status: environment.lifecycle,
    occurredAt: environment.updatedAt,
    detail: `${environment.kind ?? 'execution'} · ${environment.location ?? 'unknown location'} · ${environment.cleanup ?? 'unknown cleanup'}`,
    ...(runId === undefined ? {} : { runId }),
    entityType: 'environment',
    entityId: environment.id,
    startedAt: environment.startedAt ?? environment.createdAt,
  }
}

function compare(
  left: SemanticActivityItem,
  right: SemanticActivityItem,
  insertionOrder: ReadonlyMap<string, number>,
): number {
  const dates = Date.parse(left.occurredAt) - Date.parse(right.occurredAt)
  if (Number.isFinite(dates) && dates !== 0) return dates
  const kinds = compareSemanticText(left.kind, right.kind)
  if (kinds !== 0) return kinds
  const order = (insertionOrder.get(left.id) ?? 0) - (insertionOrder.get(right.id) ?? 0)
  return order === 0 ? compareSemanticText(left.id, right.id) : order
}

export function queryActivity(
  state: BraidState,
  input: {
    readonly conversationId?: string
    readonly branchId?: string
    readonly runId?: string
    readonly limit?: number
  } = {},
): ActivityQueryResult {
  const scope = resolveScope(state, input)
  if (input.runId !== undefined) assertRunScope(state, input.runId, scope)
  const output: SemanticActivityItem[] = []
  for (const run of state.runs) {
    if (includeRun(state, run, scope, input.runId)) activityForRun(run, output)
  }
  for (const analysis of state.analyses) {
    if (
      isInScope(state, 'analysis', analysis.id, scope) &&
      (input.runId === undefined || analysis.source.runId === input.runId)
    ) {
      output.push(activityForAnalysis(analysis))
    }
  }
  for (const supervisor of state.supervisors) {
    if (
      isInScope(state, 'supervisor', supervisor.id, scope) &&
      (input.runId === undefined || supervisor.rootRunId === input.runId)
    ) {
      output.push(activityForSupervisor(supervisor))
    }
  }
  const supervisorRootRuns = new Map(
    state.supervisors.map((supervisor) => [supervisor.id, supervisor.rootRunId] as const),
  )
  const workers =
    input.limit === undefined ? state.workers : recentWorkersForActivity(state.workers, input.limit)
  for (const worker of workers) {
    const rootRunId = supervisorRootRuns.get(worker.supervisorId)
    if (
      isInScope(state, 'worker', worker.id, scope) &&
      (input.runId === undefined || worker.runId === input.runId || rootRunId === input.runId)
    ) {
      output.push(activityForWorker(worker, rootRunId))
    }
  }
  for (const environment of state.environments) {
    const linkedRuns = state.runs.filter((run) => run.environmentId === environment.id)
    const linkedRun =
      input.runId === undefined
        ? linkedRuns.find((run) => isInScope(state, 'run', run.id, scope))
        : linkedRuns.find((run) => run.id === input.runId)
    if (
      isInScope(state, 'environment', environment.id, scope) &&
      (input.runId === undefined || linkedRun !== undefined)
    ) {
      output.push(activityForEnvironment(environment, linkedRun?.id))
    }
  }
  const insertionOrder = new Map(output.map((item, index) => [item.id, index] as const))
  output.sort((left, right) => compare(left, right, insertionOrder))
  const activity = input.limit === undefined ? output : output.slice(-input.limit)
  return {
    ...(scope.conversationId === undefined ? {} : { conversationId: scope.conversationId }),
    ...(scope.branchId === undefined ? {} : { branchId: scope.branchId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    activity,
  }
}

export type { SemanticNodeType }
