import { isLiveRunStatus, type BraidRun, type BraidState, type RunStatus } from '../domain/state.js'
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
 * Waits for local run operations to settle.
 * A detached retained run keeps its remote work but has no local operation to wait on.
 * Each completion is awaited once: a settled completion whose run still looks active cannot
 * make further progress, and awaiting it again would spin on microtasks and starve timers.
 */
export async function waitForIdle(context: StatusPort): Promise<BraidState> {
  await Promise.resolve()
  const awaited = new Set<Promise<unknown>>()
  for (;;) {
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
    for (const runId of runIds) {
      const control = context.ledger.controlForRun(runId)
      if (control) {
        await control.acknowledgement
        const controlledRun = context.currentState().runs.find((run) => run.id === runId)
        if (controlledRun === undefined || isTerminal(controlledRun.status)) continue
      }
      const operation = context.ledger.operationForRun(runId)
      if (operation && !awaited.has(operation.completion)) waits.push(operation.completion)
    }
    if (waits.length === 0) return structuredClone(context.currentState())
    for (const wait of waits) awaited.add(wait)
    await Promise.all(waits)
  }
}
