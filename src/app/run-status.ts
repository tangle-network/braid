import type { BraidRun, BraidState, RunStatus } from '../domain/state.js'
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
  const runId = context.currentState().activeRunId
  if (!runId) return structuredClone(context.currentState())
  const control = context.ledger.controlForRun(runId)
  if (control) {
    await control.acknowledgement
    if (!context.currentState().activeRunId) return structuredClone(context.currentState())
  }
  await waitForRun(context, runId)
  return structuredClone(context.currentState())
}
