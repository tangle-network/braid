import type { BraidState } from '../../domain/state.js'

interface IndexedWorker {
  readonly index: number
  readonly updatedAtMs: number
  readonly worker: BraidState['workers'][number]
}

function compare(left: IndexedWorker, right: IndexedWorker): number {
  const updated = left.updatedAtMs - right.updatedAtMs
  if (Number.isFinite(updated) && updated !== 0) return updated
  return left.index - right.index
}

function swap(values: IndexedWorker[], left: number, right: number): void {
  const value = values[left]
  const replacement = values[right]
  if (value === undefined || replacement === undefined) return
  values[left] = replacement
  values[right] = value
}

function restoreMinimumHeap(values: IndexedWorker[], start: number): void {
  let parent = start
  while (true) {
    const left = parent * 2 + 1
    const right = left + 1
    let smallest = parent
    if (
      left < values.length &&
      compare(values[left] as IndexedWorker, values[smallest] as IndexedWorker) < 0
    ) {
      smallest = left
    }
    if (
      right < values.length &&
      compare(values[right] as IndexedWorker, values[smallest] as IndexedWorker) < 0
    ) {
      smallest = right
    }
    if (smallest === parent) return
    swap(values, parent, smallest)
    parent = smallest
  }
}

function addRecent(values: IndexedWorker[], candidate: IndexedWorker, limit: number): void {
  if (values.length < limit) {
    values.push(candidate)
    let child = values.length - 1
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2)
      if (compare(values[parent] as IndexedWorker, values[child] as IndexedWorker) <= 0) break
      swap(values, parent, child)
      child = parent
    }
    return
  }
  const oldest = values[0]
  if (oldest === undefined || compare(candidate, oldest) <= 0) return
  values[0] = candidate
  restoreMinimumHeap(values, 0)
}

/** Selects the exact recent worker subset without sorting or copying the complete history. */
export function recentWorkersForActivity(
  workers: BraidState['workers'],
  limit: number,
): BraidState['workers'] {
  if (!Number.isSafeInteger(limit) || limit <= 0) return []
  if (workers.length <= limit) return workers
  const recent: IndexedWorker[] = []
  for (let index = 0; index < workers.length; index += 1) {
    const worker = workers[index]
    if (worker === undefined) continue
    addRecent(recent, { index, updatedAtMs: Date.parse(worker.updatedAt), worker }, limit)
  }
  return recent.sort((left, right) => left.index - right.index).map(({ worker }) => worker)
}
