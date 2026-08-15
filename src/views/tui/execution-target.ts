import type { BraidViewModel, EnvironmentView, GraphNodeType, RunView } from '../shared/models.js'

export interface ExecutionTargetView {
  readonly source: 'profile' | 'run'
  readonly runId?: string
  readonly profileName: string
  readonly profileDigest?: string
  readonly runner: string
  readonly model: string
  readonly effort?: string
  readonly maxOutputTokens?: number
  readonly connection: string
  readonly connectionId?: string
  readonly environment?: EnvironmentView
}

/** Selects one coherent execution identity without combining two profile revisions. */
export function executionTargetFor(
  view: BraidViewModel,
  runId: string | undefined = view.activeRunId,
): ExecutionTargetView {
  const run =
    runId === undefined ? undefined : view.runs.find((candidate) => candidate.id === runId)
  return run === undefined ? profileTarget(view) : runTarget(view, run)
}

/** Resolves the run behind a historical graph or activity entity. */
export function executionTargetForEntity(
  view: BraidViewModel,
  type: GraphNodeType,
  id: string,
): ExecutionTargetView {
  if (type === 'run') return executionTargetFor(view, id)

  const activityRunId = newestActivityRunId(view, type, id)
  if (activityRunId !== undefined) return executionTargetFor(view, activityRunId)

  const matchedRun = newestRun(view.runs, (run) => {
    if (type === 'turn') return run.turnId === id
    if (type === 'branch') return run.branchId === id
    if (type === 'conversation') return run.conversationId === id
    if (type === 'environment') return run.environmentId === id
    return false
  })
  if (matchedRun !== undefined) return executionTargetFor(view, matchedRun.id)

  const graphRunId = graphAncestorRunId(view, `${type}:${id}`)
  return graphRunId === undefined ? executionTargetFor(view) : executionTargetFor(view, graphRunId)
}

function newestActivityRunId(
  view: BraidViewModel,
  type: GraphNodeType,
  id: string,
): string | undefined {
  for (let index = view.activity.length - 1; index >= 0; index -= 1) {
    const item = view.activity[index]
    if (item?.entityType === type && item.entityId === id && item.runId !== undefined) {
      return item.runId
    }
  }
  return undefined
}

function newestRun(
  runs: readonly RunView[],
  matches: (run: RunView) => boolean,
): RunView | undefined {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index]
    if (run !== undefined && matches(run)) return run
  }
  return undefined
}

function graphAncestorRunId(view: BraidViewModel, start: string): string | undefined {
  const nodes = new Map<string, (typeof view.graph)[number]>(
    view.graph.map((node) => [`${node.type}:${node.id}`, node]),
  )
  const queue = [start]
  const seen = new Set<string>()
  while (queue.length > 0 && seen.size < 256) {
    const key = queue.shift()
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    const node = nodes.get(key)
    if (node?.type === 'run') return node.id
    for (const parentId of node?.parentIds ?? []) queue.push(parentId)
  }
  return undefined
}

function profileTarget(view: BraidViewModel): ExecutionTargetView {
  return Object.freeze({
    source: 'profile',
    profileName: view.profileName,
    ...(view.profileDigest === undefined ? {} : { profileDigest: view.profileDigest }),
    runner: view.runner,
    model: view.model,
    ...(view.effort === undefined ? {} : { effort: view.effort }),
    ...(view.maxOutputTokens === undefined ? {} : { maxOutputTokens: view.maxOutputTokens }),
    connection: view.connection,
  })
}

function runTarget(view: BraidViewModel, run: RunView): ExecutionTargetView {
  const environment =
    run.environmentId === undefined
      ? undefined
      : view.environments.find((candidate) => candidate.id === run.environmentId)
  return Object.freeze({
    source: 'run',
    runId: run.id,
    profileName: run.profileName ?? view.profileName,
    ...(run.profileDigest === undefined ? {} : { profileDigest: run.profileDigest }),
    runner: run.runner ?? view.runner,
    model: run.model ?? run.usage?.model ?? view.model,
    ...(run.effort === undefined ? {} : { effort: run.effort }),
    ...(run.maxOutputTokens === undefined ? {} : { maxOutputTokens: run.maxOutputTokens }),
    connection: run.connection ?? run.connectionId ?? 'not connected',
    ...(run.connectionId === undefined ? {} : { connectionId: run.connectionId }),
    ...(environment === undefined ? {} : { environment }),
  })
}
