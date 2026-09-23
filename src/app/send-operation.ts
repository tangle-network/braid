import type { BraidState } from '../domain/state.js'
import type { OperationAuthority } from '../domain/operation-authority.js'

export interface SendOperationRecord {
  readonly runId: string
  readonly completion: Promise<void>
}

export function sendOperationForRun(
  authority: OperationAuthority,
  state: BraidState,
  runId: string,
): SendOperationRecord | undefined {
  const run = state.runs.find((candidate) => candidate.id === runId)
  if (!run?.requestDigest) return undefined
  return authority.get<SendOperationRecord>(run.operationId, run.requestDigest)?.value
}
