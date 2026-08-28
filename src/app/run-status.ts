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

export async function waitForIdle(context: StatusPort): Promise<BraidState> {
  await Promise.resolve()
  for (;;) {
    const state = context.currentState()
    const runIds = new Set(
      (state.activeRuns ?? [])
        .filter((run) => {
          const record = state.runs.find((candidate) => candidate.id === run.runId)
          return record !== undefined && isLiveRunStatus(record.status)
        })
        .map((run) => run.runId),
    )
    if (runIds.size === 0 && state.activeRunId !== null) runIds.add(state.activeRunId)
    const waits: Promise<unknown>[] = []
    for (const runId of runIds) {
      const control = context.ledger.controlForRun(runId)
      if (control) {
        await control.acknowledgement
        const controlledRun = context.currentState().runs.find((run) => run.id === runId)
        if (controlledRun === undefined || isTerminal(controlledRun.status)) continue
      }
      const operation = context.ledger.operationForRun(runId)
      if (operation) waits.push(operation.completion)
    }
    if (waits.length === 0) return structuredClone(context.currentState())
    await Promise.all(waits)
  }
}
