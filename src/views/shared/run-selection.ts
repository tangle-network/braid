import type { BraidViewModel } from './models.js'

const NON_CANCELLABLE_RUN_STATUSES = new Set<BraidViewModel['runs'][number]['status']>([
  'completed',
  'cancelled',
  'failed',
  'expired',
  'unknown',
])

interface RunSelectionOptions {
  /** Include a retained remote run when its provider exposes remote cancellation. */
  readonly allowDetached?: boolean
}

/** Selects a focused controllable run before the selected branch's active run. */
export function runIdForControl(
  view: Pick<BraidViewModel, 'focusedRunId' | 'activeRunId' | 'runs'>,
  options: RunSelectionOptions = {},
): string | undefined {
  const allowDetached = options.allowDetached === true
  for (const runId of [view.focusedRunId, view.activeRunId]) {
    if (runId === undefined) continue
    const run = view.runs.find((candidate) => candidate.id === runId)
    if (
      run !== undefined &&
      !NON_CANCELLABLE_RUN_STATUSES.has(run.status) &&
      (allowDetached || run.status !== 'detached')
    )
      return runId
  }
  return undefined
}

/** Selects the focused local run before the selected branch's active run. */
export function liveRunId(
  view: Pick<BraidViewModel, 'focusedRunId' | 'activeRunId' | 'runs'>,
): string | undefined {
  return runIdForControl(view)
}
