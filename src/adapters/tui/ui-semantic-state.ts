import type { BraidState } from '../../domain/state.js'

const MAX_RECENT_WORKERS = 2_048
const MAX_WORKERS_WITH_ANCESTORS = 4_096
const MAX_RECENT_SUPERVISORS = 512

export interface UiSemanticState {
  readonly state: BraidState
  readonly hiddenNodeCount: number
}

/** Bounds terminal graph work while the complete semantic query remains available headlessly. */
export function uiSemanticState(state: BraidState): UiSemanticState {
  if (
    state.workers.length <= MAX_RECENT_WORKERS &&
    state.supervisors.length <= MAX_RECENT_SUPERVISORS
  ) {
    return { state, hiddenNodeCount: 0 }
  }

  const workersById = new Map(state.workers.map((worker) => [String(worker.id), worker] as const))
  const workersByRecency = orderedByRecency(state.workers)
  const workerIds = new Set<string>()
  selectRecent(
    workersByRecency,
    workerIds,
    (worker) =>
      worker.status === 'pending' || worker.status === 'running' || worker.status === 'waiting',
    MAX_RECENT_WORKERS,
  )
  selectRecent(workersByRecency, workerIds, () => true, MAX_RECENT_WORKERS)

  for (const selectedId of [...workerIds]) {
    let cursor = workersById.get(selectedId)?.parentWorkerId
    const path = new Set<string>()
    while (cursor !== undefined && workerIds.size < MAX_WORKERS_WITH_ANCESTORS) {
      const id = String(cursor)
      if (path.has(id)) break
      path.add(id)
      workerIds.add(id)
      cursor = workersById.get(id)?.parentWorkerId
    }
  }

  const supervisorIds = new Set<string>()
  for (const workerId of workerIds) {
    const supervisorId = workersById.get(workerId)?.supervisorId
    if (supervisorId !== undefined) supervisorIds.add(String(supervisorId))
  }
  const supervisorsByRecency = orderedByRecency(state.supervisors)
  selectRecent(
    supervisorsByRecency,
    supervisorIds,
    (supervisor) => supervisor.status === 'starting' || supervisor.status === 'running',
    MAX_RECENT_SUPERVISORS,
  )
  selectRecent(supervisorsByRecency, supervisorIds, () => true, MAX_RECENT_SUPERVISORS)

  const workers = state.workers.filter((worker) => workerIds.has(String(worker.id)))
  const supervisors = state.supervisors.filter((supervisor) =>
    supervisorIds.has(String(supervisor.id)),
  )
  const graphNodes = state.graphNodes.filter((node) => {
    if (node.reference.kind === 'worker') return workerIds.has(String(node.reference.id))
    if (node.reference.kind === 'supervisor') {
      return supervisorIds.has(String(node.reference.id))
    }
    return true
  })
  const graphNodeIds = new Set(graphNodes.map((node) => String(node.id)))
  const graphEdges = state.graphEdges.filter(
    (edge) => graphNodeIds.has(String(edge.source)) && graphNodeIds.has(String(edge.destination)),
  )
  return {
    state: { ...state, supervisors, workers, graphNodes, graphEdges },
    hiddenNodeCount:
      state.workers.length - workers.length + state.supervisors.length - supervisors.length,
  }
}

function orderedByRecency<
  T extends { readonly id: string; readonly createdAt: string; readonly updatedAt: string },
>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const updated = Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
    if (updated !== 0) return updated
    const created = Date.parse(left.createdAt) - Date.parse(right.createdAt)
    if (created !== 0) return created
    const leftId = String(left.id)
    const rightId = String(right.id)
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
  })
}

function selectRecent<T extends { readonly id: string }>(
  values: readonly T[],
  selected: Set<string>,
  include: (value: T) => boolean,
  limit: number,
): void {
  for (let index = values.length - 1; index >= 0 && selected.size < limit; index -= 1) {
    const value = values[index]
    if (value === undefined || !include(value)) continue
    selected.add(String(value.id))
  }
}
