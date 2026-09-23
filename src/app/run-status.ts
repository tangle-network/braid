import { type BraidRun, type BraidState, isLiveRunStatus, type RunStatus } from '../domain/state.js'
import type { StateReader, StatusPort } from './application-ports.js'
import { AppError } from './errors.js'

export function findRun(context: Pick<StateReader, 'currentState'>, runId: string): BraidRun {
  const run = context.currentState().runs.find((candidate) => candidate.id === runId)
  if (!run) throw new AppError('UNKNOWN_RUN', `Run ${runId} is unknown`)
  return run
}

export function isTerminal(
  status: RunStatus,
): status is Extract<
  RunStatus,
  'completed' | 'failed' | 'aborted' | 'cancelled' | 'blocked' | 'expired' | 'unknown'
> {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'aborted' ||
    status === 'cancelled' ||
    status === 'blocked' ||
    status === 'expired' ||
    status === 'unknown'
  )
}

export async function waitForRun(context: StatusPort, runId: string): Promise<BraidState> {
  const operation = context.ledger.operationForRun(runId)
  if (operation) await operation.completion
  return structuredClone(context.currentState())
}

/**
 * Waits until no live run remains.
 * A detached retained run keeps its remote work but is not live, so it never holds the wait.
 * A live run whose local operation has settled, or that has no operation, can still be
 * advanced by provider reconciliation, so the wait resumes on the next state transition.
 * Every iteration awaits an unsettled operation or a state transition; re-awaiting a settled
 * promise would loop on microtasks and starve timers.
 */
export async function waitForIdle(context: StatusPort): Promise<BraidState> {
  await Promise.resolve()
  const settled = new WeakSet<Promise<unknown>>()
  const observed = new WeakSet<Promise<unknown>>()
  const observe = (completion: Promise<unknown>): void => {
    if (observed.has(completion)) return
    observed.add(completion)
    const markSettled = () => settled.add(completion)
    completion.then(markSettled, markSettled)
  }
  for (;;) {
    const subscription = new AbortController()
    try {
      // Subscribe before reading so a transition during the checks below still wakes the wait.
      const stateChanged = context.nextStateChange(subscription.signal)
      const state = context.currentState()
      const isLive = (runId: string): boolean => {
        const record = state.runs.find((candidate) => candidate.id === runId)
        return record !== undefined && isLiveRunStatus(record.status)
      }
      const runIds = new Set(
        (state.activeRuns ?? []).map((run) => run.runId).filter((runId) => isLive(runId)),
      )
      if (runIds.size === 0 && state.activeRunId !== null && isLive(state.activeRunId))
        runIds.add(state.activeRunId)
      const waits: Promise<unknown>[] = []
      let awaitsStateChange = false
      for (const runId of runIds) {
        const control = context.ledger.controlForRun(runId)
        if (control) {
          await control.acknowledgement
          const controlledRun = context.currentState().runs.find((run) => run.id === runId)
          if (controlledRun === undefined || !isLiveRunStatus(controlledRun.status)) continue
        }
        const operation = context.ledger.operationForRun(runId)
        if (operation === undefined || settled.has(operation.completion)) {
          awaitsStateChange = true
          continue
        }
        observe(operation.completion)
        waits.push(operation.completion)
      }
      if (waits.length === 0 && !awaitsStateChange) {
        // A control acknowledgement can admit another live run; re-evaluate a changed state.
        if (context.currentState().revision !== state.revision) continue
        return structuredClone(context.currentState())
      }
      await Promise.race([...waits, stateChanged])
    } finally {
      // Every exit from this iteration drops its waiter, including an early return.
      subscription.abort()
    }
  }
}
