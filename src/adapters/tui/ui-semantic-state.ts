import type { BraidState } from '../../domain/state.js'

const MAX_RECENT_WORKERS = 2_048
const MAX_WORKERS_WITH_ANCESTORS = 4_096
const MAX_RECENT_SUPERVISORS = 512

export interface UiSemanticState {
  readonly state: BraidState
  readonly hiddenNodeCount: number
}

interface RecentValue {
  readonly index: number
  readonly id: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
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
  const workerIds = new Set<string>()
  selectRecent(
    state.workers,
    workerIds,
    (worker) =>
      worker.status === 'pending' || worker.status === 'running' || worker.status === 'waiting',
    MAX_RECENT_WORKERS,
  )
  selectRecent(state.workers, workerIds, () => true, MAX_RECENT_WORKERS)

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
  selectRecent(
    state.supervisors,
    supervisorIds,
    (supervisor) => supervisor.status === 'starting' || supervisor.status === 'running',
    MAX_RECENT_SUPERVISORS,
  )
  selectRecent(state.supervisors, supervisorIds, () => true, MAX_RECENT_SUPERVISORS)

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

function compareRecent(left: RecentValue, right: RecentValue): number {
  const updated = left.updatedAtMs - right.updatedAtMs
  if (Number.isFinite(updated) && updated !== 0) return updated
  const created = left.createdAtMs - right.createdAtMs
  if (Number.isFinite(created) && created !== 0) return created
  if (left.id !== right.id) return left.id < right.id ? -1 : 1
  return left.index - right.index
}

function swap(values: RecentValue[], left: number, right: number): void {
  const value = values[left]
  const replacement = values[right]
  if (value === undefined || replacement === undefined) return
  values[left] = replacement
  values[right] = value
}

function restoreMinimumHeap(values: RecentValue[], start: number): void {
  let parent = start
  while (true) {
    const left = parent * 2 + 1
    const right = left + 1
    let oldest = parent
    if (
      left < values.length &&
      compareRecent(values[left] as RecentValue, values[oldest] as RecentValue) < 0
    ) {
      oldest = left
    }
    if (
      right < values.length &&
      compareRecent(values[right] as RecentValue, values[oldest] as RecentValue) < 0
    ) {
      oldest = right
    }
    if (oldest === parent) return
    swap(values, parent, oldest)
    parent = oldest
  }
}

function addRecent(values: RecentValue[], candidate: RecentValue, limit: number): void {
  if (values.length < limit) {
    values.push(candidate)
    let child = values.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (compareRecent(values[parent] as RecentValue, values[child] as RecentValue) <= 0) {
        break
      }
      swap(values, parent, child)
      child = parent
    }
    return
  }
  const oldest = values[0]
  if (oldest === undefined || compareRecent(candidate, oldest) <= 0) return
  values[0] = candidate
  restoreMinimumHeap(values, 0)
}

function selectRecent<
  T extends { readonly id: string; readonly createdAt: string; readonly updatedAt: string },
>(
  values: readonly T[],
  selected: Set<string>,
  include: (value: T) => boolean,
  limit: number,
): void {
  const remaining = limit - selected.size
  if (remaining <= 0) return
  const recent: RecentValue[] = []
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === undefined || selected.has(String(value.id)) || !include(value)) continue
    addRecent(
      recent,
      {
        index,
        id: String(value.id),
        createdAtMs: Date.parse(value.createdAt),
        updatedAtMs: Date.parse(value.updatedAt),
      },
      remaining,
    )
  }
  recent.sort((left, right) => compareRecent(right, left))
  for (const candidate of recent) {
    selected.add(candidate.id)
  }
}
