import type { RunRecord } from '../domain/entities.js'
import type { RetainedExecutionRecoveryContext } from '../ports/execution.js'

/** Snapshot the public run material a provider needs to recover after process loss. */
export function retainedExecutionRecoveryContext(
  run: RunRecord,
  workspaceRoot: string | null,
): RetainedExecutionRecoveryContext {
  return {
    ...(run.retainedAdmission === undefined
      ? {}
      : { retainedAdmission: structuredClone(run.retainedAdmission) }),
    receipt: structuredClone(run.receipt),
    ...(workspaceRoot === null ? {} : { workspaceRoot }),
  }
}
